// covers: apps.chess
// The clocks' pure model (src/clock.ts): increments, the grace, the checks on a reported t, the claim test, the
// result of a flag, and the formats the page and the PGN use.
import { describe, expect, it } from "vitest";
import {
  addSample,
  checkReported,
  clkText,
  clocksAfter,
  formatClock,
  formatSpent,
  grace,
  graceMax,
  incrementAt,
  lowTimeMs,
  mayClaim,
  PRESET_TCS,
  spentOn,
  startFromWall,
  timeBefore,
  timedPly,
  timeoutResult,
} from "../src/clock.ts";

describe("increments and the k list", () => {
  it("adds the increment from ply 2: plies 0 and 1 are untimed and carry no t", () => {
    const tc: [number, number] = [180, 2];
    expect([0, 1, 2, 3].map(timedPly)).toEqual([false, false, true, true]);
    expect([0, 1, 2, 3].map((n) => incrementAt(tc, n))).toEqual([0, 0, 2000, 2000]);
    // White spends 5 s on ply 2, black 1 s on ply 3, white 0.5 s on ply 4.
    const k = [180_000, 180_000];
    k[2] = timeBefore(tc, k, 2) - 5000 + incrementAt(tc, 2);
    k[3] = timeBefore(tc, k, 3) - 1000 + incrementAt(tc, 3);
    k[4] = timeBefore(tc, k, 4) - 500 + incrementAt(tc, 4);
    expect(k).toEqual([180_000, 180_000, 177_000, 181_000, 178_500]);
    expect(clocksAfter(tc, k)).toEqual([178_500, 181_000]);
    expect(clocksAfter(tc, k.slice(0, 4))).toEqual([177_000, 181_000]);
    expect(clocksAfter(tc, [])).toEqual([180_000, 180_000]);
    expect(k.map((_, i) => spentOn(tc, k, i))).toEqual([undefined, undefined, 5000, 1000, 500]);
  });

  it("adds up over a game: base + increments - time spent, for each side", () => {
    const tc: [number, number] = [300, 2];
    const k: number[] = [];
    const spent = [0, 0, 1200, 3400, 800, 7000, 2500, 900, 4000, 100];
    for (let n = 0; n < spent.length; n++) k[n] = timedPly(n) ? timeBefore(tc, k, n) - spent[n] + incrementAt(tc, n) : 300_000;
    const [w, b] = clocksAfter(tc, k);
    const sum = (colour: 0 | 1) => spent.filter((_, i) => i % 2 === colour && i >= 2).reduce((a, s) => a + s - 2000, 0);
    expect(w).toBe(300_000 - sum(0));
    expect(b).toBe(300_000 - sum(1));
  });

  it("are the presets 1|0, 3|2, 5|0, 10|0 and 30|0", () => {
    expect(PRESET_TCS.map((tc) => tc.join("|"))).toEqual(["60|0", "180|2", "300|0", "600|0", "1800|0"]);
  });
});

describe("a reported t (C5)", () => {
  const P = 60_000;
  const I = 2000;
  const G = 500;

  it("clamps a t above P + I to P + I", () => {
    expect(checkReported(P + I + 1, P, I, undefined, G)).toEqual({ view: P + I, clamped: true });
    expect(checkReported(P + I, P, I, undefined, G)).toEqual({ view: P + I, clamped: false });
    expect(checkReported(10_000, P, I, undefined, G)).toEqual({ view: 10_000, clamped: false });
  });

  it("clamps a time spent below E - G to E - G", () => {
    // Seen: 8 s from our send to the proof. Claimed spent: 2 s. Kept: 8 - 0.5 = 7.5 s spent.
    expect(checkReported(P + I - 2000, P, I, 8000, G)).toEqual({ view: P + I - 7500, clamped: true });
    // Spent at least E - G: unchanged.
    expect(checkReported(P + I - 7500, P, I, 8000, G)).toEqual({ view: P + I - 7500, clamped: false });
    expect(checkReported(P + I - 9000, P, I, 8000, G)).toEqual({ view: P + I - 9000, clamped: false });
    // Both: a t above P + I, then the bound.
    expect(checkReported(P + I + 5000, P, I, 8000, G)).toEqual({ view: P + I - 7500, clamped: true });
  });

  it("may give a view at or below 0, which is a claim and never a refusal", () => {
    const { view } = checkReported(P + I, P, I, P + I + G + 1000, G);
    expect(view).toBeLessThanOrEqual(0);
    expect(mayClaim(undefined, P, G, view)).toBe(true);
  });
});

