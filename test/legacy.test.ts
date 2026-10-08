// covers: apps.chess
// The frozen Chess 1.0.2 (test/legacy/1.0.2, see its README): byte-identical to what 1.0.2 shipped, and the published
// page it built, so the compatibility tests run the real thing.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");

/** SHA-256 of each file at commit 5add960, which builds the published 1.0.2 page. */
const PINNED: Record<string, string> = {
  "test/legacy/1.0.2/game.ts": "dca514e61bd963111cb78ff92605a2746519fed11844b70d894a30da16bb6b52",
  "test/legacy/1.0.2/protocol.ts": "54a73337062deccbcf87f9f8590539bcc77482b91bf06360b4554a05f7d1c641",
  "test/legacy/1.0.2/toss.ts": "56d99607764ecf6d79850b6b7316a6d288f574029a8751195cdfc77d69958782",
  "test/legacy/1.0.2/vendor/miniApp.ts": "a13dc2c3d9fc47a10d15444b7f021143725efb6037bc52471577baec129411e6",
};

/** The published Chess 1.0.2 page, as a signed bundle lists it (SHA-256, base64url). */
export const CHESS_102_DIGEST = "l5ozbABlwoZn7MBgzaQniVWT4shgPI10A_0Bi-fZENE";

describe("the frozen Chess 1.0.2", () => {
  it.each(Object.entries(PINNED))("keeps %s byte for byte", (path, digest) => {
    expect(sha256(path)).toBe(digest);
  });

  it("keeps the published 1.0.2 page as the browser fixture", () => {
    const page = readFileSync(join(root, "test/browser/fixtures/chess-1.0.2.html"));
    expect(page.length).toBe(81_896);
    expect(createHash("sha256").update(page).digest("base64url")).toBe(CHESS_102_DIGEST);
  });

  it("runs on the chess.js it shipped with", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["chess.js"]).toBe("1.4.0");
  });
});
