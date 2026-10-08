/**
 * The clocks' pure model (protocol rules C1-C9 in docs/protocol.md): no DOM, no I/O, no time source of its own. The
 * controller (game.ts) feeds it readings of two clocks: `mono`, monotonic within a run (performance.now), and `wall`,
 * Date.now, which carries a turn across a reload or a close.
 *
 * Bookkeeping, the same on both sides:
 * - `k` runs beside the moves: k[i] is the mover's remaining ms after ply i. Plies 0 and 1 are untimed (C1), so
 *   k[0] = k[1] = base. From ply 2 the increment is added after the move: k[i] = k[i-2] + I - spent.
 * - P, the mover's time before ply n, is k[n-2] (the base for each side's first timed ply).
 * - The time a ply took, for the move list, is k[i-2] + I - k[i].
 * - Each side measures its own clock (C2). It keeps a view of the contact's, from the t the contact reports, bounded
 *   by what it saw (C4, C5): t <= P + I, and spent >= E - G, where E runs from this side's own send of its ply (ts)
 *   to the contact's latest proof that it had not moved yet (an ack, or the move frame itself). E never starts at an
 *   ack, so a peer cannot erase its clock by holding its acks.
 */
import type { Colour, TimeControl } from "./protocol.ts";

/** How often the side to move says "I hold n plies" while the contact is open (an ack). */
export const ACK_EVERY_MS = 2000;
/** No frame from the contact for this long, on its turn in a timed game: "isn't answering". */
export const SILENT_MS = 10_000;
/** The grace's floor. */
export const GRACE_MIN_MS = 300;
/** RTT samples the grace is taken from. */
const SAMPLES = 5;

/**
 * The presets of the new-game panel, [base s, increment s]: 1|0 bullet, 3|2 and 5|0 blitz, 10|0 rapid, 30|0
 * classical. No time control is Unlimited.
 */
export const PRESET_TCS: readonly TimeControl[] = [
  [60, 0],
  [180, 2],
  [300, 0],
  [600, 0],
  [1800, 0],
];

/** The ceiling of the grace: 1 s in games under 3 minutes, 2 s otherwise. */
export const graceMax = (tc: TimeControl): number => (tc[0] < 180 ? 1000 : 2000);

/** Plies 0 and 1 carry no time; from ply 2 on, each move is timed and carries t (C1). */
export const timedPly = (n: number): boolean => n >= 2;

/** The increment added after ply n, in ms: none before ply 2 (C1). */
export const incrementAt = (tc: TimeControl, n: number): number => (timedPly(n) ? tc[1] * 1000 : 0);

/** The base time, in ms. */
export const baseMs = (tc: TimeControl): number => tc[0] * 1000;

/** The mover's time before ply n (P): its remaining after its ply n-2, or the base. */
export function timeBefore(tc: TimeControl, k: readonly number[], n: number): number {
  return n >= 2 && k[n - 2] !== undefined ? k[n - 2] : baseMs(tc);
}

/** Each colour's remaining ms after the last ply in `k` (the sync's c), [white, black]. */
export function clocksAfter(tc: TimeControl, k: readonly number[]): [number, number] {
  const n = k.length;
  const last = (colour: Colour) => {
    const i = colour === "w" ? (n % 2 === 0 ? n - 2 : n - 1) : n % 2 === 0 ? n - 1 : n - 2;
    return i >= 0 && k[i] !== undefined ? k[i] : baseMs(tc);
  };
  return [last("w"), last("b")];
}

/** The time ply i took, in ms; undefined for the untimed plies 0 and 1. */
export function spentOn(tc: TimeControl, k: readonly number[], i: number): number | undefined {
  if (!timedPly(i) || k[i] === undefined) return undefined;
  return Math.max(0, timeBefore(tc, k, i) + incrementAt(tc, i) - k[i]);
}

