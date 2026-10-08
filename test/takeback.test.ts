// covers: apps.chess
// Takebacks (the "takeback" feature, 2.2.0): an ask undoes the asker's last move, one ply or two; on accept both sides
// cut the moves and restore both clocks from k; the epoch tb in sync recovers an accept the asker never got.
import { describe, expect, it, vi } from "vitest";
import type { SavedGame } from "../src/game.ts";
import { clocksAfter } from "../src/clock.ts";
import { encodeMessage, type Message } from "../src/protocol.ts";
import { open, play, settle, startChat, type Side } from "./sides.ts";
import { play as playTimed, record, timedGame, WALL0 } from "./link.ts";

vi.setConfig({ testTimeout: 30_000 });

const saved = (side: Side) => JSON.parse(side.broker.stored.get("game")!) as SavedGame;
const sent = (side: Side, k: string) => side.broker.sent.filter((f) => (f as { k?: string }).k === k) as Record<string, unknown>[];
async function from(side: Side, ...messages: Message[]): Promise<void> {
  for (const message of messages) side.broker.inject(encodeMessage(message));
  await settle(side);
}

describe("a takeback", () => {
  it("undoes one ply when asked before the contact replied", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3");
    expect(white.game.view().canTakeback).toBe(true);
    await white.game.takeback();
    await settle(white, black);
    expect(sent(white, "takeback")).toEqual([expect.objectContaining({ n: 2, o: "ask", h: 3 })]);
    expect(white.game.view().takeback).toBe("me");
    expect(black.game.view().takeback).toBe("peer");
    await black.game.answerTakeback(true);
    await settle(white, black);
    for (const side of [white, black]) {
      expect(saved(side).m).toEqual(["e2e4", "e7e5"]);
      expect(saved(side).tb).toBe(1);
      expect(saved(side).q).toBeUndefined();
      expect(side.game.view().takeback).toBeUndefined();
      expect(side.notices).toEqual(["taken-back"]);
    }
    expect(white.game.view().canMove).toBe(true);
    // The game goes on from there.
    await play(sides, "d2d4");
    expect(saved(black).m).toEqual(["e2e4", "e7e5", "d2d4"]);
  });

  it("undoes two plies when asked after the contact replied", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3", "b8c6");
    await white.game.takeback();
    await settle(white, black);
    expect(sent(white, "takeback")).toEqual([expect.objectContaining({ n: 2, o: "ask" })]);
    await black.game.answerTakeback(true);
    await settle(white, black);
    for (const side of [white, black]) expect(saved(side).m).toEqual(["e2e4", "e7e5"]);
    expect(white.game.view().turn).toBe("w");
    expect(white.game.view().canMove).toBe(true);
  });

  it("keeps the game as it was when declined, and the asker may not ask again until it moves", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3");
    const before = JSON.stringify(saved(black));
    await white.game.takeback();
    await settle(white, black);
    await black.game.answerTakeback(false);
    await settle(white, black);
    expect(JSON.stringify(saved(black))).toBe(before);
    expect(saved(white).m).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(saved(white).q).toBeUndefined();
    expect(white.notices).toEqual(["takeback-declined"]);
    // One ask per own move.
    expect(white.game.view().canTakeback).toBe(false);
    await play(sides, "b8c6", "f1c4");
    expect(white.game.view().canTakeback).toBe(true);
  });

  it("lapses on any move, and ignores a stale ask (an old n) after a move", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3");
    await white.game.takeback();
    await settle(white, black);
    // Black moves instead of answering: the ask lapses on both sides.
    await play(sides, "b8c6");
    expect(white.game.view().takeback).toBeUndefined();
    expect(black.game.view().takeback).toBeUndefined();
    expect(saved(white).q).toBeUndefined();
    const g = saved(black).g;
    // The same ask again, and asks naming plies that are not White's last move: none is shown.
    await from(black, { k: "takeback", g, n: 2, o: "ask", h: 3 }, { k: "takeback", g, n: 0, o: "ask", h: 4 }, { k: "takeback", g, n: 3, o: "ask", h: 4 });
    expect(black.game.view().takeback).toBeUndefined();
    // An accept for an ask White no longer holds changes nothing.
    const before = JSON.stringify(saved(white));
    await from(white, { k: "takeback", g, n: 2, o: "accept" });
    expect(JSON.stringify(saved(white))).toBe(before);
  });

  it("is not offered before this side has moved, nor to a contact whose Chess has no takebacks", async () => {
    const sides = await startChat();
    expect(sides.white.game.view().canTakeback).toBe(false);
    expect(sides.black.game.view().canTakeback).toBe(false);
    await play(sides, "e2e4");
    expect(sides.white.game.view().canTakeback).toBe(true);
    // The contact's hello now names no takeback (a 2.1.0): off, and its asks are ignored.
    await from(sides.white, { k: "hello", pv: 2, f: ["clock"] });
    expect(sides.white.game.view().canTakeback).toBe(false);
    await from(sides.white, { k: "takeback", g: saved(sides.white).g, n: 1, o: "ask", h: 1 });
    expect(sides.white.game.view().takeback).toBeUndefined();
  });

  it("goes again when the asker's accept was lost as it closed: its next sync has the older tb, and the accept and a sync answer it", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3");
    await white.game.takeback();
    await settle(white, black);
    // Black accepts; White's Chess closes before the accept arrives, so it is lost.
    await black.game.answerTakeback(true);
    white.game.stop();
    white.broker.shutdown();
    await settle(black);
    expect(saved(black).m).toEqual(["e2e4", "e7e5"]);
    expect(saved(white).m).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(saved(white).q).toBe(2);
    const accepts = sent(black, "takeback").length;
    const back = await open(white.broker);
    await settle(back, black);
    for (const side of [back, black]) {
      expect(saved(side).m).toEqual(["e2e4", "e7e5"]);
      expect(saved(side).tb).toBe(1);
      expect(side.game.view().phase).toBe("playing");
    }
    expect(saved(back).q).toBeUndefined();
    // Black answered White's older tb with the accept again.
    expect(sent(black, "takeback").slice(accepts)).toContainEqual(expect.objectContaining({ n: 2, o: "accept" }));
  });

  it("answers a sync with the older tb with the accept and a sync, and the asker that holds q applies it", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3");
    await white.game.takeback();
    await settle(white, black);
    // Black accepts while White's side is scripted from here: White never hears it.
    white.game.stop();
    await black.game.answerTakeback(true);
    await settle(black);
    const w = saved(white);
    const count = black.broker.sent.length;
    // White's sync, as it would send it on its next open: its moves, and tb 0.
    await from(black, { k: "sync", g: w.g, s: [w.s[0], w.s[1]], m: w.m });
    const answer = black.broker.sent.slice(count) as Record<string, unknown>[];
    expect(answer.map((f) => f.k)).toEqual(["takeback", "sync"]);
    expect(answer[0]).toMatchObject({ o: "accept", n: 2 });
    expect(answer[1]).toMatchObject({ tb: 1, m: "e2e4 e7e5" });
    expect(black.notices).toEqual(["taken-back"]);
    // White's Chess, opened again, still holds q: the accept applies.
    const back = await open(white.broker);
    await settle(back, black);
    expect(saved(back).m).toEqual(["e2e4", "e7e5"]);
    expect(saved(back).tb).toBe(1);
  });

  it("answers the older tb also when the game ended since the accept: the asker takes the takeback, then the end", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3");
    await white.game.takeback();
    await settle(white, black);
    white.game.stop();
    await black.game.answerTakeback(true);
    await black.game.resign();
    await settle(black);
    const w = saved(white);
    const count = black.broker.sent.length;
    await from(black, { k: "sync", g: w.g, s: [w.s[0], w.s[1]], m: w.m });
    expect(black.game.view().phase).toBe("over");
    expect((black.broker.sent.slice(count) as Record<string, unknown>[]).map((f) => f.k)).toEqual(["takeback", "sync"]);
    const back = await open(white.broker);
    await settle(back, black);
    expect(saved(back).m).toEqual(["e2e4", "e7e5"]);
    expect(back.game.view().end).toEqual({ result: "1-0", why: "resign" });
  });

  it("is out of step on a sync with a higher tb and no matching ask", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3");
    const b = saved(black);
    await from(white, { k: "sync", g: b.g, s: [b.s[0], b.s[1]], m: ["e2e4", "e7e5"], tb: 1 });
    expect(white.game.view().phase).toBe("out-of-step");
    expect(saved(white).m).toEqual(["e2e4", "e7e5", "g1f3"]);
  });
});

