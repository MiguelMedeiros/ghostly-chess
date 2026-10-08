// covers: apps.chess
// Timed games between two controllers on a virtual clock (test/link.ts): monotonic and wall clocks injected, frames
// with latency, drops, rewrites (a modified client) and held sessions. The rules are C1-C9 in docs/protocol.md.
import { Chess } from "chess.js";
import { describe, expect, it, vi } from "vitest";
import { OWN_FEATURES } from "../src/game.ts";
import { pgnOfGame } from "../src/pgn.ts";
import { presetState } from "../src/setup.ts";
import { en } from "../src/strings.ts";
import { record, Link, play, timedGame, type Side } from "./link.ts";

// Minutes of virtual time, step by step.
vi.setConfig({ testTimeout: 60_000 });

const end = (side: Side) => side.game.view().end;
const clocks = (side: Side) => side.game.clocks()!;
const flags = (side: Side) => side.broker.kinds("flag");

describe("a 1|0 game", () => {
  it("ends on time when white lets its time run out: white flags itself, and both show the same result", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    // Plies 0 and 1 are untimed: no t on them, and both clocks still full.
    expect(white.broker.kinds("move")[0].t).toBeUndefined();
    expect(black.broker.kinds("move")[0].t).toBeUndefined();
    expect(clocks(white)).toMatchObject({ b: 60_000, running: "w" });
    expect(clocks(white).w).toBeGreaterThan(59_900);
    await link.advance(30_000);
    expect(clocks(white).w).toBeCloseTo(30_000, -2);
    expect(Math.abs(clocks(black).w - clocks(white).w)).toBeLessThanOrEqual(100);
    expect(white.game.view().canMove).toBe(true);
    await link.advance(31_000);
    for (const side of [white, black]) expect(end(side), side.name).toEqual({ result: "0-1", why: "time" });
    expect(flags(white)).toEqual([expect.objectContaining({ k: "flag", n: 2, by: "w" })]);
    expect(flags(black)).toEqual([]); // the self-flag came first: no claim
    expect(clocks(white).w).toBe(0);
    expect(record(white).x).toEqual({ why: "time", by: "w" });
    expect(record(black).x).toEqual({ why: "time", by: "w" });
  });

  it("acks each ply as it is applied, and every 2 s on its own turn, and saves nothing on a tick", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    const acks = white.broker.kinds("ack").length;
    const sets = white.broker.sets.length + black.broker.sets.length;
    await link.advance(10_000);
    expect(white.broker.kinds("ack").length - acks).toBeGreaterThanOrEqual(4);
    expect(white.broker.kinds("ack").length - acks).toBeLessThanOrEqual(5);
    expect(white.broker.kinds("ack").at(-1)).toMatchObject({ n: 2 });
    expect(black.broker.kinds("ack").length).toBe(1); // only on applying white's first ply
    // Ten seconds of a running clock wrote nothing.
    expect(white.broker.sets.length + black.broker.sets.length).toBe(sets);
  });

  it("is never offered alone, nor in an untimed game: no t and no ack", async () => {
    const link = new Link();
    const ana = await link.open(link.a);
    const bob = await link.open(link.b);
    await link.advance(100, 10);
    await ana.game.invite();
    await link.advance(100, 10);
    await bob.game.acceptInvitation();
    await link.advance(100, 10);
    const white = ana.game.view().me === "w" ? ana : bob;
    const black = white === ana ? bob : ana;
    for (const uci of ["e2e4", "e7e5", "g1f3", "b8c6"]) await play(link, white.game.view().turn === "w" ? white : black, uci);
    await link.advance(5000);
    for (const side of [ana, bob]) {
      expect(side.broker.kinds("ack")).toEqual([]);
      expect(side.broker.kinds("move").every((m) => !("t" in m))).toBe(true);
      expect(side.game.clocks()).toBeUndefined();
    }
  });
});

