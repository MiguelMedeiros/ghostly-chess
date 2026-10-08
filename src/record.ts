/**
 * What Chess keeps in the broker's storage, per chat, and how an older record is read.
 *
 *   "game"  SavedGame v:2, the game in this chat. A v:1 record (Chess 1.0.2) reads as an untimed v:2 one with the same
 *           game id and colours (dv 1), so a game in progress survives the update.
 *   "flip"  SavedFlip v:2, the toss in progress: the salt, the deal it is for, and the invitation's terms, so a reload
 *           re-sends the same seek and the deal gets the same terms. A v:1 record (Chess 1.0.2) is a deal 1 toss.
 *   "prev"  SavedPrev, the last finished game's {g, me, tc}: what a rematch is checked against.
 *
 * A record that does not read is dropped, as before: its required fields must be well formed, and a bad optional
 * field is left out. The record is written at turn boundaries, never per clock tick (the broker allows 50 requests a
 * second); 2000 plies with clocks is about 33 KB, under the broker's 64 KiB per value.
 */
import { GAME_ID, MAX_ABANDON, MAX_MS, MAX_PLIES, parseEnd, parseTc, UCI, type Colour, type GameEnd, type TimeControl } from "./protocol.ts";

export const KEY_GAME = "game";
export const KEY_FLIP = "flip";
export const KEY_PREV = "prev";

export interface SavedGame {
  v: 2;
  /** Game id, from both salts (and, in a dv:2 game, the terms). */
  g: string;
  /** This side's colour. */
  me: Colour;
  /** [this side's salt, the peer's salt]. */
  s: [string, string];
  /** The deal that made the game: 1 (Chess 1.0.2's, untimed) or 2 (deal2, with its terms). */
  dv: 1 | 2;
  /** The start date, "YYYY.MM.DD" in local time, set when the toss completes (a 1.0.2 record has none). */
  sd?: string;
  /** The time control, [base s, increment s]; absent means unlimited. */
  tc?: TimeControl;
  /** The game this one is a rematch of. */
  r?: string;
  /** Every ply, UCI. */
  m: string[];
  /** Each ply's mover's remaining ms after it (timed games). */
  k?: number[];
  /** Wall time when this side's turn started (timed games). */
  tw?: number;
  /** Wall time when this side first sent its last ply (timed games). */
  ts?: number;
  /** How the game ended other than on the board. */
  x?: GameEnd;
  /** A draw offer that stands: made by this side ("me") or the peer. */
  d?: "me" | "peer";
  /** The ply count the standing draw offer was made at. */
  dn?: number;
  /** The takeback epoch: how many takebacks were accepted. */
  tb?: number;
  /** A takeback this side asked for, by the ply count it goes back to. */
  q?: number;
  /** A clock claim waiting for the contact to come back, by ply count. */
  pc?: number;
  /** The ply count at which this side sent or received a clock claim. */
  fl?: number;
  /**
   * How much more time the contact's clock says it has than this side's view of it, after a clamp (C5). Its later
   * reports are read less this, so the two move lists differ by exactly the clamp, and only at the clamped ply.
   */
  ko?: number;
}

/** A toss in progress, under "flip": the salt survives a reload, so the toss can finish with the same terms. */
export interface SavedFlip {
  v: 2;
  salt: string;
  /**
   * The deal this toss is for: 1 (Chess 1.0.2's) or 2 (deal2). It follows the envelope of each seek sent until the
   * peer's commitment is held, then it is fixed: a reveal or a sync for this toss is placed only by this deal, so a
   * side can never pick the better of the two deals for the same salts.
   */
  dv: 1 | 2;
  /** The peer's commitment this salt was revealed against. */
  peer?: string;
  /** Game ids this toss gives up. */
  a: string[];
  /** The invitation's time control; absent means unlimited. */
  tc?: TimeControl;
  /** The game this invitation is a rematch of. */
  r?: string;
}

/** The last finished game, under "prev". */
export interface SavedPrev {
  g: string;
  me: Colour;
  tc?: TimeControl;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}\.\d\d\.\d\d$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isGame = (v: unknown): v is string => typeof v === "string" && GAME_ID.test(v);
