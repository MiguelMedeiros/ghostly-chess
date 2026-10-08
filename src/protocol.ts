/**
 * Chess's own messages, carried as the JSON value of `ghostly.chat.send` (one `apps/1` data frame each). docs/protocol.md
 * describes both versions for anyone writing another client or a bot.
 *
 * Every message is `{"p": "chess", "v": <1 or 2>, "k": <kind>, ...}`. Version 1 is what Chess 1.0.2 speaks:
 *   seek    {c, a}        a coin toss: c = my commitment (hex SHA-256 of a secret salt), a = game ids I give up
 *   reveal  {s, c}        my salt, answering the peer's commitment c
 *   move    {g, n, m}     ply number n of game g, as UCI ("e2e4", "e7e8q")
 *   sync    {g, s, m, x?} catch-up: game g, both salts [sender's, receiver's], every ply, and how it ended if not on the board
 *   resign  {g}           the sender resigns game g
 *   draw    {g, o}        o = "offer", "accept" or "decline"
 *
 * Version 2 keeps those and adds (negotiate.ts decides which one a side speaks):
 *   hello    {pv, f, n?, re?}      the protocol the sender speaks, its features, its display name; re = 1 in answer to one
 *   seek     {c, a, tc?, r?}       now an invitation with its terms: tc = [base s, increment s], r = a rematch of game r
 *   decline  {c}                   declines the invitation whose commitment is c
 *   move     {g, n, m, t?}         t = the mover's remaining ms after ply n, in a timed game
 *   ack      {g, n}                "I hold n plies"
 *   flag     {g, n, by}            colour `by` ran out of time with n plies on the board
 *   dispute  {g, n}                the claimed side's clock disagrees with the claim at n
 *   sync     {g, s, m, x?, tc?, r?, c?, tb?, d?}  plus the terms, both clocks, the takeback epoch and the standing draw offer
 *   draw     {g, o, n}             n = the ply count the offer stands for
 *   takeback {g, n, o, h?}         o = "ask", "accept" or "decline"; n = the ply count after the undo; an ask's h = the
 *                                  plies the asker held when it asked
 * and three ends: {why: "time", by}, {why: "aborted"} and {why: "disputed"}.
 *
 * Everything from the peer is untrusted: parseMessage checks the size first, then every field's type, shape and
 * range, and refuses the message whole. Unknown extra fields are ignored, so a later 2.x can add one. A frame of a
 * version above 2 gives "newer-version". A version 1 frame is read as 1.0.2 reads it: a v2 field in it is ignored.
 */
import type { MiniAppJson } from "./vendor/miniApp.ts";

export const PROTOCOL = "chess";
/** The newest envelope this side reads and writes. */
export const VERSION = 2;
/** Chess 1.0.2's envelope, still read and written in compat mode. */
export const VERSION_V1 = 1;
/** The first published Chess that speaks protocol 2: a peer below it gets version 1. */
export const PROTO2_SINCE = "2.0.0";
/** One message, serialized as UTF-8 JSON. Half the 32 KiB `paired-app` data cap, so there is room to spare. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** Longest game kept and synced: 2000 plies of at most 5 bytes is about 12 KiB in a sync. Reaching it ends the game drawn. */
export const MAX_PLIES = 2000;
/** Game ids a seek may give up: the sender's current game and the one the peer showed it. */
export const MAX_ABANDON = 2;
/** The features a hello may name. What a side does with the other's frames is gated by the features both name. */
export const FEATURE_NAMES = ["clock", "takeback", "rematch", "abort", "names"] as const;
export type Feature = (typeof FEATURE_NAMES)[number];
/** Bounds of a hello's feature list: names a later version adds are kept, within these. */
export const MAX_FEATURES = 16;
const FEATURE = /^[a-z-]{1,16}$/;
/** A display name in a hello, in code points. */
export const MAX_NAME = 48;
/** A time control's bounds, in seconds: base 15 s to 3 h, increment 0 to 60 s. */
export const TC_BASE_MIN = 15;
export const TC_BASE_MAX = 10800;
export const TC_INC_MAX = 60;
/** A clock reading in ms. */
export const MAX_MS = 2 ** 31 - 1;

export type Colour = "w" | "b";
export type Envelope = 1 | 2;
/** [base seconds, increment seconds]. Absent means unlimited. */
export type TimeControl = [number, number];
/** How a game ended other than on the board. Version 1 has only resign and agreed. */
export type GameEnd = { why: "resign"; by: Colour } | { why: "agreed" } | { why: "time"; by: Colour } | { why: "aborted" } | { why: "disputed" };
export type DrawOption = "offer" | "accept" | "decline";
export type TakebackOption = "ask" | "accept" | "decline";