describe("a takeback that crosses another frame", () => {
  it("is stale at the contact when the contact's move crossed it: n alone would read as a newer two-ply ask", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3");
    // White asks (one ply back, to 2) as Black plays Nc6: the ask reaches Black at 4 plies, where a two-ply ask by White
    // would also name n = 2. It names the plies White held (3), so Black ignores it.
    await Promise.all([white.game.takeback(), black.game.move("b8", "c6")]);
    await settle(white, black);
    for (const side of [white, black]) {
      expect(saved(side).m).toEqual(["e2e4", "e7e5", "g1f3", "b8c6"]);
      expect(saved(side).tb).toBeUndefined();
      expect(saved(side).q).toBeUndefined();
      expect(side.game.view().takeback).toBeUndefined();
    }
    // The game goes on, in step.
    await play(sides, "f1c4", "g8f6");
    for (const side of [white, black]) {
      expect(saved(side).m).toHaveLength(6);
      expect(side.notices).toEqual([]);
    }
  });

  it("is stale when the asker reopens after the contact moved: its ask goes again, naming the plies it held", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3");
    await white.game.takeback();
    await settle(white, black);
    white.game.stop();
    white.broker.shutdown();
    await settle(black);
    // Black moves while White's Chess is closed (it goes in Black's next sync).
    expect(await black.game.move("b8", "c6")).toBe(true);
    await settle(black);
    const back = await open(white.broker);
    await settle(back, black);
    expect(sent(back, "takeback")).toContainEqual(expect.objectContaining({ n: 2, o: "ask", h: 3 }));
    for (const side of [back, black]) {
      expect(saved(side).m).toEqual(["e2e4", "e7e5", "g1f3", "b8c6"]);
      expect(side.game.view().takeback).toBeUndefined();
    }
    await play({ white: back, black }, "f1c4", "g8f6");
    expect(saved(black).m).toHaveLength(6);
    expect([...back.notices, ...black.notices]).toEqual([]);
  });

  it("holds the asker's move, resignation and abort until the ask is answered, so none crosses the accept", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3", "b8c6");
    // A two-ply ask, on White's own turn.
    await white.game.takeback();
    await settle(white, black);
    expect(white.game.view().canMove).toBe(false);
    const [moved] = await Promise.all([white.game.move("f1", "c4"), black.game.answerTakeback(true)]);
    expect(moved).toBe(false);
    await settle(white, black);
    for (const side of [white, black]) {
      expect(saved(side).m).toEqual(["e2e4", "e7e5"]);
      expect(saved(side).tb).toBe(1);
      expect(side.notices).toEqual(["taken-back"]);
    }
    expect(white.game.view().canMove).toBe(true);
    // A resignation waits too, and goes once the ask is answered.
    await play(sides, "g1f3", "b8c6");
    await white.game.takeback();
    await settle(white, black);
    await white.game.resign();
    expect(saved(white).x).toBeUndefined();
    await black.game.answerTakeback(false);
    await settle(white, black);
    await white.game.resign();
    await settle(white, black);
    for (const side of [white, black]) {
      expect(saved(side).m).toEqual(["e2e4", "e7e5", "g1f3", "b8c6"]);
      expect(side.game.view().end).toEqual({ result: "0-1", why: "resign" });
    }
  });

  it("holds an abort while the ask waits", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4");
    await white.game.takeback();
    await settle(white, black);
    expect(white.game.view().canAbort).toBe(true);
    await white.game.abort();
    expect(saved(white).x).toBeUndefined();
    await black.game.answerTakeback(true);
    await settle(white, black);
    for (const side of [white, black]) expect(saved(side).m).toEqual([]);
  });

  it("lets the ask that goes further back stand when both ask at once, on both sides alike", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3");
    // White asks back to 2; Black, on its turn, asks back to 1 (its e7e5 and White's reply).
    await Promise.all([white.game.takeback(), black.game.takeback()]);
    await settle(white, black);
    expect(white.game.view().takeback).toBe("peer");
    expect(black.game.view().takeback).toBe("me");
    await white.game.answerTakeback(true);
    await settle(white, black);
    for (const side of [white, black]) {
      expect(saved(side).m).toEqual(["e2e4"]);
      expect(saved(side).tb).toBe(1);
      expect(side.game.view().takeback).toBeUndefined();
    }
    expect(black.game.view().canMove).toBe(true);
  });

  it("lapses when the contact's Chess closes, so the asker may play on while it is away", async () => {
    const sides = await startChat();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5", "g1f3", "b8c6");
    await white.game.takeback();
    await settle(white, black);
    black.game.stop();
    black.broker.shutdown();
    await settle(white);
    expect(saved(white).q).toBeUndefined();
    expect(white.game.view().takeback).toBeUndefined();
    expect(await white.game.move("f1", "c4")).toBe(true);
    const b = await open(black.broker);
    await settle(white, b);
    expect(saved(b).m).toEqual(["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"]);
    expect(b.game.view().takeback).toBeUndefined();
  });
});