/**
 * The grace G (C3): twice the median of the last 5 round trips (a send of this side's ply to the first ack of it),
 * within [300 ms, Gmax]; Gmax before any sample. A peer that delays its acks only inflates G up to Gmax.
 */
export function grace(samples: readonly number[], tc: TimeControl): number {
  const max = graceMax(tc);
  const last = samples.slice(-SAMPLES).filter((s) => Number.isFinite(s) && s >= 0);
  if (!last.length) return max;
  const sorted = [...last].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.min(max, Math.max(GRACE_MIN_MS, 2 * median));
}

/** Keeps the last few samples. */
export function addSample(samples: readonly number[], sample: number): number[] {
  return [...samples, sample].slice(-SAMPLES);
}

/**
 * A reported t, checked (C5). `P` is the mover's time before the ply, `I` the increment, `E` the observer bound when
 * there is a proof (undefined when there is none: then t <= P + I is the only check), `G` the grace.
 * Returns this side's view of the mover's clock after the ply (it may be at or below 0: a claim, never a refusal),
 * and whether the report was clamped (a notice).
 */
export function checkReported(t: number, P: number, I: number, E: number | undefined, G: number): { view: number; clamped: boolean } {
  let view = t;
  let clamped = false;
  if (view > P + I) {
    view = P + I;
    clamped = true;
  }
  if (E !== undefined && P + I - view < E - G) {
    view = P + I - (E - G);
    clamped = true;
  }
  return { view: Math.round(view), clamped };
}

/**
 * Whether the observer may claim the mover's time (C7): with a proof whose E is past P + G, or when its clamped view
 * of the mover is at or below 0. Wall time alone, without a proof, never makes a claim.
 */
export function mayClaim(E: number | undefined, P: number, G: number, view?: number): boolean {
  return (E !== undefined && E > P + G) || (view !== undefined && view <= 0);
}

/** The pieces a colour has, by type ("k", "q"...). */
export type Pieces = readonly string[];

/** True when these pieces cannot mate: a king alone, a king and a bishop, or a king and a knight (chess.com's rule). */
export function cannotMatePieces(pieces: Pieces): boolean {
  return pieces.length === 1 || (pieces.length === 2 && (pieces.includes("b") || pieces.includes("n")));
}

/**
 * The result when `flagged` runs out of time (C6): a loss, or a draw when the opponent has only K, K+B or K+N.
 * (FIDE would also ask whether any helpmate exists; chess.com does not, nor does Chess.)
 */
export function timeoutResult(flagged: Colour, opponent: Pieces): "1-0" | "0-1" | "1/2-1/2" {
  if (cannotMatePieces(opponent)) return "1/2-1/2";
  return flagged === "w" ? "0-1" : "1-0";
}

/** The mono start of a turn that began at wall time `tw`, read again after a reload (C2). */
export function startFromWall(tw: number, wallNow: number, monoNow: number): number {
  return monoNow - Math.max(0, wallNow - tw);
}

/** Below this the own clock is red and the low-time sound plays: 20 s, or 10 s in bullet. */
export function lowTimeMs(tc: TimeControl): number {
  return tc[0] + 40 * tc[1] < 180 ? 10_000 : 20_000;
}

const two = (n: number) => String(n).padStart(2, "0");

/** A clock as the strips show it: "4:58", "1:02:03", and with tenths under 20 s, "0:19.4". */
export function formatClock(ms: number): string {
  const left = Math.max(0, ms);
  if (left < 20_000) {
    const tenths = Math.floor(left / 100);
    return `0:${two(Math.floor(tenths / 10))}.${tenths % 10}`;
  }
  const s = Math.ceil(left / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** A clock in a PGN %clk comment: "h:mm:ss". */
export function clkText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** The time a move took, in the page's language: "3.2s", "1:05". */
export function formatSpent(ms: number, locale?: string): string {
  if (ms >= 60_000) return clkText(ms).replace(/^0:/, "");
  try {
    return new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "narrow", maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.floor(ms / 100) / 10);
  } catch {
    return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  }
}