describe("a side away on its turn", () => {
  it("shows a pending claim while the mover is away past its time, and both end on time when it is back", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await link.advance(10_000);
    await link.close(white);
    await link.advance(60_000);
    // No proof can come while white is away: no claim, no result, the pending claim instead.
    expect(end(black)).toBeUndefined();
    expect(black.game.view().pendingClaim).toBe(true);
    expect(record(black).pc).toBe(2);
    expect(flags(black)).toEqual([]);
    expect(clocks(black)).toMatchObject({ w: 0, running: "w" });
    // White comes back: its clock ran while its Chess was closed (C2), it flags, and black takes it.
    const back = await link.open(link.a === white.broker ? link.a : link.b);
    await link.advance(500);
    for (const side of [back, black]) expect(end(side), side.name).toEqual({ result: "0-1", why: "time" });
    expect(black.game.view().pendingClaim).toBeUndefined();
  });

  it("keeps the clock running through a reload mid-turn, by the wall time", async () => {
    const { link, white, black } = await timedGame([180, 2]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await link.advance(10_000);
    await link.close(white);
    await link.advance(20_000);
    const back = await link.open(white.broker);
    // A new page: its monotonic clock started again, the wall time carried the turn.
    expect(clocks(back).w).toBeGreaterThan(149_000);
    expect(clocks(back).w).toBeLessThanOrEqual(150_000);
    await link.advance(5000);
    expect(clocks(back).w).toBeGreaterThan(144_000);
    expect(clocks(back).w).toBeLessThanOrEqual(145_000);
    await play(link, back, "g1f3");
    // 35 s spent, plus the 2 s increment.
    expect(record(back).k![2]).toBeGreaterThan(146_900);
    expect(record(back).k![2]).toBeLessThanOrEqual(147_000);
    expect(record(black).k![2]).toBe(record(back).k![2]);
    expect(end(black)).toBeUndefined();
  });
});

describe("a peer that holds its acks", () => {
  it("is clamped when it holds them until just before moving and reports t = P + I: E starts at this side's send", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    let acks = false;
    // White's modified client: no acks until it wants one, and a move that says no time went.
    white.broker.rewrite = (f) => (f.k === "ack" && !acks ? null : f.k === "move" && typeof f.t === "number" ? { ...f, t: 60_000 } : f);
    await link.advance(20_000);
    acks = true;
    await link.advance(2000);
    await play(link, white, "g1f3");
    // Black saw at least 22 s from its own send of e5 to the move: it keeps 60 - (22 - G) s, G being 300 ms (the one
    // round trip timed, white's ack of e5 before its client held them, took 20 ms).
    const kept = record(black).k![2];
    expect(kept).toBeGreaterThanOrEqual(60_000 - 22_100 + 300);
    expect(kept).toBeLessThanOrEqual(60_000 - 22_000 + 300);
    expect(black.notices).toContain("clock-off");
    expect(black.notices.filter((n) => n === "clock-off")).toHaveLength(1);
    expect(end(black)).toBeUndefined();
  });

  it("withheld acks: no claim is ever made, 'isn't answering' shows after 10 s, and the move is still bounded by its arrival", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    white.broker.rewrite = (f) => (f.k === "ack" ? null : f);
    const ts = record(black).ts;
    expect(ts).toBeDefined();
    await link.advance(9000);
    expect(black.game.view().peerSilent).toBeUndefined();
    // Meanwhile a bad frame every second does not count as an answer, and never moves ts.
    for (let i = 0; i < 6; i++) {
      black.broker.inject({ p: "chess", v: 2, k: "move", g: "zz" });
      await link.advance(1000);
    }
    expect(black.game.view().peerSilent).toBe(true);
    expect(record(black).ts).toBe(ts);
    await link.advance(30_000);
    expect(flags(black)).toEqual([]);
    // An honest move at 45 s: not clamped, the same time on both sides.
    await play(link, white, "g1f3");
    expect(record(black).k![2]).toBe(record(white).k![2]);
    expect(black.notices).not.toContain("clock-off");
    expect(black.game.view().peerSilent).toBeUndefined();
    expect(flags(black)).toEqual([]);
    // Then white lies about its next move: arrival - ts bounds it all the same.
    white.broker.rewrite = (f) => (f.k === "ack" ? null : f.k === "move" ? { ...f, t: record(white).k![2] } : f);
    await play(link, black, "b8c6");
    await link.advance(10_000);
    await play(link, white, "f1b5");
    expect(record(black).k![4]).toBeLessThanOrEqual(record(white).k![2] - 10_000 + 1000);
    expect(black.notices).toContain("clock-off");
    expect(flags(black)).toEqual([]);
  });
});

