/**
 * The opening a game is in, by position: src/generated/openings.ts (scripts/openings.mjs) holds one record per named
 * position of lichess-org/chess-openings, keyed by the 32-bit FNV-1a hash of its EPD.
 *
 * Nothing is built from the moves at run time: replaying the data set's 3,865 lines with chess.js takes seconds, too
 * long for a phone at startup. The game's own positions are hashed instead, up to MAX_PLY, and the deepest one the
 * table names wins, so a transposition finds its name and a game that left the book keeps the last one. The table is
 * decoded into typed arrays on the first lookup (about 22 KB, well under a millisecond) and searched by halves.
 *
 * The names are English in every UI language: they are data, not the app's words.
 */
import { FAMILIES, MAX_PLY, TABLE, VARIATIONS } from "./generated/openings.ts";

export { MAX_PLY };

export interface Opening {
  /** "B20". */
  eco: string;
  /** "Sicilian Defense", or "Sicilian Defense: Najdorf Variation". */
  name: string;
  /** The ply (1 = white's first move) of the position that named it. */
  ply: number;
}

const RECORD_BYTES = 9;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding, to bytes. */
export function decodeBase64url(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    const digit = B64.indexOf(text[i]);
    if (digit < 0) throw new Error("not base64url");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

/** The 32-bit FNV-1a hash of a string's code units (an EPD is ASCII). The same as scripts/openings.mjs's. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A FEN without the halfmove clock and the move number. */
export const epdOf = (fen: string): string => fen.split(" ", 4).join(" ");

interface Table {
  keys: Uint32Array;
  bytes: Uint8Array;
  families: string[];
  variations: string[];
}
let table: Table | null = null;

function load(): Table {
  if (table) return table;
  const bytes = decodeBase64url(TABLE);
  const count = Math.floor(bytes.length / RECORD_BYTES);
  const keys = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const at = i * RECORD_BYTES;
    keys[i] = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  }
  table = { keys, bytes, families: FAMILIES.split("|"), variations: VARIATIONS.split("|") };
  return table;
}

/** The record index for a key, or -1. */
function find(t: Table, key: number): number {
  let lo = 0;
  let hi = t.keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const k = t.keys[mid];
    if (k === key) return mid;
    if (k < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function opening(t: Table, index: number, ply: number): Opening {
  const at = index * RECORD_BYTES;
  const family = t.families[t.bytes[at + 4]];
  const variation = t.variations[(t.bytes[at + 5] << 8) | t.bytes[at + 6]];
  const eco = (t.bytes[at + 7] << 8) | t.bytes[at + 8];
  return { eco: `${String.fromCharCode(65 + Math.floor(eco / 100))}${String(eco % 100).padStart(2, "0")}`, name: variation ? `${family}: ${variation}` : family, ply };
}

/** The opening of the position with this EPD alone, if the table names it. */
export function openingOfEpd(epd: string, ply = 0): Opening | undefined {
  const t = load();
  const index = find(t, fnv1a(epd));
  return index < 0 ? undefined : opening(t, index, ply);
}

/**
 * The opening of a game: `epds[i]` is the position after ply i + 1 (chess.js's FEN, with or without its counters).
 * Only the first MAX_PLY are read, and the deepest named one wins.
 */
export function openingOf(epds: ArrayLike<string>, upTo = epds.length): Opening | undefined {
  const t = load();
  const last = Math.min(upTo, epds.length, MAX_PLY);
  for (let i = last - 1; i >= 0; i--) {
    const index = find(t, fnv1a(epdOf(epds[i])));
    if (index >= 0) return opening(t, index, i + 1);
  }
  return undefined;
}
