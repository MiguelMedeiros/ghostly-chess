# The Chess protocol

How two Chess apps talk, for anyone writing a bot or another client. Chess is a Ghostly mini-app (WISP 1200): the
only way to the contact's Chess is `ghostly.chat.send`, one `apps/1` data frame per call, live only (the frame is
refused when the contact's Chess is closed), at most 32 KiB. Chess keeps each frame to 16 KiB or less.

The code is `src/protocol.ts` (frames and their bounds), `src/negotiate.ts` (which version is spoken),
`src/toss.ts` (the deals) and `src/game.ts` (what each frame does).

## Frames

Every frame is a JSON object `{"p": "chess", "v": <version>, "k": <kind>, ...}`. A receiver checks the size first,
then every field's type, shape and range, and refuses a frame whole when one is wrong. Fields it does not know are
ignored. A frame with `v` above the receiver's newest version gives a "newer version" notice.

Shared shapes:

| Name | Shape |
|---|---|
| salt | 32 random bytes as 64 lowercase hex digits |
| commitment | SHA-256(`"ghostly-chess/1 commit"`, 0x00, salt), 64 lowercase hex digits |
| game id `g` | 16 lowercase hex digits (8 bytes) |
| ply | a move in UCI: `e2e4`, `e7e8q` |
| colour | `"w"` or `"b"` |
| ply count `n` | an integer, 0 to 2000 (a game ends drawn at 2000 plies) |

### Version 1 (Chess 1.0.2)

| Kind | Fields | Meaning |
|---|---|---|
| `seek` | `c`, `a` | A coin toss: `c` is my commitment; `a` lists up to 2 game ids I give up |
| `reveal` | `s`, `c` | My salt, answering the commitment `c` of the peer |
| `move` | `g`, `n`, `m` | Ply number `n` (0-based) of game `g` |
| `sync` | `g`, `s`, `m`, `x?` | Catch-up: `s` = [sender's salt, receiver's salt], `m` = every ply joined by spaces, `x` = how it ended off the board |
| `resign` | `g` | The sender resigns |
| `draw` | `g`, `o` | `o` = `"offer"`, `"accept"` or `"decline"` |

Ends (`x`): `{"why": "resign", "by": colour}` and `{"why": "agreed"}`.

A version 1 frame carries exactly these keys. Chess 1.0.2 ignores fields it does not know, so a version 2 field in a
version 1 frame would be silently dropped there (a seek with a time control would start an untimed game).

### Version 2

Version 2 keeps every kind above, and adds fields and kinds:

| Kind | Fields | Meaning |
|---|---|---|
| `hello` (new) | `pv`, `f`, `n?`, `re?` | `pv` = 2, the protocol the sender speaks; `f` = its features (at most 16 names of `[a-z-]`, 16 characters or fewer); `n` = its display name, 48 code points or fewer; `re` = 1 when the hello answers one (any other value refuses the frame) |
| `seek` | `c`, `a`, `tc?`, `r?` | An invitation with its terms: `tc` = [base s, increment s], base 15 to 10800, increment 0 to 60, absent for unlimited; `r` = the game this is a rematch of |
| `decline` (new) | `c` | Declines the invitation whose commitment is `c` |
| `reveal` | `s`, `c` | Unchanged |
| `move` | `g`, `n`, `m`, `t?` | `t` = the mover's remaining ms after ply `n`, increment included (0 to 2^31-1); in timed games from ply 2 on |
| `ack` (new) | `g`, `n` | "I hold `n` plies" |
| `flag` (new) | `g`, `n`, `by` | Colour `by` ran out of time with `n` plies on the board: a self-report when `by` is the sender, a claim otherwise |
| `dispute` (new) | `g`, `n` | The claimed side's clock disagrees with the claim at `n` |
| `sync` | `g`, `s`, `m`, `x?`, `tc?`, `r?`, `c?`, `tb?`, `d?` | Adds the terms (to re-derive the id), `c` = [white ms, black ms] after the last ply, `tb` = the takeback epoch, `d` = [colour, n], the standing draw offer and the ply it stands for |
| `resign` | `g` | Unchanged |
| `draw` | `g`, `o`, `n` | `n` = the ply count the offer stands for (required) |
| `takeback` (new) | `g`, `n`, `o` | `o` = `"ask"`, `"accept"` or `"decline"`; `n` = the ply count after undoing the asker's last move |