describe("claims", () => {
  it("ends 'clocks disagree' on both sides when the claimed side's clock shows at least G left, with PGN '*'", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    // Black's clock runs at twice the speed: it believes white is out of time long before white is.
    black.rate = 2;
    await link.advance(32_000);
    expect(flags(black)).toEqual([expect.objectContaining({ n: 2, by: "w" })]);
    expect(white.broker.kinds("dispute")).toEqual([expect.objectContaining({ n: 2 })]);
    for (const side of [white, black]) {
      expect(end(side), side.name).toEqual({ result: "*", why: "disputed" });
      expect(pgnOfGame(side.game)).toMatch(/\[Result "\*"\]/);
      expect(pgnOfGame(side.game)).toMatch(/\[Termination "unterminated"\]/);
      expect(pgnOfGame(side.game).trimEnd().endsWith("*")).toBe(true);
    }
  });

  it("holds a move that crosses a claim, and the mover's answer decides: accepted, the game ends on time at n and the move goes", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    // Black's frames take 3 s to reach white; white's are quick. White's turn starts 3 s after black's send.
    black.broker.latency = 3000;
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await link.advance(3000);
    // White moves with half a second left on its own clock: less than G (1 s), so it accepts the claim.
    await link.advance(59_500 - 100);
    expect(flags(black)).toEqual([expect.objectContaining({ n: 2, by: "w" })]);
    await play(link, white, "g1f3");
    expect(record(black).m).toHaveLength(2); // held, not applied
    await link.advance(4000);
    for (const side of [white, black]) {
      expect(end(side), side.name).toEqual({ result: "0-1", why: "time" });
      expect(record(side).m, side.name).toEqual(["e2e4", "e7e5"]);
    }
    expect(flags(white)).toEqual([expect.objectContaining({ n: 2, by: "w" })]);
  });

  it("holds a move that crosses a claim: refused, both end 'clocks disagree' at n, and the move goes on both", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    black.broker.latency = 3000;
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await link.advance(3000);
    // White's ack at 58 s of its turn reaches black 61 s after black's send: past P + G, a claim. White moves 1.3 s
    // before its time is up, by its own clock: at least G (1 s), so it disputes the claim that crossed its move.
    await link.advance(58_000 - 100);
    await link.advance(800);
    expect(white.game.clocks()!.w).toBeGreaterThan(1000);
    expect(flags(black)).toEqual([expect.objectContaining({ n: 2, by: "w" })]);
    await play(link, white, "g1f3");
    await link.advance(4000);
    expect(white.broker.kinds("dispute")).toHaveLength(1);
    for (const side of [white, black]) {
      expect(end(side), side.name).toEqual({ result: "*", why: "disputed" });
      expect(record(side).m, side.name).toEqual(["e2e4", "e7e5"]);
    }
  });
});

