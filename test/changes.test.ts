// changes/: one file per pull request instead of one list in CHANGES.md, so parallel pull requests stop conflicting
// on it (ghostly-agents#8290). A release folds the files into CHANGES.md (docs/PUBLISHING.md, step 2).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const dir = join(root, "changes");
const fragments = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");

describe("changes/", () => {
  it("has its README", () => {
    expect(readdirSync(dir)).toContain("README.md");
  });

  it.each(fragments.length ? fragments : ["(none)"])("%s is a bullet list for CHANGES.md", (name) => {
    if (name === "(none)") return;
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*\.md$/);
    const text = readFileSync(join(dir, name), "utf8");
    expect(text.trim()).not.toBe("");
    for (const line of text.trimEnd().split("\n")) expect(line).toMatch(/^(- \S|  \S)/);
  });

  it("CHANGES.md keeps no Unreleased list (it lives in changes/)", () => {
    expect(readFileSync(join(root, "CHANGES.md"), "utf8")).not.toMatch(/^## Unreleased/m);
  });
});
