# Chess 1.0.2, frozen

These files are byte-identical copies of the controller Chess 1.0.2 shipped with: `game.ts`, `protocol.ts`, `toss.ts`
and `vendor/miniApp.ts`. The compatibility tests (`test/compat.test.ts`) run this real 1.0.2 controller on the mock
broker against today's, so "works with 1.0.2" is checked against 1.0.2 itself and not against a description of it.

Where they come from:

- The published Chess 1.0.2 page has the SHA-256 `l5ozbABlwoZn7MBgzaQniVWT4shgPI10A_0Bi-fZENE` (base64url, as a
  signed bundle's manifest lists it). `test/browser/fixtures/chess-1.0.2.html` is that page, checked against that
  digest by `test/legacy.test.ts`.
- The commit that moved Chess into this repository, `5add960` ("Chess stands on its own"), builds that exact page.
  These four files are `src/game.ts`, `src/protocol.ts`, `src/toss.ts` and `src/vendor/miniApp.ts` at that commit.
  If the history is ever rewritten, the page digest above is the anchor: rebuild a candidate commit and compare.

They carry no header saying so, since a header would be an edit. `test/legacy.test.ts` pins each file's SHA-256, so
an edit, a formatter run or a line-ending change fails the tests. Never change them; if 1.0.2 has to be studied
further, read them here or at `5add960`.

chess.js stays pinned at 1.4.0 in `package.json`, so the frozen controller runs on the rules it shipped with.