Ends add `{"why": "time", "by": colour}`, `{"why": "aborted"}` (only before ply 2) and `{"why": "disputed"}` (no
result).

Every 2.x reads every 2.x frame. What a side does with them is gated by the features both hellos name: `clock`,
`takeback`, `rematch`, `abort` and `names`. A build names only what it implements (2.0.0 names none yet), so a later
Chess never sends it a clock or a takeback it cannot run. The gate holds on receipt too: an invitation with `tc`
without `clock` named by both, or with `r` without `rematch`, is shown but cannot be accepted (Accept is off, with
the reason), and a sync's `time` end needs `clock`, its `aborted` end `abort`.

The longest version 2 sync (2000 plies, clocks and terms) is about 12 KiB (12,325 bytes).

## Which version is spoken

The client tells each side the contact's Chess version: `context().peer.version` when Chess starts, and
`chat.peer {open, version}` on each open. The mode is decided on each open, on evidence:

1. The contact's version below 2.0.0 (semver; a prerelease is below its release), unparseable or missing: version 1
   at once. This side sends exactly Chess 1.0.2's opening and never a version 2 frame.
2. 2.0.0 or later: this side sends `hello` first and holds every game frame until the contact's `hello`. Then each
   side sends its opening: its game as a `sync`, and its open invitation as a `seek`.
3. If a version 1 frame arrives instead of a hello, the contact speaks version 1 after all: this side switches, sends
   1.0.2's opening, then handles that frame.
4. Replies are explicit. A `hello` sent in answer carries `re: 1`. A `hello` without it is always answered, in any
   mode, with a `hello` with it and the opening, at most once a second (one asked for sooner goes when the second is
   up). A `hello` with `re` is never answered. Either kind moves version 1 (the version was misread) or the wait for
   the contact's hello to version 2. So a side that opened again, even unseen by the other (a reload), always gets an
   answer, and two hellos never answer each other forever.
5. While a side waits for the contact's `hello` with the contact open, it sends its own again every 3 seconds.

No frame nudges a version 1 contact to update: Ghostly checks for app updates itself (at start, every 24 hours and
on the Apps page), and a version 2 frame makes 1.0.2 say "Update to keep playing" although play goes on. Chess shows
the person "Your contact has Chess 1.0.2. Clocks, takebacks and rematches come when they update." instead.

1.0.2's opening, which version 1 mode repeats on every open: the seek of the toss going, else a `sync` of the game,
else a new toss (a `seek` with a fresh salt).

## The toss

Neither side picks its colour:

1. Each side draws a secret salt and sends only its commitment, in a `seek`.
2. A side reveals its salt only once it holds the other's commitment, so the other salt is fixed before it can be
   seen. A side answering a seek sends its own seek again before its reveal, since the other side can check a reveal
   only against a commitment it has.
3. Both compute the deal from the two salts. A side that walks away after seeing the result and seeks again gets a
   fresh salt from the other side, never a known one, and the person sees that the toss restarted.

In version 1 the toss starts by itself as both open. In version 2 a seek is an invitation: the other side shows
"Your contact invites you: Unlimited" with Accept and Decline. Accept sends its own `seek` with the same terms and the
`reveal`; Decline sends `decline`. Seeks with different terms never complete; each side shows only the contact's
latest one. An invitation made while the contact is away is kept and sent when they open Chess. In version 2, a
version 1 `seek` (the contact's toss from before it read this side's hello) is taken only as the answer to an
unlimited invitation of this side's whose toss is not under way, and that toss is then for deal 1.

Each toss is for one deal, kept with it (`dv` in the `flip` record): the deal of the envelope its seek goes in, until
the contact's commitment is held, and fixed from then on. A side answering a seek takes the deal of the seek's
envelope. A `reveal`, and a `sync` that completes the toss, are placed only by that deal, whatever envelope they come
in, so a side that has seen the other's salt cannot pick the better of the two deals for the same salts.

