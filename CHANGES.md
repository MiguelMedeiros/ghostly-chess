# Changes

What each published version of Chess changed, newest first. A version is published when its signed bundle,
`app.ghostlyapp`, is committed here and the [Ghostly store](https://github.com/MiguelMedeiros/ghostly-store) lists it
([docs/PUBLISHING.md](docs/PUBLISHING.md)). `sequence` is the number Ghostly orders versions by.

## 2.3.0 (sequence 4)

The first version published from this repository, and the first since 1.0.2. Versions 1.1.0 to 2.2.0 were steps on
the way and were never published: this entry is everything since 1.0.2.

### The board

- Drawn pieces (the cburnett set) on a green board, with coordinates, and the last move, the legal moves and a check
  marked. A second piece set (Classic) and other board colours are in the settings.
- Pieces move by drag and drop, with a mouse or a finger, or by a tap on the piece and a tap on the square. The
  keyboard still plays the whole game.
- A promotion picker over the file, or always a queen (a setting). A Flip button turns the board.
- Settings are kept per chat: board colours, piece set, coordinates, legal moves, sounds, premoves, always a queen.
- The layout fits a 320 px phone, Desktop's 560x640 chat-app window and a wide panel, and the board keeps its size
  while a game goes on.

### The panel

- A move list in SAN with move numbers. Each move is a button: press one to review the game from there, with first,
  back, play, forward and back to live. The contact's moves still arrive while reviewing.
- The opening's name and ECO code, from the position, so transpositions are found.
- The pieces each side took, beside its name, and the lead in material.
- A game-over card with the result and its reason, and Rematch, New game, Copy PGN and Review.
- Copy PGN: the whole game as PGN, with the players, the opening, the time control and each move's clock. It says
  Copied only when the copy worked; otherwise the text stays selected, ready to copy by hand.
- Sounds for moves, captures, checks, castling, promotions, the start and the end, made in the page (no audio file).
  They start after the first tap, and a speaker button mutes them.
- A screen reader hears each move and the end of the game in words.

### Starting a game

- A new-game panel: Unlimited, or a time control. The contact gets an invitation card with the terms, and accepts or
  declines. Who plays white is still tossed by both sides, so neither can choose.
- An invitation or a move made while the contact has Chess closed is kept, and goes when they open it.

### Clocks

- Time controls: 1 min (bullet), 3 min + 2 s and 5 min (blitz), 10 min (rapid), 30 min (classical), or no clock.
- Both clocks show in the players' strips, and the move list shows the time each move took.
- A warning sound and a red clock when time runs low. A side that runs out loses on time, or draws when the other
  side could never mate.
- After a reload or a lost connection the clocks catch up with what both sides agree on.

### During a game

- Offer a draw: the offer stands through your own next move, and one offer per move.
- Takeback: ask to take your last move back; the contact accepts or declines.
- Resign asks first. Before each side has moved, Abort ends the game with no result.
- Rematch from the game-over card: the same time control, colours swapped.
- Premoves: on the contact's turn, queue one move. It is played when theirs arrives, if it is still legal.

### Players

- Each strip shows the player's name as the chat shows it, beside a disc with their initials. Without a name it says
  "You" and "Your contact", as before.
- The PGN's White and Black are the players' names.

### What someone on 1.0.2 should know

- **Chess asks for one more permission, your name.** It reads your display name in the chat to show it to your
  contact, who already sees it in the chat. Ghostly asks before it updates an installed Chess. Someone who declines
  stays on 1.0.2, gets no later version, and can still play with a contact on 2.3.0.
- A game begun on 1.0.2 goes on after either side updates.
- With a contact still on 1.0.2, games are untimed and start by themselves as they did, with no takeback, rematch,
  abort or names, and Chess says the rest comes when the contact updates.

### For developers

- Chess speaks protocol 2 with a contact on Chess 2.0.0 or later, and the protocol of 1.0.2, exactly, with an older
  one. Which is spoken is decided on each open. [docs/protocol.md](docs/protocol.md) describes both, for a bot or
  another client.
- The signed bundle is now published from this repository (`app.ghostlyapp` at the root), and the manifest's `sources`
  names it. The store keeps the listing only.
- The page is one HTML file of 260,648 bytes, under its 256 KiB budget.

### Known limits

- The contact's name is not kept with the game: after a reload with the contact away the strip says "Your contact"
  and the PGN has `?` until they open Chess again.
- Zero-width joiners are removed from names with the other invisible characters, so a few names join differently and
  a joined emoji falls apart.
- The invitation card says "Your contact invites you", without the name.
- On an iPhone's web app the ring/silent switch mutes the sounds.

## 1.0.2 (sequence 3)

Fixes after 1.0.1. Published from the Ghostly repository (`apps/mini/chess`), with the bundle in the store.

## 1.0.1 (sequence 2)

Moves are sent and kept, and the second side to open no longer waits.

## 1.0.0 (sequence 1)

The first Chess: a game with a contact in a 1:1 chat, colours tossed by both sides, kept per chat.