describe("clamping", () => {
  it("clamps a peer that reports more time than observed; a later sync.c cannot raise it, and the lists differ by exactly the clamp", async () => {
    const { link, white, black } = await timedGame([180, 2]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    // White's clock runs at half speed for this one move: it spends 20 s and counts 10.
    white.rate = 0.5;
    await link.advance(20_000);
    await play(link, white, "g1f3");
    white.rate = 1;
    expect(black.notices).toContain("clock-off");
    const reported = record(white).k![2];
    const kept = record(black).k![2];
    expect(reported).toBeCloseTo(180_000 - 10_000 + 2000, -2);
    expect(kept).toBeLessThan(reported);
    expect(kept).toBeLessThanOrEqual(180_000 - 20_000 + 2000 + 300 + 50);
    for (const uci of ["b8c6", "f1b5", "a7a6"]) {
      await link.advance(3000);
      await play(link, white.game.view().turn === "w" ? white : black, uci);
    }
    // A reconnect: white's sync carries c[w] from its own clock, and black's view stays where it was.
    await link.reconnect();
    await link.advance(1000);
    expect(record(black).k![2]).toBe(kept);
    const ws = white.game.spent();
    const bs = black.game.spent();
    expect(ws.length).toBe(bs.length);
    for (let i = 0; i < ws.length; i++) {
      if (i === 2) expect(bs[i]! - ws[i]!).toBe(reported - kept);
      else expect(bs[i], `ply ${i}`).toBe(ws[i]);
    }
  });
});

describe("catching up", () => {
  it("brings a lost move in a sync whose c[mover] is its t: both clocks agree, and both move lists show the same times", async () => {
    const { link, white, black } = await timedGame([300, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await link.advance(4000);
    white.broker.drop = (f) => f.k === "move";
    await play(link, white, "g1f3");
    white.broker.drop = null;
    expect(record(black).m).toHaveLength(2);
    await link.advance(3000);
    await link.reconnect();
    await link.advance(200);
    expect(record(black).m).toEqual(record(white).m);
    // The ply came in white's sync, whose c[w] is that move's t.
    const sync = white.broker.kinds("sync").at(-1)!;
    expect(sync.m).toBe("e2e4 e7e5 g1f3");
    expect((sync.c as number[])[0]).toBe(record(white).k![2]);
    expect(record(black).k).toEqual(record(white).k);
    expect(black.notices).not.toContain("clock-off");
    expect(flags(black)).toEqual([]);
    await link.advance(5000);
    expect(Math.abs(clocks(white).b - clocks(black).b)).toBeLessThanOrEqual(50);
    expect(clocks(white).w).toBe(clocks(black).w);
    await play(link, black, "b8c6");
    expect(white.game.spent()).toEqual(black.game.spent());
  });

  it("does not clamp or claim an honest move made during a 10 s session hold: the adopted ply is bounded by the last ack before it", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await link.advance(5000);
    link.hold(true);
    await link.advance(5000);
    await play(link, white, "g1f3"); // refused by the held session: kept by white
    expect(white.notices).toContain("send-failed");
    await link.advance(5000);
    link.hold(false);
    await link.reconnect();
    await link.advance(500);
    expect(record(black).m).toEqual(record(white).m);
    expect(record(black).k).toEqual(record(white).k);
    expect(black.notices).not.toContain("clock-off");
    expect(flags(black)).toEqual([]);
    expect(end(black)).toBeUndefined();
  });

  it("keeps the increments the same on both sides after 20 plies of 3|2", async () => {
    const { link, white, black } = await timedGame([180, 2]);
    const moves = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "c2c3", "g8f6", "d2d3", "d7d6", "e1g1", "e8g8", "a2a4", "a7a6", "b1d2", "c8e6", "c4e6", "f7e6", "d1b3", "d8d7"];
    let think = 700;
    for (const uci of moves) {
      think = (think * 7 + 1300) % 5000;
      await link.advance(think);
      await play(link, white.game.view().turn === "w" ? white : black, uci);
    }
    expect(record(white).k).toHaveLength(20);
    expect(record(black).k).toEqual(record(white).k);
    expect(white.game.spent()).toEqual(black.game.spent());
    // Each side: the base, plus 2 s for each timed move, less what it spent.
    const k = record(white).k!;
    const spent = white.game.spent();
    for (const [colour, last] of [
      ["w", 18],
      ["b", 19],
    ] as const) {
      const own = spent.filter((s, i) => i % 2 === (colour === "w" ? 0 : 1) && s !== undefined) as number[];
      expect(k[last], colour).toBe(180_000 + own.length * 2000 - own.reduce((a, s) => a + s, 0));
    }
    expect(black.notices).toEqual([]);
    expect(white.notices).toEqual([]);
  });
});

describe("an older contact", () => {
  it("never offers a 2.0.0 contact, which names no clock, a timed game", async () => {
    const link = new Link("2.1.0", "2.0.0");
    const ana = await link.open(link.a);
    const bob = await link.open(link.b, { features: [] });
    await link.advance(100, 10);
    expect(link.b.kinds("hello")[0].f).toEqual([]);
    expect(ana.game.view().features).toEqual([]);
    expect(presetState([300, 0], ana.game.view(), OWN_FEATURES, en)).toEqual({ enabled: false, reason: "Your contact needs to update Chess (they have 2.0.0)" });
    await ana.game.invite([300, 0]);
    await link.advance(100, 10);
    expect(link.a.kinds("seek")).toEqual([]);
    // Unlimited goes, and the game is untimed: no t, no ack, on either side.
    await ana.game.invite();
    await link.advance(100, 10);
    await bob.game.acceptInvitation();
    await link.advance(100, 10);
    const white = ana.game.view().me === "w" ? ana : bob;
    const black = white === ana ? bob : ana;
    for (const uci of ["e2e4", "e7e5", "g1f3"]) await play(link, white.game.view().turn === "w" ? white : black, uci);
    await link.advance(5000);
    for (const broker of [link.a, link.b]) {
      expect(broker.kinds("seek").every((f) => !("tc" in f))).toBe(true);
      expect(broker.kinds("ack")).toEqual([]);
      expect(broker.kinds("move").every((f) => !("t" in f))).toBe(true);
    }
  });
});

describe("the PGN of a timed game", () => {
  it("has TimeControl, a %clk after each move from ply 2, 'time forfeit', and loads back in chess.js", async () => {
    const { link, white, black } = await timedGame([300, 2]);
    for (const uci of ["e2e4", "e7e5", "g1f3", "b8c6"]) {
      await link.advance(1500);
      await play(link, white.game.view().turn === "w" ? white : black, uci);
    }
    await link.advance(301_000);
    expect(end(white)).toEqual({ result: "0-1", why: "time" });
    const pgn = pgnOfGame(black.game);
    expect(pgn).toContain('[TimeControl "300+2"]');
    expect(pgn).toContain('[Termination "time forfeit"]');
    expect(pgn).toMatch(/1\. e4 e5 2\. Nf3 \{\[%clk 0:05:00\]\} Nc6 \{\[%clk 0:05:00\]\} 0-1/);
    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.history()).toEqual(["e4", "e5", "Nf3", "Nc6"]);
    expect(chess.getComments().map((c) => c.comment)).toEqual(["[%clk 0:05:00]", "[%clk 0:05:00]"]);
  });
});
