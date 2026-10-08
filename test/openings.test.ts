// covers: apps.chess
// The opening names: a table generated from the vendored lichess-org/chess-openings TSVs, looked up by position.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { build, generate, OUT, readLines, shortName, fnv1a as fnvScript } from "../scripts/openings.mjs";
import { FAMILIES, TABLE, VARIATIONS } from "../src/generated/openings.ts";
import { decodeBase64url, epdOf, fnv1a, MAX_PLY, openingOf, openingOfEpd } from "../src/openings.ts";

const root = join(import.meta.dirname, "..");
const generated = readFileSync(join(root, OUT), "utf8");

/** The FEN after each ply of these SAN moves. */
function fensOf(...sans: string[]): string[] {
  const chess = new Chess();
  return sans.map((san) => {
    chess.move(san);
    return chess.fen();
  });
}

describe("the generated table", () => {
  it("is what scripts/openings.mjs makes from the vendored TSVs (npm run gen:openings)", () => {
    expect(generated).toBe(generate());
  }, 30_000);

  it("is 48 KiB or less, and its table is base64url without padding", () => {
    expect(Buffer.byteLength(generated)).toBeLessThanOrEqual(48 * 1024);
    // No "=": the bundle test's src=/href= checks must never meet one after a word.
    expect(TABLE).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(TABLE.length % 12).toBe(0); // whole 9-byte records, so no padding was ever due
    expect(FAMILIES.split("|")).toHaveLength(150);
    expect(VARIATIONS.split("|")[0]).toBe("");
  });

  it("has no two entries with one 32-bit key", () => {
    const { records } = build();
    expect(records).toHaveLength(2175);
    expect(new Set(records.map((r) => r.key)).size).toBe(records.length);
    const bytes = decodeBase64url(TABLE);
    expect(bytes.length).toBe(records.length * 9);
    const keys = records.map((_, i) => new DataView(bytes.buffer).getUint32(i * 9));
    // Sorted strictly ascending: the page searches by halves.
    expect(keys.every((k, i) => i === 0 || k > keys[i - 1])).toBe(true);
  }, 30_000);

  it("hashes the same in the page and in the generator", () => {
    for (const text of ["", "a", "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"]) expect(fnv1a(text)).toBe(fnvScript(text));
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c); // the published FNV-1a test vector
  });
});

describe("looking a game up", () => {
  it("names 1.e4 c5 the Sicilian Defense (B20)", () => {
    expect(openingOf(fensOf("e4", "c5"))).toMatchObject({ name: "Sicilian Defense", eco: "B20", ply: 2 });
  });

  it("names 1.e4 e5 2.Nf3 Nc6 3.Bb5 the Ruy Lopez (C60)", () => {
    expect(openingOf(fensOf("e4", "e5", "Nf3", "Nc6", "Bb5"))).toMatchObject({ name: "Ruy Lopez", eco: "C60" });
  });

  it("finds the Queen's Gambit Declined (D30) from 1.c4 e6 2.d4 d5, by transposition", () => {
    expect(openingOf(fensOf("c4", "e6", "d4", "d5"))).toMatchObject({ name: "Queen's Gambit Declined", eco: "D30", ply: 4 });
  });

  it("gives a variation's own ECO code where its name is the same as its parent's: 6.g3 in the Najdorf is B91", () => {
    const najdorf = ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"];
    expect(openingOf(fensOf(...najdorf))).toMatchObject({ name: "Sicilian Defense: Najdorf Variation", eco: "B90" });
    expect(openingOf(fensOf(...najdorf, "g3"))).toMatchObject({ name: "Sicilian Defense: Najdorf Variation", eco: "B91" });
    expect(openingOf(fensOf("Nf3", "d5", "g3"))?.eco).toBe("A07");
  });

  it("gives every line of the data set its own ECO code and short name, looked up along its own moves", () => {
    const wrong: string[] = [];
    for (const line of readLines()) {
      const found = openingOf(line.epds);
      const name = shortName(line.name).filter(Boolean).join(": ");
      if (found?.eco !== line.eco || found.name !== name) wrong.push(`${line.eco} ${line.name}: got ${found?.eco} ${found?.name}`);
    }
    expect(wrong).toEqual([]);
  }, 30_000);

  it("takes the EPD without the move counters", () => {
    const [fen] = fensOf("e4");
    expect(epdOf(fen)).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -");
    expect(openingOfEpd(epdOf(fen))?.name).toBe("King's Pawn Game");
  });

  it("keeps the last name once the game leaves the book, and names nothing before the first move", () => {
    const fens = fensOf("e4", "c5", "a3", "a6", "h3", "h6", "Ra2", "Ra7", "Rh2", "Rh7");
    // 3.a3 is the last named move (the Mengarini Variation); the rooks' walk is in no book.
    expect(openingOf(fens)).toMatchObject({ name: "Sicilian Defense: Mengarini Variation", ply: 3 });
    expect(openingOf(fens.slice(0, 2))?.name).toBe("Sicilian Defense");
    expect(openingOf([])).toBeUndefined();
    // Looked up at an earlier ply (the review cursor), the name is that ply's.
    expect(openingOf(fens, 1)?.name).toBe("King's Pawn Game");
  });

  it(`reads at most ${MAX_PLY} positions of a 2000-ply game, in under 10 ms`, () => {
    expect(MAX_PLY).toBeLessThanOrEqual(36);
    // A 2000-ply game: the knights go out and back. Every position past MAX_PLY throws when read.
    const chess = new Chess();
    const shuffle = ["Nf3", "Nf6", "Ng1", "Ng8"];
    const fens: string[] = [];
    for (let i = 0; i < 2000; i++) {
      // chess.js would end it by repetition; the positions are what the lookup reads, so they are built without it.
      chess.move(shuffle[i % 4]);
      fens.push(chess.fen());
    }
    let reads = 0;
    const game = new Proxy(fens, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          if (Number(key) >= MAX_PLY) throw new Error(`read position ${key}`);
          reads++;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    openingOf(game); // the first lookup decodes the table
    reads = 0;
    const start = performance.now();
    const found = openingOf(game);
    const ms = performance.now() - start;
    expect(reads).toBeLessThanOrEqual(MAX_PLY);
    expect(ms).toBeLessThan(10);
    expect(found?.ply).toBeGreaterThan(0);
  });
});