/** A wall-clock time in ms (Date.now), up to year 275760. */
const isTime = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 8.64e15;

/** The game record, from storage: a v:2 one checked, a v:1 one (Chess 1.0.2) migrated. Null when it does not read. */
export function readGame(value: unknown): SavedGame | null {
  if (!isObject(value) || (value.v !== 1 && value.v !== 2)) return null;
  const v = value;
  if (!isGame(v.g) || (v.me !== "w" && v.me !== "b")) return null;
  if (!Array.isArray(v.s) || v.s.length !== 2 || !v.s.every((s) => typeof s === "string" && HEX64.test(s))) return null;
  if (!Array.isArray(v.m) || v.m.length > MAX_PLIES || !v.m.every((m) => typeof m === "string" && UCI.test(m))) return null;
  const game: SavedGame = { v: 2, g: v.g, me: v.me, s: [v.s[0] as string, v.s[1] as string], dv: 1, m: [...(v.m as string[])] };
  if (v.v === 2) {
    if (v.dv !== 1 && v.dv !== 2) return null;
    game.dv = v.dv;
  }
  if (typeof v.sd === "string" && DATE.test(v.sd)) game.sd = v.sd;
  const end = parseEnd(v.x, game.dv === 1 && v.v === 1 ? 1 : 2);
  if (end) game.x = end;
  if (v.d === "me" || v.d === "peer") game.d = v.d;
  if (v.v === 1) return game;
  // Version 2's own fields. A dv:1 game is untimed whatever the record says.
  if (game.dv === 2) {
    const tc = v.tc === undefined ? null : parseTc(v.tc);
    if (tc) game.tc = tc;
    if (isGame(v.r)) game.r = v.r;
  }
  if (Array.isArray(v.k) && v.k.length <= game.m.length && v.k.every((t) => isInt(t, 0, MAX_MS))) game.k = [...(v.k as number[])];
  if (isTime(v.tw)) game.tw = v.tw;
  if (isTime(v.ts)) game.ts = v.ts;
  for (const key of ["dn", "q", "pc", "fl"] as const) if (isInt(v[key], 0, MAX_PLIES)) game[key] = v[key] as number;
  if (isInt(v.tb, 0, MAX_MS)) game.tb = v.tb;
  if (game.tc && isInt(v.ko, 1, MAX_MS)) game.ko = v.ko;
  if (!game.d) delete game.dn;
  return game;
}

/** The toss record, from storage: a v:1 one (Chess 1.0.2) reads as an untimed toss for deal 1. Null when it does not read. */
export function readFlip(value: unknown): SavedFlip | null {
  if (!isObject(value) || (value.v !== 1 && value.v !== 2)) return null;
  const v = value;
  if (typeof v.salt !== "string" || !HEX64.test(v.salt)) return null;
  if (!Array.isArray(v.a) || v.a.length > MAX_ABANDON || !v.a.every(isGame)) return null;
  const flip: SavedFlip = { v: 2, salt: v.salt, dv: 1, a: [...(v.a as string[])] };
  if (typeof v.peer === "string" && HEX64.test(v.peer)) flip.peer = v.peer;
  if (v.v === 2) {
    if (v.dv !== 1 && v.dv !== 2) return null;
    flip.dv = v.dv;
    if (v.tc !== undefined) {
      const tc = parseTc(v.tc);
      if (!tc) return null;
      flip.tc = tc;
    }
    if (v.r !== undefined) {
      if (!isGame(v.r)) return null;
      flip.r = v.r;
    }
  }
  return flip;
}

/** The last finished game, from storage, or null. */
export function readPrev(value: unknown): SavedPrev | null {
  if (!isObject(value) || !isGame(value.g) || (value.me !== "w" && value.me !== "b")) return null;
  const prev: SavedPrev = { g: value.g, me: value.me };
  const tc = value.tc === undefined ? null : parseTc(value.tc);
  if (tc) prev.tc = tc;
  return prev;
}
