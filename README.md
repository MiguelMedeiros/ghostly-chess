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
npm test          # rules, the protocol, the board, two sides on a mock broker, and the built bundle
npm run build     # dist/index.html, the whole app in one file
npm run dev       # a dev server; outside Ghostly it plays alone on a stand-in broker that keeps nothing
```

`npm run digest` prints the built file's SHA-256 in the form a signed bundle lists it. The build is reproducible:
at this commit it gives the same bytes as the published 1.0.2 (`l5ozbABlwoZn7MBgzaQniVWT4shgPI10A_0Bi-fZENE`). The
bundler is pinned (`overrides` in `package.json`) so it stays that way; a different `rolldown` minifies differently.

| Path | What it is |
|---|---|
| `src/game.ts` | The game: rules (chess.js), turns, sync and storage over the broker |
| `src/protocol.ts` | The frames Chess sends, and the checks on what a peer sends (untrusted) |
| `src/toss.ts` | Who plays white: a commit and reveal coin toss |
| `src/ui.ts`, `src/style.css` | The board and the panel |
| `src/strings.ts`, `src/languages.ts` | Every string: English, then the 7 other languages |
| `src/vendor/miniApp.ts` | The broker's types and limits, copied from Ghostly's `@ghostly/core/miniApp` (see its header) |
| `test/mockBroker.ts` | A broker with the WISP's rules, for two sides of one chat |
| `ghostly-app.json` | The manifest, without `publisher`, `sequence` and `files` (the CLI writes those) |
| `vite.config.ts` | The single-file build, with the license notices of what it bundles |

## Publish a new version

Only the holder of the Chess publisher key can sign an update: the store refuses a bundle signed by another key.

1. Raise `version` in `ghostly-app.json` and `package.json`.
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

MIT, see [LICENSE](LICENSE). The built file carries the notices of chess.js (BSD-2-Clause) and @noble/hashes (MIT).