### The deals

- Version 1: `D = SHA-256("ghostly-chess/1 deal", 0x00, low salt, high salt)`, where the low salt is the one whose
  commitment sorts first.
- Version 2: `D = SHA-256("ghostly-chess/2 deal", 0x00, low salt, high salt, terms)`, with terms the UTF-8 text
  `tc=<base>+<inc>;r=<game id>`, writing `-` for an absent part (an unlimited new game is `tc=-;r=-`).

In both, the game id is `D[0..8]` in hex. Colours: in a rematch (`r`), each side takes the opposite of its colour in
game `r`; otherwise the side with the low salt plays white when the low bit of `D[8]` is 0.

Because the terms are bound into the id, two sides that disagree on them (a misread version, a forged sync) end
"out of step", never in a timed game on one side and an untimed one on the other.

The mode never changes a game's deal. A game begun on 1.0.2 (deal 1) goes on untimed in either envelope; a deal 2
game takes only version 2 frames, and a version 1 frame naming it is out of step. The toss decides which deal places
a `sync`: for this side's game, the game's deal; to complete a toss, the deal that toss is for (a `sync` naming the
other deal of the same salts is a bad message and starts nothing). Deal 1 needs a `sync` with no terms; deal 2 never
comes in a version 1 frame.

## Play

- A `move` is taken when it names this side's game and the next ply number, it is the sender's turn, and it is legal.
  A `move` with an old `n` and the same ply is a repeat and changes nothing. Anything else is reported and answered
  with this side's state (at most once a second), so an honest peer that fell out of step catches up.
- A move may be made while the contact's Chess is closed. Frames stay live-only: the move is kept by its own side and
  travels in the `sync` sent when the contact opens Chess.
- A `sync` is taken only as far as it is provable: the same game and salts (one of them this side's own), and a
  history that is this side's plus at most one legal ply of the sender's. Anything longer or different is "out of
  step", and a new game gives up both: the side out of step keeps the contact's game id until a new game begins, so
  its next `seek` names both in `a`.
- A resignation and a move made while the contact was away: when a `sync` with the sender's resignation is one ply
  short of this side's history and that ply is this side's own (the sender never saw it), the ply is dropped, since
  the game ended before it, and this side sends the matching `sync`. The resigner, holding its own end, keeps its
  history when a `sync` is its own plus one ply with no end (or the same end), and answers a `sync` with no end with
  its own.
- Every `draw`, `takeback`, `ack`, `flag` and `dispute` names the ply count `n` it is about. One whose `g` or `n`
  differs from this side's game is ignored.
- A `sync`'s end `x` is taken only when this side could have reached it:
  - `resign` by the sender;
  - `agreed` when this side's own offer stood at that ply;
  - `time` with the sender out of time, with `clock` named by both (this side out of time only through a claim it
    accepted, which already ended the game here);
  - `aborted` only before ply 2, with `abort` named by both;
  - `disputed` only when this side sent or received a claim at that ply.

  Anything else is a bad message and changes nothing.

The clock rules (`t`, `ack`, `flag`, `dispute`, `c`) and takebacks and rematches (`takeback`, `tb`, `r`) come with
the features that use them.

## Storage

Per chat, in the broker's storage:

| Key | Value |
|---|---|
| `game` | `{v: 2, g, me, s, dv, sd?, tc?, r?, m, k?, tw?, ts?, x?, d?, dn?, tb?, q?, pc?, fl?}`: `dv` is the deal (1 or 2). A 1.0.2 record (`v: 1`) reads as `dv: 1`, untimed, same game id |
| `flip` | `{v: 2, salt, dv, peer?, a, tc?, r?}`: the toss going, the deal it is for and the invitation's terms, so a reload sends the same seek. A 1.0.2 record (`v: 1`) reads as `dv: 1` |
| `prev` | `{g, me, tc?}`: the last finished game, for a rematch's colours |
| `prefs` | The settings |
