# Ghostly Chess

Chess for two, live in a [Ghostly](https://github.com/MiguelMedeiros/ghostly) chat. Open Chess in a 1:1 chat and your
contact gets a card to join. Moves travel over the chat's live connection, and each side keeps the game for that chat,
so it comes back after a reload.

Chess is a Ghostly mini-app ([WISP 1200](https://github.com/MiguelMedeiros/ghostly/blob/dev/docs/wisps/1200-marketplace.md)):
one self-contained HTML file that runs in the client's sandbox. It has no network, and talks to Ghostly only through
`window.ghostly`, the broker: `apps/1` frames of at most 32 KiB to the same app on the contact's side, and storage per
app and per chat. The UI speaks Ghostly's 8 languages (English in `src/strings.ts`, the others in
`src/languages.ts`; a missing string fails the typecheck).

It used to live in the Ghostly repository at `apps/mini/chess`; its history came along.

## Build

Node 22 or later.

```sh
npm ci
npm run typecheck
npm test          # rules, the protocol, the board, the panel, two sides on a mock broker, and the built bundle
npm run build     # dist/index.html, the whole app in one file
npm run dev       # a dev server; outside Ghostly it plays alone on a stand-in broker that keeps nothing
npm run test:browser   # the built page in Chromium and WebKit (npx playwright install chromium webkit once)
```

`npm run test:browser` drags pieces with a mouse and a finger, taps them, checks the layout from a 320 px phone to a
wide window (Desktop's 560x640 chat-app window included) and that the board keeps its size while a game goes on,
checks a dark high-contrast theme (forced colours, Chromium), and runs the page inside
`<iframe sandbox="allow-scripts">` under a CSP like the web runner's: there it also checks that no AudioContext exists
before a click inside the frame, that it is made and resumed while the frame has a user activation and then runs, that
Copy PGN says Copied only when a copy of the whole PGN worked, and that it leaves the text selected when copying is
refused. Neither Playwright engine enforces the browsers' gesture rule for audio, so that a real browser starts sounds
only after a tap is a hand check. It also checks, in French and Spanish at 320x568 and 375x667, that reviewing a game
below the board keeps one row of controls and no page scroll.

### Checked by hand

Playwright drives no finger drag in WebKit: its WebKit run checks the drag path with synthetic pointer events, and a
real tap, tap. Before a release, check these by hand, and do not sign a version until each is ticked, with the client
versions, in the release's pull request or issue:

- **iOS Safari:** a finger drags a piece to its square, the page does not scroll under the finger, and tap, tap plays
  a move.
- **Desktop's WKWebView (macOS):** the same drag without scrolling, tap, tap or click, click, and the 560x640 chat-app
  window shows the whole board and its controls.
- **Sounds:** after a tap inside the frame, moves (and, in a timed game, the low-time warning) are heard in the web runner (Chromium and Safari) and in Desktop's
  app window (WKWebView); nothing before it. On an iPhone's web app the ring/silent switch mutes Web Audio: a known
  limit, not worked around.
- **Premoves on touch:** on the contact's turn a tap, tap (or a finger drag) queues a premove in blue, and a long
  press on the board drops it (iOS Safari sends no `contextmenu`, so the long press is the board's own timer).
- **Copy PGN:** in the web runner and in Desktop, Copy either copies or leaves the PGN selected with the hint; on an
  iPhone the PGN shows selected, ready to copy with a press and hold.

`npm run digest` prints the built file's SHA-256 in the form a signed bundle lists it. The build is reproducible:
the same commit always gives the same bytes, so a build can be checked against a published version (1.0.2 was
`l5ozbABlwoZn7MBgzaQniVWT4shgPI10A_0Bi-fZENE`, built from the commit that moved Chess here). The bundler is pinned
(`overrides` in `package.json`) so it stays that way; a different `rolldown` minifies differently.

| Path | What it is |
|---|---|
| `src/game.ts` | The game: rules (chess.js), turns, invitations, sync and storage over the broker |
| `src/protocol.ts` | The frames Chess sends (versions 1 and 2), and the checks on what a peer sends (untrusted) |
| `src/clock.ts` | The clocks' pure model: presets, increments, the grace, the checks on a reported time, the claim test |
| `src/negotiate.ts` | Which protocol is spoken with the contact's Chess, decided on each open |
| `src/toss.ts` | Who plays white: a commit and reveal coin toss, and the deals that bind the game id (and the terms) |
| `src/record.ts` | What is kept per chat, and how a Chess 1.0.2 record is read |
| `src/setup.ts` | The new-game panel (time-control presets) and the contact's invitation card |
| `docs/protocol.md` | The protocol, for a bot or another client: both versions, the negotiation, the deals |
| `src/ui.ts`, `src/style.css` | The page: player strips, the panel, the layout; the board themes are CSS tokens |
| `src/board.ts` | The board: squares, highlights, coordinates, orientation, click and drag input, promotion |
| `src/premove.ts` | Premoves: one move queued on the contact's turn, played when its move arrives if still legal |
| `src/pieces.ts`, `src/generated/pieces.ts` | The piece sets: cburnett (SVG, built with `createElementNS`) and Classic (glyphs) |
| `src/prefs.ts`, `src/settings.ts`, `src/dialog.ts` | The settings, per chat, and their dialog |
| `src/announce.ts` | The live region that reads each move aloud, and the game's end |
| `src/panel.ts` | The move list (a button per move), the review bar, the opening, captured pieces, the game-over card, the PGN dialog |
| `src/history.ts` | SAN with move numbers, the position after each ply, captured pieces and the material balance |
| `src/review.ts` | The review cursor the board is drawn from: the live game, or a past position |
| `src/openings.ts`, `src/generated/openings.ts` | The opening's name, looked up by position (FNV-1a of the EPD), up to ply 36 |
| `src/pgn.ts` | The game as PGN |
| `src/names.ts` | Players' names: what is sent and shown, and the initials disc (cleaning is in `src/protocol.ts`) |
| `src/sound.ts` | Sounds synthesized with Web Audio, started by the first click, pointerup or keydown (not Escape or a modifier) |
| `assets/openings/` | The opening names from lichess-org/chess-openings (CC0-1.0), its legal text, and the one-line notice that ships |
| `scripts/openings.mjs` | `npm run gen:openings`: the TSVs as a table of named positions (fails on a hash collision) |
| `assets/pieces/cburnett/` | The 12 piece SVGs from Wikimedia Commons and their BSD-3-Clause license |
| `scripts/pieces.mjs` | `npm run gen:pieces`: the SVGs as data (allowlisted tags and attributes only) |
| `test/browser/` | Playwright specs and their two-page harness with a test broker |
| `src/strings.ts`, `src/languages.ts` | Every string: English, then the 7 other languages |
| `src/vendor/miniApp.ts` | The broker's types and limits, copied from Ghostly's `@ghostly/core/miniApp` (see its header) |
| `test/mockBroker.ts` | A broker with the WISP's rules, for two sides of one chat |
| `test/link.ts` | The same on a virtual clock, with latency, drops, rewrites and held sessions, for the clock tests |
| `test/legacy/1.0.2/` | The Chess 1.0.2 controller, byte for byte, that `test/compat.test.ts` plays against (see its README) |
| `test/browser/fixtures/chess-1.0.2.html` | The published Chess 1.0.2 page, which `test/browser/compat.spec.ts` plays against |
| `test/browser/fixtures/chess-2.2.0.html` | The Chess 2.2.0 page (a build of commit 9d903fef7), the last without names: the same spec checks that it is never sent one |
| `ghostly-app.json` | The manifest, without `publisher`, `sequence` and `files` (the CLI writes those) |
| `app.ghostlyapp` | The signed bundle of the published version, once one is signed from here (see [docs/PUBLISHING.md](docs/PUBLISHING.md)) |
| `scripts/stage.mjs`, `scripts/bundle.mjs` | `npm run stage`: the folder `ghostly app publish` signs. `npm run check:bundle`: whether a signed bundle is this checkout's build, the digest it will have, and the store's listing for it |
| `test/browser/release.spec.ts` | The release smoke: a timed game drawn by agreement, its PGN, a rematch won by checkmate, in the sandboxed frame |
| `CHANGES.md`, `docs/PUBLISHING.md` | What each published version changed, and how a version is published |
| `vite.config.ts` | The single-file build, with the license notices of what it bundles |

## Older versions

Chess 2.0.0 speaks protocol 2 (invitations with terms, and room for clocks, takebacks and rematches) with a contact
on 2.0.0 or later, and Chess 1.0.2's protocol, exactly, with an older one: the toss starts by itself and games are
untimed. Chess 2.1.0 adds the clocks (the `clock` feature): timed games need it on both sides, so a contact on 2.0.0
or 1.0.2 is offered untimed games only, with the update hint. Chess 2.2.0 adds takebacks, rematches with colours
swapped and abort (the `takeback`, `rematch` and `abort` features), draw offers that stand through their own side's
move, and premoves (local, no feature); a contact on 2.1.0 or older sees none of it, and those controls say why. Chess
2.3.0 shows the players' names (the `names` feature): each side sends its own display name in its hello, so it adds
the `name` permission to the manifest, and every installed Chess asks the person before it updates to it (WISP 1200,
Permissions). Someone who declines stays on the version they have, with no later updates: every later Chess asks for
the permission too. That version plays on with 2.3.0 and never receives a name. Names need a Ghostly client that
gives an app its person's name (`context().name`); on one that does not, 2.3.0 says "You" and "Your contact", as
2.2.0 does. A game begun on 1.0.2 goes on after either side updates. `PROTO2_SINCE` in `src/protocol.ts` is the first
version that speaks protocol 2, and `test/version.test.ts` keeps the manifest at or above it. See
[docs/protocol.md](docs/protocol.md).

## Publish a new version

Only the holder of the Chess publisher key can sign an update: Ghostly refuses a bundle signed by another key.
[docs/PUBLISHING.md](docs/PUBLISHING.md) has every step and command: prepare the version, build and stage, sign with
`ghostly app publish`, commit the signed `app.ghostlyapp` at this repository's root, then list it in the store and
sign the store's index. [CHANGES.md](CHANGES.md) says what each published version changed.

`app.ghostlyapp` at the root is the only bundle ever committed here. Never commit the key or a staged folder.

## How it is listed

Chess is in the official [Ghostly store](https://github.com/MiguelMedeiros/ghostly-store) at
`apps/chess.odcgw6wjw8dynqop/listing.json`: its `ref`, the listed version (`sequence` and `digest`), the URLs clients
fetch the bundle from (this repository's, pinned to a commit and at `HEAD`), title and tagline. A Chess installed from
the store updates only to the version the store's signed index lists. Versions up to 1.0.2 were published from the
Ghostly repository, with the bundle in the store.

## License

MIT, see [LICENSE](LICENSE). The built file carries the notices of chess.js (BSD-2-Clause), @noble/hashes (MIT),
the cburnett pieces by Colin M.L. Burnett (BSD-3-Clause, see [assets/pieces/cburnett/LICENSE](assets/pieces/cburnett/LICENSE))
and a credit for the opening names of [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
(CC0-1.0, see [assets/openings/](assets/openings/)). The sounds are synthesized: no audio file, no licence.
