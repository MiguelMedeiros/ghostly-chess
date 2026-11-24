# Unreleased changes

One file per pull request, `changes/<slug>.md` (a short name of the change), holding the bullet(s) that pull request
adds to [CHANGES.md](../CHANGES.md):

```md
- What a person now sees or can do, in plain words. Before, what went wrong.
```

Parallel pull requests no longer edit the same list in CHANGES.md, so the only conflict between them is gone.

At a release ([docs/PUBLISHING.md](../docs/PUBLISHING.md), step 2), the new version's section in CHANGES.md takes the
bullets of every file here, and the files are deleted in that same pull request. This README stays.