export type Message =
  | { k: "hello"; pv: number; f: string[]; n?: string; re?: 1 }
  | { k: "seek"; c: string; a: string[]; tc?: TimeControl; r?: string }
  | { k: "decline"; c: string }
  | { k: "reveal"; s: string; c: string }
  | { k: "move"; g: string; n: number; m: string; t?: number }
  | { k: "ack"; g: string; n: number }
  | { k: "flag"; g: string; n: number; by: Colour }
  | { k: "dispute"; g: string; n: number }
  | { k: "sync"; g: string; s: [string, string]; m: string[]; x?: GameEnd; tc?: TimeControl; r?: string; c?: [number, number]; tb?: number; d?: [Colour, number] }
  | { k: "resign"; g: string }
  | { k: "draw"; g: string; o: DrawOption; n?: number }
  | { k: "takeback"; g: string; n: number; o: TakebackOption; h?: number };

export type Kind = Message["k"];
/** The kinds Chess 1.0.2 knows. */
export const V1_KINDS = ["seek", "reveal", "move", "sync", "resign", "draw"] as const;
/** The keys Chess 1.0.2 writes for each kind, besides p, v and k: a v1 frame carries exactly these. */
export const V1_KEYS: Record<(typeof V1_KINDS)[number], readonly string[]> = {
  seek: ["c", "a"],
  reveal: ["s", "c"],
  move: ["g", "n", "m"],
  sync: ["g", "s", "m", "x"],
  resign: ["g"],
  draw: ["g", "o"],
};

export type ParseFailure = "too-big" | "malformed" | "newer-version";
export type Parsed = { ok: true; v: Envelope; message: Message } | { ok: false; reason: ParseFailure };

const HEX64 = /^[0-9a-f]{64}$/;
export const GAME_ID = /^[0-9a-f]{16}$/;
export const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

// ---------- versions ----------

const SEMVER = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A semver version, or null when it is not one. Build metadata is dropped. */
export function parseVersion(version: unknown): { core: [number, number, number]; pre: string[] } | null {
  if (typeof version !== "string") return null;
  const m = SEMVER.exec(version.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver order of two versions (-1, 0 or 1), or null when either is not a version. A prerelease is below its release. */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** True when a peer of this version speaks protocol 2: at or above PROTO2_SINCE. Unparseable or missing is false. */
export function speaksV2(version: unknown): boolean {
  const order = compareVersions(version, PROTO2_SINCE);
  return order !== null && order >= 0;
}

// ---------- terms ----------

/** The time control as it is bound into a v2 deal: "300+0", or "-" for unlimited. */
export function tcText(tc: TimeControl | undefined): string {
  return tc ? `${tc[0]}+${tc[1]}` : "-";
}

/** Whether two sets of terms are the same game's. */
export function sameTerms(a: { tc?: TimeControl; r?: string }, b: { tc?: TimeControl; r?: string }): boolean {
  return tcText(a.tc) === tcText(b.tc) && (a.r ?? "") === (b.r ?? "");
}

/** A display name made safe to show: no control or direction characters, one space at most, trimmed. */
export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

// ---------- writing ----------

/** UTF-8 bytes of a value as JSON, or Infinity when it cannot be serialized. */
export function jsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? Infinity : new TextEncoder().encode(text).length;
  } catch {
    return Infinity;
  }
}

function checked(wire: Record<string, MiniAppJson>, k: string): MiniAppJson {
  if (jsonBytes(wire) > MAX_MESSAGE_BYTES) throw new Error(`chess: a ${k} message is over ${MAX_MESSAGE_BYTES} bytes`);
  return wire;
}

/**
 * The version 1 frame of a message, exactly as Chess 1.0.2 writes it: its keys and nothing else, so no v2 field rides
 * in it (1.0.2 ignores unknown fields, so a seek carrying tc would start an untimed game there). Throws for a kind 1.0.2
 * does not know and for a v2-only end, which only a bug can ask for.
 */
export function encodeV1(message: Message): MiniAppJson {
  const head = { p: PROTOCOL, v: VERSION_V1, k: message.k };
  switch (message.k) {
    case "seek":
      return checked({ ...head, c: message.c, a: [...message.a] }, "seek");
    case "reveal":
      return checked({ ...head, s: message.s, c: message.c }, "reveal");
    case "move":
      return checked({ ...head, g: message.g, n: message.n, m: message.m }, "move");
    case "sync": {
      const wire: Record<string, MiniAppJson> = { ...head, g: message.g, s: [message.s[0], message.s[1]], m: message.m.join(" ") };
      if (message.x) {
        if (message.x.why === "resign") wire.x = { why: "resign", by: message.x.by };
        else if (message.x.why === "agreed") wire.x = { why: "agreed" };
        else throw new Error(`chess: a ${message.x.why} end has no version 1 form`);
      }
      return checked(wire, "sync");
    }
    case "resign":
      return checked({ ...head, g: message.g }, "resign");
    case "draw":
      return checked({ ...head, g: message.g, o: message.o }, "draw");
    default:
      throw new Error(`chess: ${message.k} has no version 1 form`);
  }
}

