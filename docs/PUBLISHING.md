# Publishing a version of Chess

A version of Chess is published in three places, in this order:

1. **This repository** holds the signed bundle, `app.ghostlyapp`, at its root. The manifest's `sources` names it.
2. **The Ghostly store** ([ghostly-store](https://github.com/MiguelMedeiros/ghostly-store)) holds Chess's
   `listing.json`: the version (`sequence` and `digest`) and the URLs clients fetch it from.
3. **The store's signed index** names that listing. A Chess installed from the store updates only to the version
   the signed index lists (WISP 1200, Updates and rollback), so nothing reaches people before step 3.

Only the holder of the Chess publisher key can sign a version: Ghostly refuses an update signed by another key. The
key is never in this repository, in a pull request, in CI or in a chat. Everything up to "Sign" can be done by anyone
and is checked by CI; "Sign" and the store's index are the owner's steps.

| | |
|---|---|
| Chess's reference | `odcgw6wjw8dynqop84r47jbjcdqossbgrfiejd367e14hgxmjcho/chess` |
| Publisher key file (owner's machine only) | `~/ghostly-keys/chess-publisher.key` |
| Store folder | `apps/chess.odcgw6wjw8dynqop/` |
| Published so far | 1.0.0 (sequence 1), 1.0.1 (2), 1.0.2 (3). See [CHANGES.md](../CHANGES.md) |

## 1. Prepare the version (a pull request)

1. Raise `version` in `ghostly-app.json`, `package.json` and `package-lock.json` (`npm version <x.y.z>
   --no-git-tag-version` does the last two; `test/version.test.ts` fails when the three differ). Write
   `releaseNotes` in `ghostly-app.json`: one line, at most 500 characters, shown with the update.
2. Add the version to [CHANGES.md](../CHANGES.md).
3. Run everything, the release smoke included (`test/browser/release.spec.ts`: two sides in the runner's sandboxed
   frame play a timed game to a draw by agreement, copy its PGN, and play a rematch to checkmate):

   ```sh
   npm ci
   npm run typecheck
   npm test
   npx playwright install chromium webkit   # once
   npm run test:browser
   ```

4. Tick every item of the README's [Checked by hand](../README.md#checked-by-hand), with the client versions, in the
   pull request. Playwright cannot check them, and a version is not signed until each is ticked.
5. Merge it. The commit on `main` is the one that is built and signed.

## 2. Build and stage

On the commit to publish, with a clean tree:

```sh
git switch main && git pull && git status --short     # nothing listed
npm ci && npm test && npm run build
npm run digest                    # the page's size and SHA-256
npm run check:bundle -- --expect 4    # the digest the signed bundle will have under sequence 4
npm run stage                     # release/index.html + release/ghostly-app.json
```

The build is reproducible: the same commit gives the same bytes on any machine, so the digest `npm run digest`
prints is the one CI printed for that commit (the "Typecheck, test, build" job's summary, and its `chess-index-html`
artifact). If they differ, stop: do not sign a page that is not the reviewed one.

`ghostly app publish` takes every file in the folder it is given, so it is run on `release/`, never on the
repository. `release/` is ignored by git.

## 3. Sign (the owner)

The Ghostly CLI is built from a checkout of [Ghostly](https://github.com/MiguelMedeiros/ghostly)'s `dev` (the CLI on
npm, 1.1.x, has no `app` commands). It must be recent enough to know the manifest's `view`: an older build refuses
the manifest with `unknown-key: view`.

```sh
# Once, then `git -C ~/code/ghostly-cli pull` and the two npm commands again before a release.
git clone --branch dev https://github.com/MiguelMedeiros/ghostly ~/code/ghostly-cli
(cd ~/code/ghostly-cli && npm ci && npm run build -w @ghostlytools/cli)
ghostly() { node ~/code/ghostly-cli/packages/cli/dist/ghostly.mjs "$@"; }
```

Sign the staged folder into the repository's root. `--sequence` is one more than the published version's (3 for
Chess 1.0.2, so 4 for the first version signed here). Once `app.ghostlyapp` is committed here, later versions leave
`--sequence` out: `publish` reads the bundle at `--out` and raises its sequence by one, and refuses when the key is
not the one that signed it.

```sh
ghostly app publish release --key ~/ghostly-keys/chess-publisher.key --out app.ghostlyapp --sequence 4 --pretty
ghostly app verify app.ghostlyapp --pretty
npm run check:bundle
```

Check, before going on:

- `ghostly app verify` says `"valid": true`, `"ref": "odcgw6wjw8dynqop84r47jbjcdqossbgrfiejd367e14hgxmjcho/chess"`,
  the version, and `"sequence": 4`. Its `"digest"` is the one `npm run check:bundle -- --expect 4` printed in step 2.
- `npm run check:bundle` says the bundle is this checkout's build under the Chess publisher key: its one file is
  `dist/index.html` byte for byte, and its manifest says what `ghostly-app.json` says. It does not check the
  signature; `ghostly app verify` did.
- `publish` did not say `"keyCreated": true`. If it did, the key file's path was wrong and a new key was made:
  delete that new file and the bundle, and sign again with the right path.

A sequence is never signed twice. If a signed bundle is wrong and was already pushed, publish the fix as the next
sequence; two bundles under one sequence make Ghostly keep the one it has and refuse the other.

## 4. Commit the bundle here

The bundle goes in a commit of its own, straight after the commit it was built from, so the store can pin that
commit:

```sh
git add app.ghostlyapp
git commit -m "Chess 2.3.0 (sequence 4)"
git push origin main
npm run check:bundle -- --listing     # prints the store's listing.json, pinned to that commit
```

`.gitignore` lets in `app.ghostlyapp` at the root only. Never commit `release/`, another bundle or a key. If `main`
takes pull requests only, push the commit on a branch and merge it with a merge commit or a rebase (not a squash
that adds other changes): the listing pins the commit on `main` that holds the bundle, so run `--listing` again on
`main` after the merge.

Once it is pushed, both URLs of the listing answer (`raw.githubusercontent.com` caches `HEAD` for 5 minutes):

```sh
ghostly app verify https://raw.githubusercontent.com/MiguelMedeiros/ghostly-chess/HEAD/app.ghostlyapp
ghostly app verify https://cdn.jsdelivr.net/gh/MiguelMedeiros/ghostly-chess@<the commit>/app.ghostlyapp
```

## 5. List it in the store, and sign the index (the owner)

In a clone of [ghostly-store](https://github.com/MiguelMedeiros/ghostly-store), on a branch:

1. Replace `apps/chess.odcgw6wjw8dynqop/listing.json` with what `npm run check:bundle -- --listing` printed:

   ```json
   {
     "ref": "odcgw6wjw8dynqop84r47jbjcdqossbgrfiejd367e14hgxmjcho/chess",
     "sequence": 4,
     "digest": "<the digest ghostly app verify printed>",
     "urls": [
       "https://cdn.jsdelivr.net/gh/MiguelMedeiros/ghostly-chess@<the 40-character commit that added app.ghostlyapp>/app.ghostlyapp",
       "https://raw.githubusercontent.com/MiguelMedeiros/ghostly-chess/HEAD/app.ghostlyapp"
     ],
     "title": "Chess",
     "tagline": "Play chess with a contact, live in your chat",
     "category": "Games",
     "developer": "Ghostly",
     "submitter": "Ghostly",
     "repo": "https://github.com/MiguelMedeiros/ghostly-chess",
     "support": "https://github.com/MiguelMedeiros/ghostly-chess/issues"
   }
   ```

   The jsDelivr URL is first and names a full commit: it never changes, and it is what a new install fetches. The
   `HEAD` URL may move on to a later version; a client skips a bundle whose digest is not the listed one.

2. The first time only (moving from the store's own copy to this repository): `git rm
   apps/chess.odcgw6wjw8dynqop/app.ghostlyapp`. The store's check refuses a bundle in the folder that no URL of the
   listing names. Until 1.0.2, the bundle lived there and Chess 1.0.2's `sources` names that path: a Chess 1.0.2
   installed by URL or from a chat card (not from the store) looks for updates there, and no longer finds one. To
   keep those installs updating for one more version, keep the file instead, copy the new `app.ghostlyapp` over it
   and add `https://raw.githubusercontent.com/MiguelMedeiros/ghostly-store/HEAD/apps/chess.odcgw6wjw8dynqop/app.ghostlyapp`
   as a third URL.

3. If the store's `GHOSTLY_COMMIT` is older than the Ghostly that reads `view`, the check refuses the bundle
   (`unknown-key: view`). Raise it to the commit the CLI was built from, in the same pull request:

   ```sh
   git -C ~/code/ghostly-cli rev-parse HEAD > GHOSTLY_COMMIT
   ```

4. Build and sign the index, **in the same pull request as the listing**. The signed index is what clients read:
   while it still lists the old version at a URL the pull request removed, nobody can install Chess.

   ```sh
   npm ci
   npm run build-index -- --out /tmp/ghostly-store.draft.json
   ghostly store sign /tmp/ghostly-store.draft.json --key ~/ghostly-keys/store.key --out .
   GHOSTLY=~/code/ghostly-cli scripts/check.sh        # "The store is valid."
   git add apps/chess.odcgw6wjw8dynqop ghostly-store.json ghostly-store.sig GHOSTLY_COMMIT
   git commit -m "Chess 2.3.0 (sequence 4), published from ghostly-chess"
   ```

5. Open the pull request. Its check fetches both URLs, verifies the bundle as a client does and compares its
   `sequence` and `digest` with the listing. Merge when it is green.

## 6. After

- In a Ghostly with Chess installed from the store, the update shows after its next read of the store's index. A
  version that adds a permission, as 2.3.0 adds `name`, waits for the person: Ghostly asks before it updates.
- Add the bundle's digest and the commit to the release's pull request or issue, with the hand checks.

## What can go wrong

| What happens | Why, and what to do |
|---|---|
| `publish` says `unknown-key: view` | The CLI is older than `view`. Pull and build `~/code/ghostly-cli` again |
| `publish` says the key file may be read by others | `chmod 600 ~/ghostly-keys/chess-publisher.key` |
| `publish` says `--sequence 4 is not higher than` | `app.ghostlyapp` is already at that sequence: it was signed. Leave `--sequence` out for the next version |
| `publish` says `signed by another key` | The key is not Chess's. Nothing was written. Use the Chess publisher key |
| `check:bundle` says `is not this build's` | The tree changed between `npm run build` and `publish`, or `release/` was stale. While nothing was pushed: delete `app.ghostlyapp` (or `git checkout app.ghostlyapp` when an earlier version is committed), then build, stage and sign again |
| `check:bundle` says `signed for another publisher key` | The wrong key signed it. Delete the bundle, and sign with the Chess key |
| The store's check says `answered 404` | The bundle's commit is not on `main` here yet, or the commit in the jsDelivr URL is not the one that holds it |
| The store's check says `is pinned and holds sequence` | The jsDelivr URL names a commit with an older bundle. Use the commit `check:bundle -- --listing` printed |
| The store's check says `rollback` or `equivocation` for the index | Build the index again (`build-index` raises its sequence) and sign it |

## Revoking a version

If a version is harmful, or the key leaked: `ghostly app revoke . --key ~/ghostly-keys/chess-publisher.key --up-to
<sequence>` (or `--digest <digest>`) writes `ghostly-revoke.json` beside `app.ghostlyapp`. Commit it here, copy it to
the store's folder for Chess, and sign the index. Ghostly stops those versions on every device. A leaked key cannot
be replaced: Chess would be published again under a new key, as a new app.
