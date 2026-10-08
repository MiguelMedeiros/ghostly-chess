// Turns the vendored opening names (assets/openings/{a,b,c,d,e}.tsv, lichess-org/chess-openings, CC0-1.0) into
// src/generated/openings.ts: a table the page looks positions up in, with no index built at run time.
//
//   npm run gen:openings               writes src/generated/openings.ts
//   node scripts/openings.mjs --check  fails when the file differs from what the TSVs give
//
// Each line of the data set ("B20  Sicilian Defense  1. e4 c5") is replayed once here, in Node, with chess.js. The
// named position is where the line ends, as an EPD: chess.js's FEN without the move counters (chess.js 1.4.0 writes
// the en passant square only when a capture is legal, as the data set's own EPDs do).
//
// A name is cut to "Family: first variation" ("Sicilian Defense: Najdorf Variation, English Attack" is kept as
// "Sicilian Defense: Najdorf Variation"). A line whose short name is the same as that of the nearest named position
// before it on its own line adds nothing, and is dropped.
//
// Each kept position is one 9-byte record, sorted by its key: the 32-bit FNV-1a hash of its EPD (4 bytes, big-endian),
// the family index (1 byte), the variation index (2 bytes, 0 for none) and the ECO code (2 bytes: letter * 100 +
// number). The records go in as base64url without padding. Two records with one key fail the build.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";

const root = join(import.meta.dirname, "..");
export const OUT = "src/generated/openings.ts";
export const FILES = ["a", "b", "c", "d", "e"].map((v) => `assets/openings/${v}.tsv`);
/** The commit of lichess-org/chess-openings the TSVs come from. */
export const PIN = "a6189a30dc273ccb21fc2536a9a2fefd5592a67a";
export const RECORD_BYTES = 9;

/** The 32-bit FNV-1a hash of a string's UTF-16 code units (an EPD is ASCII, so its bytes). */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** chess.js's FEN without the halfmove clock and the move number. */
export const epd = (fen) => fen.split(" ").slice(0, 4).join(" ");

/** [family, first variation or ""] of a full name. */
export function shortName(name) {
  const colon = name.indexOf(": ");
  if (colon < 0) return [name, ""];
  return [name.slice(0, colon), name.slice(colon + 2).split(", ")[0]];
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/** Every line of the data set: { eco, name, epds } with the EPD after each ply. */
export function readLines() {
  const lines = [];
  for (const file of FILES) {
    const rows = readFileSync(join(root, file), "utf8").split("\n").filter(Boolean);
    if (rows[0] !== "eco\tname\tpgn") throw new Error(`${file}: unexpected header ${rows[0]}`);
    for (const row of rows.slice(1)) {
      const [eco, name, pgn, extra] = row.split("\t");
      if (extra !== undefined || !/^[A-E]\d\d$/.test(eco) || !name || !pgn) throw new Error(`${file}: bad row ${row}`);
      if (name.includes("|")) throw new Error(`${file}: a name holds the separator: ${name}`);
      const chess = new Chess();
      const epds = [];
      for (const token of pgn.split(/\s+/)) {
        if (/^\d+\.(\.\.)?$/.test(token)) continue;
        chess.move(token);
        epds.push(epd(chess.fen()));
      }
      lines.push({ eco, name, epds });
    }
  }
  return lines;
}

/** The data the page needs: the name tables, the records, and the deepest ply a record stands at. */
export function build(lines = readLines()) {
  const named = new Map();
  for (const line of lines) {
    const key = line.epds[line.epds.length - 1];
    if (named.has(key)) throw new Error(`two lines end on one position: ${named.get(key).name} and ${line.name}`);
    named.set(key, line);
  }
  const kept = [];
  for (const line of lines) {
    const short = shortName(line.name).join(": ");
    let parent;
    for (let i = line.epds.length - 2; i >= 0 && !parent; i--) parent = named.get(line.epds[i]);
    if (parent && shortName(parent.name).join(": ") === short) continue;
    kept.push(line);
  }
  const families = [...new Set(kept.map((l) => shortName(l.name)[0]))].sort();
  const variations = ["", ...[...new Set(kept.map((l) => shortName(l.name)[1]).filter(Boolean))].sort()];
  if (families.length > 256 || variations.length > 65536) throw new Error("too many names for the record's fields");
  const records = kept.map((line) => {
    const [family, variation] = shortName(line.name);
    return {
      key: fnv1a(line.epds[line.epds.length - 1]),
      family: families.indexOf(family),
      variation: variations.indexOf(variation),
      eco: (line.eco.charCodeAt(0) - 65) * 100 + Number(line.eco.slice(1)),
      ply: line.epds.length,
      name: line.name,
    };
  });
  records.sort((a, b) => a.key - b.key);
  for (let i = 1; i < records.length; i++) {
    if (records[i].key === records[i - 1].key) throw new Error(`hash collision: ${records[i - 1].name} and ${records[i].name}`);
  }
  const bytes = new Uint8Array(records.length * RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  records.forEach((r, i) => {
    const at = i * RECORD_BYTES;
    view.setUint32(at, r.key);
    view.setUint8(at + 4, r.family);
    view.setUint16(at + 5, r.variation);
    view.setUint16(at + 7, r.eco);
  });
  // The deepest line of the data set, not only of the kept records: a game can reach a kept position later than its
  // own line does, by transposition.
  const maxPly = Math.max(...lines.map((l) => l.epds.length));
  return { families, variations, records, table: base64url(bytes), maxPly };
}

/** The text of src/generated/openings.ts. */
export function generate() {
  const { families, variations, records, table, maxPly } = build();
  return [
    "// Generated by scripts/openings.mjs (npm run gen:openings) from assets/openings. Do not edit by hand.",
    `// lichess-org/chess-openings at ${PIN}, CC0-1.0: ${records.length} named positions.`,
    "",
    "/** The deepest ply of a line in the data set: a game is looked up no further. */",
    `export const MAX_PLY = ${maxPly};`,
    "/** Opening families, by index, separated by \"|\". */",
    `export const FAMILIES = ${JSON.stringify(families.join("|"))};`,
    "/** First variations, by index (0 is none), separated by \"|\". */",
    `export const VARIATIONS = ${JSON.stringify(variations.join("|"))};`,
    `/** ${RECORD_BYTES}-byte records sorted by key, base64url without padding: FNV-1a(EPD) u32, family u8, variation u16, ECO u16. */`,
    `export const TABLE = ${JSON.stringify(table)};`,
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const out = join(root, OUT);
  const text = generate();
  if (process.argv.includes("--check")) {
    if (readFileSync(out, "utf8") !== text) {
      console.error(`${OUT} is out of date: run npm run gen:openings`);
      process.exit(1);
    }
  } else {
    writeFileSync(out, text);
    console.log(`wrote ${OUT} (${Buffer.byteLength(text)} bytes)`);
  }
}