/** The version 2 frame of a message. Throws when it would break the size cap, which only a bug can do. */
export function encodeV2(message: Message): MiniAppJson {
  const { k, ...fields } = message;
  const wire = { p: PROTOCOL, v: VERSION, k, ...fields } as unknown as Record<string, MiniAppJson>;
  if (message.k === "sync") wire.m = message.m.join(" ");
  // Strict JSON: an absent optional field is left out, never written as undefined.
  for (const key of Object.keys(wire)) if (wire[key] === undefined) delete wire[key];
  return checked(wire, k);
}

/** The wire form of a message in an envelope. */
export function encodeMessage(message: Message, envelope: Envelope = VERSION): MiniAppJson {
  return envelope === VERSION_V1 ? encodeV1(message) : encodeV2(message);
}

// ---------- reading ----------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isColour = (v: unknown): v is Colour => v === "w" || v === "b";
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isGame = (v: unknown): v is string => typeof v === "string" && GAME_ID.test(v);
const isHex64 = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);

/** A game end as version 1 or 2 knows it, or null. */
export function parseEnd(v: unknown, envelope: Envelope = VERSION): GameEnd | null {
  if (!isObject(v)) return null;
  if (v.why === "resign" && isColour(v.by)) return { why: "resign", by: v.by };
  if (v.why === "agreed") return { why: "agreed" };
  if (envelope === VERSION_V1) return null;
  if (v.why === "time" && isColour(v.by)) return { why: "time", by: v.by };
  if (v.why === "aborted") return { why: "aborted" };
  if (v.why === "disputed") return { why: "disputed" };
  return null;
}

/** A time control within its bounds, or null. */
export function parseTc(v: unknown): TimeControl | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  if (!isInt(v[0], TC_BASE_MIN, TC_BASE_MAX) || !isInt(v[1], 0, TC_INC_MAX)) return null;
  return [v[0], v[1]];
}

function parseMoves(v: unknown): string[] | null {
  if (typeof v !== "string") return null;
  const moves = v === "" ? [] : v.split(" ");
  return moves.length <= MAX_PLIES && moves.every((m) => UCI.test(m)) ? moves : null;
}

/** A peer's message, checked. Never throws. */
export function parseMessage(value: unknown): Parsed {
  if (jsonBytes(value) > MAX_MESSAGE_BYTES) return { ok: false, reason: "too-big" };
  const bad: Parsed = { ok: false, reason: "malformed" };
  if (!isObject(value) || value.p !== PROTOCOL || !Number.isInteger(value.v)) return bad;
  if ((value.v as number) > VERSION) return { ok: false, reason: "newer-version" };
  if (value.v === VERSION_V1) {
    const message = parseV1(value);
    return message ? { ok: true, v: 1, message } : bad;
  }
  if (value.v === VERSION) {
    const message = parseV2(value);
    return message ? { ok: true, v: 2, message } : bad;
  }
  return bad;
}

/** A version 1 frame, read as Chess 1.0.2 reads it: its own fields only. */
function parseV1(v: Record<string, unknown>): Message | null {
  switch (v.k) {
    case "seek":
      if (!isHex64(v.c) || !Array.isArray(v.a) || v.a.length > MAX_ABANDON || !v.a.every(isGame)) return null;
      return { k: "seek", c: v.c, a: [...(v.a as string[])] };
    case "reveal":
      if (!isHex64(v.s) || !isHex64(v.c)) return null;
      return { k: "reveal", s: v.s, c: v.c };
    case "move":
      if (!isGame(v.g) || !isInt(v.n, 0, MAX_PLIES - 1) || typeof v.m !== "string" || !UCI.test(v.m)) return null;
      return { k: "move", g: v.g, n: v.n, m: v.m };
    case "sync": {
      if (!isGame(v.g) || !Array.isArray(v.s) || v.s.length !== 2 || !v.s.every(isHex64)) return null;
      const moves = parseMoves(v.m);
      if (!moves) return null;
      const message: Message = { k: "sync", g: v.g, s: [v.s[0] as string, v.s[1] as string], m: moves };
      if (v.x !== undefined) {
        const end = parseEnd(v.x, VERSION_V1);
        if (!end) return null;
        message.x = end;
      }
      return message;
    }
    case "resign":
      return isGame(v.g) ? { k: "resign", g: v.g } : null;
    case "draw":
      if (!isGame(v.g) || (v.o !== "offer" && v.o !== "accept" && v.o !== "decline")) return null;
      return { k: "draw", g: v.g, o: v.o };
    default:
      return null;
  }
}

