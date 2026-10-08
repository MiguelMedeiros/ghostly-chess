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
- **Sounds:** after a tap inside the frame, moves are heard in the web runner (Chromium and Safari) and in Desktop's
  app window (WKWebView); nothing before it. On an iPhone's web app the ring/silent switch mutes Web Audio: a known
  limit, not worked around.
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
| `src/negotiate.ts` | Which protocol is spoken with the contact's Chess, decided on each open |
| `src/toss.ts` | Who plays white: a commit and reveal coin toss, and the deals that bind the game id (and the terms) |
| `src/record.ts` | What is kept per chat, and how a Chess 1.0.2 record is read |
| `src/setup.ts` | The new-game panel (time-control presets) and the contact's invitation card |
| `docs/protocol.md` | The protocol, for a bot or another client: both versions, the negotiation, the deals |
| `src/ui.ts`, `src/style.css` | The page: player strips, the panel, the layout; the board themes are CSS tokens |
| `src/board.ts` | The board: squares, highlights, coordinates, orientation, click and drag input, promotion |
| `src/pieces.ts`, `src/generated/pieces.ts` | The piece sets: cburnett (SVG, built with `createElementNS`) and Classic (glyphs) |
| `src/prefs.ts`, `src/settings.ts`, `src/dialog.ts` | The settings, per chat, and their dialog |
| `src/announce.ts` | The live region that reads each move aloud, and the game's end |
| `src/panel.ts` | The move list (a button per move), the review bar, the opening, captured pieces, the game-over card, the PGN dialog |
| `src/history.ts` | SAN with move numbers, the position after each ply, captured pieces and the material balance |
| `src/review.ts` | The review cursor the board is drawn from: the live game, or a past position |
| `src/openings.ts`, `src/generated/openings.ts` | The opening's name, looked up by position (FNV-1a of the EPD), up to ply 36 |
| `src/pgn.ts` | The game as PGN |
| `src/sound.ts` | Sounds synthesized with Web Audio, started by the first click, pointerup or keydown (not Escape or a modifier) |
| `assets/openings/` | The opening names from lichess-org/chess-openings (CC0-1.0), its legal text, and the one-line notice that ships |
| `scripts/openings.mjs` | `npm run gen:openings`: the TSVs as a table of named positions (fails on a hash collision) |
| `assets/pieces/cburnett/` | The 12 piece SVGs from Wikimedia Commons and their BSD-3-Clause license |
| `scripts/pieces.mjs` | `npm run gen:pieces`: the SVGs as data (allowlisted tags and attributes only) |
| `test/browser/` | Playwright specs and their two-page harness with a test broker |
| `src/strings.ts`, `src/languages.ts` | Every string: English, then the 7 other languages |
| `src/vendor/miniApp.ts` | The broker's types and limits, copied from Ghostly's `@ghostly/core/miniApp` (see its header) |
| `test/mockBroker.ts` | A broker with the WISP's rules, for two sides of one chat |
| `test/legacy/1.0.2/` | The Chess 1.0.2 controller, byte for byte, that `test/compat.test.ts` plays against (see its README) |
| `test/browser/fixtures/chess-1.0.2.html` | The published Chess 1.0.2 page, which `test/browser/compat.spec.ts` plays against |
| `ghostly-app.json` | The manifest, without `publisher`, `sequence` and `files` (the CLI writes those) |
| `vite.config.ts` | The single-file build, with the license notices of what it bundles |

## Older versions

Chess 2.0.0 speaks protocol 2 (invitations with terms, and room for clocks, takebacks and rematches) with a contact
on 2.0.0 or later, and Chess 1.0.2's protocol, exactly, with an older one: the toss starts by itself and games are
untimed. A game begun on 1.0.2 goes on after either side updates. `PROTO2_SINCE` in `src/protocol.ts` is the first
version that speaks protocol 2, and `test/version.test.ts` keeps the manifest at or above it. See
[docs/protocol.md](docs/protocol.md).

## Publish a new version

Only the holder of the Chess publisher key can sign an update: the store refuses a bundle signed by another key.

1. Tick every item of [Checked by hand](#checked-by-hand) for this version. Then raise `version` in
   `ghostly-app.json` and `package.json`.
2. Build and stage the folder to sign. `ghostly app publish` takes every file in the folder it is given, so stage it
   rather than pointing it at the repository:

   ```sh
   npm ci && npm test && npm run build
   npm run stage              # release/index.html + release/ghostly-app.json, with `sources` set to the store's URL
   ```

3. Sign it with the [Ghostly CLI](https://github.com/MiguelMedeiros/ghostly/tree/dev/packages/cli), over the bundle in
   a clone of [ghostly-store](https://github.com/MiguelMedeiros/ghostly-store), which raises `sequence`:

   ```sh
   ghostly app publish release --key ~/ghostly-keys/chess-publisher.key \
     --out <ghostly-store>/apps/chess.odcgw6wjw8dynqop/app.ghostlyapp
   ghostly app verify <ghostly-store>/apps/chess.odcgw6wjw8dynqop/app.ghostlyapp
   ```

   Never commit the key, a staged folder or a bundle here.

## How it is listed

Chess is in the official [Ghostly store](https://github.com/MiguelMedeiros/ghostly-store) at
`apps/chess.odcgw6wjw8dynqop/`: the signed `app.ghostlyapp` and a `listing.json` (`ref`, `sequence`, `digest`, the URL
clients fetch, title and tagline). After a new bundle, update `sequence` and `digest` in `listing.json` to what
`ghostly app verify` prints, and sign the store's index again (see the store's README). Clients see the update on their
next index refresh.

## License

MIT, see [LICENSE](LICENSE). The built file carries the notices of chess.js (BSD-2-Clause), @noble/hashes (MIT),
the cburnett pieces by Colin M.L. Burnett (BSD-3-Clause, see [assets/pieces/cburnett/LICENSE](assets/pieces/cburnett/LICENSE))
and a credit for the opening names of [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
(CC0-1.0, see [assets/openings/](assets/openings/)). The sounds are synthesized: no audio file, no licence.
