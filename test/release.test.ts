// covers: apps.chess
// What a release is made from: the manifest as `ghostly app publish` takes it, and scripts/bundle.mjs, which says
// whether a signed bundle is this checkout's build and writes the store's listing for it (docs/PUBLISHING.md).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestOf, expected, listing, problems, PUBLISHER, readManifest, SOURCE, type BundleManifest } from "../scripts/bundle.mjs";

const root = join(import.meta.dirname, "..");
const source = JSON.parse(readFileSync(join(root, "ghostly-app.json"), "utf8")) as Record<string, unknown>;
const page = new TextEncoder().encode("<!doctype html><title>Chess</title>");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64url");

/** The manifest `ghostly app publish` would sign for this checkout, were `page` its build. */
const signed = (changes: Record<string, unknown> = {}): BundleManifest => ({
  ...(source as BundleManifest),
  ghostlyApp: 1,
  publisher: PUBLISHER,
  sequence: 4,
  files: [{ path: "index.html", size: page.length, sha256: sha256(page) }],
  ...changes,
});

/** A bundle as WISP 1200 lays it out: the magic, the manifest's length and bytes, the statement's, then the files. */
function bundle(manifest: BundleManifest): Uint8Array {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const statement = Buffer.from('{"alg":"ed25519"}');
  const length = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  return Buffer.concat([Buffer.from("GHOSTLYAPP1"), length(manifestBytes.length), manifestBytes, length(statement.length), statement, page]);
}

describe("the manifest", () => {
  it("leaves publisher, sequence and files to ghostly app publish", () => {
    for (const key of ["publisher", "sequence", "files", "ghostlyApp"]) expect(source).not.toHaveProperty(key);
  });

  it("names this repository's bundle as the place newer versions are read from", () => {
    expect(source.sources).toEqual([SOURCE]);
    expect(SOURCE).toBe("https://raw.githubusercontent.com/MiguelMedeiros/ghostly-chess/HEAD/app.ghostlyapp");
  });

  it("shows in a chat, and says what is new in one line of at most 500 characters", () => {
    expect(source.view).toBe("chat");
    const notes = source.releaseNotes as string;
    expect([...notes].length).toBeLessThanOrEqual(500);
    expect(notes).not.toMatch(/[\r\n]/);
  });
});

describe("a signed bundle's manifest", () => {
  it("is read with its digest, the SHA-256 of the manifest's bytes", () => {
    const manifest = signed();
    const read = readManifest(bundle(manifest));
    expect(read.manifest).toEqual(manifest);
    expect(read.digest).toBe(sha256(Buffer.from(JSON.stringify(manifest))));
  });

  it("is refused when the file is not a bundle, or is cut short", () => {
    expect(() => readManifest(page)).toThrow("not a .ghostlyapp bundle");
    expect(() => readManifest(bundle(signed()).subarray(0, 40))).toThrow("cut short");
  });

  it("has no problem when it is this checkout's build under the Chess key", () => {
    expect(problems(signed(), source, page)).toEqual([]);
  });

  it("is refused under another key, with another page, another file, or a field ghostly-app.json does not say", () => {
    expect(problems(signed({ publisher: "y".repeat(52) }), source, page)).toEqual([expect.stringContaining("another publisher key")]);
    expect(problems(signed(), source, new TextEncoder().encode("another build"))).toEqual([expect.stringContaining("is not this build's")]);
    const two = [...signed().files, { path: "notes.txt", size: 1, sha256: "x" }];
    expect(problems(signed({ files: two }), source, page)).toEqual([expect.stringContaining("not index.html alone")]);
    expect(problems(signed({ version: "2.2.0" }), source, page)).toEqual([expect.stringContaining('version is "2.2.0"')]);
    expect(problems(signed({ permissions: ["chat", "name", "internet"] }), source, page)).toEqual([expect.stringContaining("permissions is")]);
    expect(problems(signed({ proofs: [] }), source, page)).toEqual([expect.stringContaining("proofs is []")]);
    expect(problems(signed({ sequence: 0 }), source, page)).toEqual([expect.stringContaining("sequence is 0")]);
  });

  it("is the same whatever order its keys were written in", () => {
    const manifest = signed();
    const reversed = Object.fromEntries(Object.entries(manifest).reverse()) as BundleManifest;
    reversed.runtime = { clients: ["web", "desktop"], host: ">=1.2" };
    expect(problems(reversed, source, page)).toEqual([]);
  });
});

/** The manifest of the published Chess 1.0.2 (sequence 3), as `ghostly app verify` prints it. */
const CHESS_102 = {
  description: "Open Chess in a chat and your contact gets a card to join. Moves travel over the chat's live connection, and each side keeps the game for that chat, so it comes back after a reload. Opened alone, you play both sides.",
  entry: "index.html",
  files: [{ path: "index.html", sha256: "l5ozbABlwoZn7MBgzaQniVWT4shgPI10A_0Bi-fZENE", size: 81896 }],
  ghostlyApp: 1,
  homepage: "https://github.com/MiguelMedeiros/ghostly/tree/dev/apps/mini/chess",
  kind: "mini-app",
  license: "MIT",
  name: "chess",
  permissions: ["chat"],
  publisher: PUBLISHER,
  runtime: { clients: ["web", "desktop"], host: ">=1.2" },
  sequence: 3,
  sources: ["https://raw.githubusercontent.com/MiguelMedeiros/ghostly-store/HEAD/apps/chess.odcgw6wjw8dynqop/app.ghostlyapp"],
  support: "https://github.com/MiguelMedeiros/ghostly/issues",
  tagline: "Play chess with a contact, live in your chat",
  title: "Chess",
  version: "1.0.2",
};

describe("the digest a bundle will have", () => {
  it("is known before it is signed: Chess 1.0.2's, from its manifest's fields, is the one the store lists", () => {
    expect(digestOf(CHESS_102)).toBe("0KbzVGC-oPCoa_JXHOCrMZtopdYhMOz3eBAuoTGC53w");
    expect(digestOf(Object.fromEntries(Object.entries(CHESS_102).reverse()))).toBe("0KbzVGC-oPCoa_JXHOCrMZtopdYhMOz3eBAuoTGC53w");
  });

  it("is that of ghostly-app.json with the Chess key, the sequence and the built page, and of the bundle once signed", () => {
    const manifest = expected(source, page, 4);
    expect(manifest).toEqual(signed());
    expect(problems(manifest, source, page)).toEqual([]);
    expect(digestOf(expected(source, page, 5))).not.toBe(digestOf(manifest));
  });
});

describe("the store's listing", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";

  it("names the copy pinned to the bundle's commit first, then this repository's HEAD", () => {
    const made = listing(signed(), "digest", commit);
    expect(made).toMatchObject({ ref: `${PUBLISHER}/chess`, sequence: 4, digest: "digest", title: "Chess", repo: "https://github.com/MiguelMedeiros/ghostly-chess" });
    expect(made.urls).toEqual([`https://cdn.jsdelivr.net/gh/MiguelMedeiros/ghostly-chess@${commit}/app.ghostlyapp`, SOURCE]);
  });

  it("takes a full commit only: jsDelivr serves a branch or a short commit from a copy that moves", () => {
    expect(() => listing(signed(), "digest", "main")).toThrow("not a full commit");
    expect(() => listing(signed(), "digest", commit.slice(0, 7))).toThrow("not a full commit");
  });
});