/** A version 2 frame. */
function parseV2(v: Record<string, unknown>): Message | null {
  switch (v.k) {
    case "hello": {
      if (!isInt(v.pv, VERSION, 999)) return null;
      if (!Array.isArray(v.f) || v.f.length > MAX_FEATURES || !v.f.every((f) => typeof f === "string" && FEATURE.test(f))) return null;
      const message: Message = { k: "hello", pv: v.pv, f: [...new Set(v.f as string[])] };
      if (v.n !== undefined) {
        if (typeof v.n !== "string" || [...v.n].length > MAX_NAME) return null;
        const name = cleanName(v.n);
        if (name) message.n = name;
      }
      if (v.re !== undefined) {
        if (v.re !== 1) return null;
        message.re = 1;
      }
      return message;
    }
    case "seek": {
      const base = parseV1(v);
      if (!base || base.k !== "seek") return null;
      if (v.tc !== undefined) {
        const tc = parseTc(v.tc);
        if (!tc) return null;
        base.tc = tc;
      }
      if (v.r !== undefined) {
        if (!isGame(v.r)) return null;
        base.r = v.r;
      }
      return base;
    }
    case "decline":
      return isHex64(v.c) ? { k: "decline", c: v.c } : null;
    case "reveal":
      return parseV1(v);
    case "move": {
      const base = parseV1(v);
      if (!base || base.k !== "move") return null;
      if (v.t !== undefined) {
        if (!isInt(v.t, 0, MAX_MS)) return null;
        base.t = v.t;
      }
      return base;
    }
    case "ack":
      return isGame(v.g) && isInt(v.n, 0, MAX_PLIES) ? { k: "ack", g: v.g, n: v.n } : null;
    case "flag":
      return isGame(v.g) && isInt(v.n, 0, MAX_PLIES) && isColour(v.by) ? { k: "flag", g: v.g, n: v.n, by: v.by } : null;
    case "dispute":
      return isGame(v.g) && isInt(v.n, 0, MAX_PLIES) ? { k: "dispute", g: v.g, n: v.n } : null;
    case "sync": {
      if (!isGame(v.g) || !Array.isArray(v.s) || v.s.length !== 2 || !v.s.every(isHex64)) return null;
      const moves = parseMoves(v.m);
      if (!moves) return null;
      const message: Extract<Message, { k: "sync" }> = { k: "sync", g: v.g, s: [v.s[0] as string, v.s[1] as string], m: moves };
      if (v.x !== undefined) {
        const end = parseEnd(v.x, VERSION);
        if (!end) return null;
        message.x = end;
      }
      if (v.tc !== undefined) {
        const tc = parseTc(v.tc);
        if (!tc) return null;
        message.tc = tc;
      }
      if (v.r !== undefined) {
        if (!isGame(v.r)) return null;
        message.r = v.r;
      }
      if (v.c !== undefined) {
        if (!Array.isArray(v.c) || v.c.length !== 2 || !v.c.every((t) => isInt(t, 0, MAX_MS))) return null;
        message.c = [v.c[0] as number, v.c[1] as number];
      }
      if (v.tb !== undefined) {
        if (!isInt(v.tb, 0, MAX_MS)) return null;
        message.tb = v.tb;
      }
      if (v.d !== undefined) {
        if (!Array.isArray(v.d) || v.d.length !== 2 || !isColour(v.d[0]) || !isInt(v.d[1], 0, MAX_PLIES)) return null;
        message.d = [v.d[0], v.d[1]];
      }
      return message;
    }
    case "resign":
      return parseV1(v);
    case "draw": {
      const base = parseV1(v);
      if (!base || base.k !== "draw" || !isInt(v.n, 0, MAX_PLIES)) return null;
      return { ...base, n: v.n };
    }
    case "takeback":
      if (!isGame(v.g) || !isInt(v.n, 0, MAX_PLIES - 1) || (v.o !== "ask" && v.o !== "accept" && v.o !== "decline")) return null;
      // An ask names the plies its sender held (h), so a stale ask is never read as a newer one with the same n.
      if (v.o === "ask") return isInt(v.h, 1, MAX_PLIES) ? { k: "takeback", g: v.g, n: v.n, o: v.o, h: v.h } : null;
      return { k: "takeback", g: v.g, n: v.n, o: v.o };
    default:
      return null;
  }
}