describe("a takeback in a timed game", () => {
  const clamp = (side: Parameters<typeof record>[0]) => record(side) as { ko?: number; kj?: number };

  it("keeps a clamp on a ply it does not take back, and drops it with the clamped ply (C5)", async () => {
    for (const past of [false, true]) {
      const { link, white, black } = await timedGame([180, 0]);
      await playTimed(link, white, "e2e4");
      await playTimed(link, black, "e7e5");
      // White's client reports no time spent on ply 2: Black clamps it, and keeps the clamp as ko.
      white.broker.rewrite = (f) => (f.k === "move" && typeof f.t === "number" ? { ...f, t: 180_000 } : f);
      await link.advance(10_000);
      await playTimed(link, white, "g1f3");
      white.broker.rewrite = null;
      expect(clamp(black).ko).toBeGreaterThan(9_000);
      expect(clamp(black).kj).toBe(2);
      const ko = clamp(black).ko;
      await link.advance(1_000);
      await playTimed(link, black, "b8c6");
      if (!past) {
        await link.advance(1_000);
        await playTimed(link, white, "f1c4");
      }
      // Asked after White's own move (back to 4 plies, the clamp stays), or after Black's reply (back to 2, it goes).
      await white.game.takeback();
      await link.advance(100);
      await black.game.answerTakeback(true);
      await link.advance(100);
      expect(record(black).m).toHaveLength(past ? 2 : 4);
      expect(clamp(black).ko).toBe(past ? undefined : ko);
      if (past) expect(clamp(black).kj).toBeUndefined();
      else expect(clamp(black).kj).toBe(2);
    }
  });

  it("never flags the asker itself while its ask waits: the contact's claim ends the game, alike on both sides", async () => {
    const { link, white, black } = await timedGame([15, 0]);
    await playTimed(link, white, "e2e4");
    await playTimed(link, black, "e7e5");
    await playTimed(link, white, "g1f3");
    await playTimed(link, black, "b8c6");
    // A two-ply ask on White's own turn; Black does not answer, and White's 15 s run out.
    await white.game.takeback();
    await link.advance(100);
    expect(black.game.view().takeback).toBe("peer");
    expect(white.broker.kinds("flag")).toEqual([]);
    await link.advance(20_000, 250);
    for (const side of [white, black]) {
      expect(record(side).m).toEqual(["e2e4", "e7e5", "g1f3", "b8c6"]);
      expect(side.game.view().end).toEqual({ result: "0-1", why: "time" });
    }
    // White's flag answers Black's claim; White sent none of its own before it.
    const flags = [...white.broker.sent, ...black.broker.sent].map((s) => s.frame).filter((f) => f.k === "flag");
    expect(flags[0]).toMatchObject({ by: "w", n: 4 });
    expect(black.broker.sent.map((s) => s.frame.k)).toContain("flag");
  });

  it("answers a replayed sync with the older tb at most once a second, and our bound on the asker moves only once", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    await playTimed(link, white, "e2e4");
    await playTimed(link, black, "e7e5");
    await link.advance(1_000);
    await playTimed(link, white, "g1f3");
    const before = JSON.parse(white.broker.stored.get("game")!) as SavedGame;
    await white.game.takeback();
    await link.advance(100);
    await black.game.answerTakeback(true);
    await link.advance(100);
    // White's page is now a script: open, but silent, replaying its sync from before the takeback.
    white.game.stop();
    link.sides.splice(link.sides.indexOf(white), 1);
    const replay = encodeMessage({ k: "sync", g: before.g, s: [before.s[0], before.s[1]], m: before.m, tc: [60, 0] });
    const count = black.broker.sent.length;
    black.broker.inject(replay);
    black.broker.inject(replay);
    await link.advance(100);
    const answered = black.broker.sent.slice(count).map((s) => s.frame.k);
    expect(answered.filter((k) => k === "takeback")).toHaveLength(1);
    const ts = record(black).ts;
    for (let i = 0; i < 9; i++) {
      black.broker.inject(replay);
      await link.advance(10_000, 500);
    }
    // ts stayed at the first answer, and White's time ran out in Black's view: a pending claim, as without replays.
    expect(record(black).ts).toBe(ts);
    expect(record(black).pc).toBe(2);
  });

  it("restores both clocks from k for that ply, and the side to move's timer starts at the accept", async () => {
    const { link, white, black } = await timedGame([180, 2]);
    await playTimed(link, white, "e2e4");
    await playTimed(link, black, "e7e5");
    await link.advance(5_000);
    await playTimed(link, white, "g1f3");
    await link.advance(7_000);
    await playTimed(link, black, "b8c6");
    await link.advance(3_000);
    await playTimed(link, white, "f1c4");
    const k = record(white).k!;
    await white.game.takeback();
    await link.advance(4_000);
    await black.game.answerTakeback(true);
    const acceptAt = link.clock.now;
    await link.advance(30, 10);
    // White asked after its own move: one ply back, to 4 plies; both hold k for them, and the clocks they make.
    const expected = clocksAfter([180, 2], k.slice(0, 4));
    for (const side of [white, black]) {
      expect(record(side).m).toHaveLength(4);
      expect(record(side).k).toEqual(k.slice(0, 4));
      expect(side.game.clocks()!.b).toBe(expected[1]);
    }
    // White's turn runs from the accept: 30 ms on, on both screens (Black's from its own accept).
    expect(expected[0] - white.game.clocks()!.w).toBeLessThanOrEqual(40);
    expect(expected[0] - black.game.clocks()!.w).toBeLessThanOrEqual(40);
    expect(record(white).tw).toBe(WALL0 + acceptAt + 10);
    expect(record(black).ts).toBe(WALL0 + acceptAt);
    await link.advance(2_000);
    expect(expected[0] - white.game.clocks()!.w).toBeGreaterThanOrEqual(2_000);
    expect(expected[0] - white.game.clocks()!.w).toBeLessThanOrEqual(2_100);
    expect(Math.abs(white.game.clocks()!.w - black.game.clocks()!.w)).toBeLessThanOrEqual(50);
    // And the game goes on, timed.
    await playTimed(link, white, "f1b5");
    expect(record(black).m.at(-1)).toBe("f1b5");
    expect(white.notices.filter((n) => n !== "taken-back")).toEqual([]);
    expect(black.notices.filter((n) => n !== "taken-back")).toEqual([]);
  });
});