describe("the grace (C3)", () => {
  it("is Gmax before any sample: 1 s under 3 minutes of base, 2 s otherwise", () => {
    expect(grace([], [60, 0])).toBe(1000);
    expect(grace([], [179, 5])).toBe(1000);
    expect(grace([], [180, 0])).toBe(2000);
    expect(grace([], [1800, 0])).toBe(2000);
    expect(graceMax([60, 0])).toBe(1000);
  });

  it("is twice the median of the last 5 round trips, within [300 ms, Gmax]", () => {
    expect(grace([40], [300, 0])).toBe(300);
    expect(grace([200, 400, 300], [300, 0])).toBe(600);
    expect(grace([200, 400, 300, 500], [300, 0])).toBe(700);
    expect(grace([5000, 5000, 5000], [300, 0])).toBe(2000);
    expect(grace([5000, 5000, 5000], [60, 0])).toBe(1000);
    // Only the last 5 count: five quick ones after slow ones.
    let samples: number[] = [];
    for (const s of [9000, 9000, 9000, 100, 100, 100, 100, 100]) samples = addSample(samples, s);
    expect(samples).toHaveLength(5);
    expect(grace(samples, [300, 0])).toBe(300);
    for (let i = 0; i < 50; i++) samples = addSample(samples, Math.random() * 10_000);
    const g = grace(samples, [300, 0]);
    expect(g).toBeGreaterThanOrEqual(300);
    expect(g).toBeLessThanOrEqual(2000);
  });
});

describe("the claim test (C7)", () => {
  const P = 30_000;
  const G = 1000;

  it("needs a proof (an ack holding n) that arrived when E > P + G", () => {
    expect(mayClaim(P + G + 1, P, G)).toBe(true);
    expect(mayClaim(P + G, P, G)).toBe(false);
    expect(mayClaim(P, P, G)).toBe(false);
  });

  it("or this side's clamped view of the mover at or below 0", () => {
    expect(mayClaim(undefined, P, G, 0)).toBe(true);
    expect(mayClaim(undefined, P, G, -5)).toBe(true);
    expect(mayClaim(undefined, P, G, 1)).toBe(false);
  });

  it("never claims on wall time alone: no proof, no view, no claim", () => {
    expect(mayClaim(undefined, P, G)).toBe(false);
    expect(mayClaim(undefined, 0, G)).toBe(false);
  });
});

describe("a flag (C6)", () => {
  it("is a draw against K, K+B or K+N, and a loss against K+R, K+P or more", () => {
    expect(timeoutResult("w", ["k"])).toBe("1/2-1/2");
    expect(timeoutResult("w", ["k", "b"])).toBe("1/2-1/2");
    expect(timeoutResult("b", ["n", "k"])).toBe("1/2-1/2");
    expect(timeoutResult("w", ["k", "r"])).toBe("0-1");
    expect(timeoutResult("b", ["k", "p"])).toBe("1-0");
    expect(timeoutResult("w", ["k", "n", "n"])).toBe("0-1");
    expect(timeoutResult("b", ["k", "b", "b"])).toBe("1-0");
  });
});

describe("the times shown", () => {
  it("shows m:ss, h:mm:ss, and tenths under 20 s", () => {
    expect(formatClock(300_000)).toBe("5:00");
    expect(formatClock(299_001)).toBe("5:00");
    expect(formatClock(61_000)).toBe("1:01");
    expect(formatClock(20_000)).toBe("0:20");
    expect(formatClock(19_999)).toBe("0:19.9");
    expect(formatClock(9_050)).toBe("0:09.0");
    expect(formatClock(0)).toBe("0:00.0");
    expect(formatClock(-50)).toBe("0:00.0");
    expect(formatClock(3_723_000)).toBe("1:02:03");
  });

  it("writes PGN clocks as h:mm:ss, and a move's time in the page's language", () => {
    expect(clkText(298_400)).toBe("0:04:58");
    expect(clkText(3_723_999)).toBe("1:02:03");
    expect(formatSpent(3240, "en")).toBe("3.2s");
    expect(formatSpent(65_000, "en")).toBe("1:05");
    expect(formatSpent(3240, "pt")).toMatch(/^3,2\s?s$/);
  });

  it("warns at 20 s, or 10 s in bullet", () => {
    expect(lowTimeMs([60, 0])).toBe(10_000);
    expect(lowTimeMs([180, 2])).toBe(20_000);
    expect(lowTimeMs([600, 0])).toBe(20_000);
  });

  it("restarts a turn from the wall time it began at", () => {
    expect(startFromWall(1000, 6000, 100_000)).toBe(95_000);
    // A wall clock set back never makes the turn start in the future.
    expect(startFromWall(9000, 6000, 100_000)).toBe(100_000);
  });
});
