// covers: apps.chess
// Two ends that cross (each side ends the game before the other's end reaches it) settle to one result on both
// sides, live and after a reconnect: docs/protocol.md, "Ends that cross". Two controllers on the virtual-clock link
// (test/link.ts), frames 10 ms on their way.
import { describe, expect, it, vi } from "vitest";
import { OWN_FEATURES } from "../src/game.ts";
import { settleEnd, type GameEnd, type TimeControl } from "../src/protocol.ts";
import { record, type Link, play, timedGame, type Side } from "./link.ts";

vi.setConfig({ testTimeout: 60_000 });

const end = (side: Side) => side.game.view().end;
const syncs = (side: Side) => side.broker.kinds("sync").length;
/** A Chess from before the rule (2.3.1): it names no "settle", and keeps its own end. */
const OLD = OWN_FEATURES.filter((f) => f !== "settle");

/** Time goes by with no tick on either side. */
function elapse(link: Link, ms: number): void {
  link.clock.now += ms;
  for (const s of link.sides) s.mono += ms * s.rate;
}

/** A game at ply 2 (white to move). `old`: that colour's Chess is reopened as one from before the rule. */
async function atPly2(tc: TimeControl, old?: "w" | "b") {
  const { link, white, black } = await timedGame(tc);
  await play(link, white, "e2e4");
  await play(link, black, "e7e5");
  if (!old) return { link, white, black };
  const side = old === "w" ? white : black;
  await link.close(side);
  const reopened = await link.open(side.broker, { features: OLD });
  await link.advance(100);
  return old === "w" ? { link, white: reopened, black } : { link, white, black: reopened };
}

type Crossing = (link: Link, white: Side, black: Side) => Promise<void>;

/** Black offers a draw; white accepts it as black resigns. */
const drawVsResign: Crossing = async (link, white, black) => {
  await black.game.offerDraw();
  await link.advance(100, 10);
  expect(white.game.view().drawOffer).toBe("peer");
  await Promise.all([white.game.answerDraw(true), black.game.resign()]);
};

/** Both resign at once, on white's turn. */
const bothResign: Crossing = async (_link, white, black) => {
  await Promise.all([white.game.resign(), black.game.resign()]);
};

/** 1|0: white resigns on black's turn as black's time runs out (black's flag goes on the same tick). */
const resignVsFlag: Crossing = async (link, white, black) => {
  await play(link, white, "g1f3");
  elapse(link, 61_000);
  await Promise.all([white.game.resign(), black.game.tick()]);
};

const cases: { name: string; tc: TimeControl; cross: Crossing; settled: { result: string; why: string }; x: unknown }[] = [
  { name: "a draw accepted as the offerer resigns", tc: [300, 0], cross: drawVsResign, settled: { result: "1-0", why: "resign" }, x: { why: "resign", by: "b" } },
  { name: "both resigning at once", tc: [300, 0], cross: bothResign, settled: { result: "0-1", why: "resign" }, x: { why: "resign", by: "w" } },
  { name: "a resignation as the contact's flag falls (1|0)", tc: [60, 0], cross: resignVsFlag, settled: { result: "1-0", why: "time" }, x: { why: "time", by: "b" } },
];

describe("settleEnd", () => {
  const ends: GameEnd[] = [
    { why: "time", by: "w" },
    { why: "time", by: "b" },
    { why: "resign", by: "w" },
    { why: "resign", by: "b" },
    { why: "aborted" },
    { why: "disputed" },
    { why: "agreed" },
  ];

  it("picks the same end whichever side's own it is", () => {
    for (const plies of [0, 1, 2, 3, 40])
      for (const a of ends) for (const b of ends) expect(settleEnd(a, b, plies), `${JSON.stringify([a, b, plies])}`).toEqual(settleEnd(b, a, plies));
  });

  it("puts time first, then a resignation, an abort, clocks disagree, and an agreed draw last", () => {
    expect(settleEnd({ why: "resign", by: "w" }, { why: "time", by: "b" }, 3)).toEqual({ why: "time", by: "b" });
    expect(settleEnd({ why: "agreed" }, { why: "resign", by: "b" }, 2)).toEqual({ why: "resign", by: "b" });
    expect(settleEnd({ why: "agreed" }, { why: "time", by: "w" }, 2)).toEqual({ why: "time", by: "w" });
    expect(settleEnd({ why: "aborted" }, { why: "resign", by: "w" }, 1)).toEqual({ why: "resign", by: "w" });
    expect(settleEnd({ why: "agreed" }, { why: "aborted" }, 1)).toEqual({ why: "aborted" });
    expect(settleEnd({ why: "agreed" }, { why: "disputed" }, 4)).toEqual({ why: "disputed" });
  });

  it("of two resignations keeps the one of the side to move", () => {
    expect(settleEnd({ why: "resign", by: "w" }, { why: "resign", by: "b" }, 2)).toEqual({ why: "resign", by: "w" });
    expect(settleEnd({ why: "resign", by: "w" }, { why: "resign", by: "b" }, 3)).toEqual({ why: "resign", by: "b" });
  });
});

describe("two ends that cross", () => {
  for (const c of cases) {
    it(`settle to one result on both sides: ${c.name}`, async () => {
      const { link, white, black } = await atPly2(c.tc);
      await c.cross(link, white, black);
      await link.advance(1000);
      for (const side of [white, black]) expect(end(side), side.name).toEqual(c.settled);
      expect(record(white).x).toEqual(c.x);
      expect(record(black).x).toEqual(c.x);
      expect(record(white).m).toEqual(record(black).m);
      // Settled for good: a reconnect sends the openings, nothing else, and changes nothing.
      const before = [syncs(white), syncs(black)];
      await link.reconnect();
      await link.advance(3000);
      for (const side of [white, black]) expect(end(side), `${side.name} after a reconnect`).toEqual(c.settled);
      expect([syncs(white) - before[0], syncs(black) - before[1]]).toEqual([1, 1]);
    });

    it(`settle on a reconnect when neither end got through live: ${c.name}`, async () => {
      const { link, white, black } = await atPly2(c.tc);
      const ends = (f: Record<string, unknown>) => f.k === "resign" || f.k === "draw" || f.k === "flag";
      white.broker.drop = black.broker.drop = (f) => ends(f) && f.o !== "offer";
      await c.cross(link, white, black);
      await link.advance(1000);
      // Each side holds its own end: neither heard the other's.
      expect(end(white)).toBeDefined();
      expect(end(black)).toBeDefined();
      white.broker.drop = black.broker.drop = null;
      await link.reconnect();
      await link.advance(3000);
      for (const side of [white, black]) expect(end(side), side.name).toEqual(c.settled);
      expect(record(white).x).toEqual(c.x);
      expect(record(black).x).toEqual(c.x);
      // And the syncs stop: a few seconds more send nothing.
      const before = [syncs(white), syncs(black)];
      await link.advance(5000);
      expect([syncs(white), syncs(black)]).toEqual(before);
    });
  }

  it("settle after a reload of each side: the result is kept", async () => {
    const { link, white, black } = await atPly2([300, 0]);
    await bothResign(link, white, black);
    await link.advance(1000);
    const [wb, bb] = [white.broker, black.broker];
    await link.close(white);
    await link.close(black);
    const w2 = await link.open(wb);
    const b2 = await link.open(bb);
    await link.advance(2000);
    for (const side of [w2, b2]) expect(end(side), side.name).toEqual({ result: "0-1", why: "resign" });
  });

  it("change nothing when they do not cross: a resignation alone, then a reconnect", async () => {
    const { link, white, black } = await atPly2([300, 0]);
    await black.game.resign();
    await link.advance(1000);
    for (const side of [white, black]) expect(end(side), side.name).toEqual({ result: "1-0", why: "resign" });
    const before = [syncs(white), syncs(black)];
    await link.reconnect();
    await link.advance(3000);
    for (const side of [white, black]) expect(end(side), side.name).toEqual({ result: "1-0", why: "resign" });
    expect([syncs(white) - before[0], syncs(black) - before[1]]).toEqual([1, 1]);
    expect(white.notices).toEqual([]);
    expect(black.notices).toEqual([]);
  });

  it("change nothing when they do not cross: a draw accepted, then the offerer's late resign is no end", async () => {
    const { link, white, black } = await atPly2([300, 0]);
    await black.game.offerDraw();
    await link.advance(100, 10);
    await white.game.answerDraw(true);
    await link.advance(1000);
    await black.game.resign(); // the game is over: nothing happens
    await link.advance(1000);
    for (const side of [white, black]) expect(end(side), side.name).toEqual({ result: "1/2-1/2", why: "agreed" });
    expect(black.broker.kinds("resign")).toEqual([]);
  });

  it("never take an end the contact could not have reached: a sync naming our own resignation is refused", async () => {
    const { link, white, black } = await atPly2([300, 0]);
    await black.game.resign();
    await link.advance(1000);
    // Black's Chess, modified, says white resigned: a sync claiming white's resignation is a bad message on white.
    black.broker.rewrite = (f) => (f.k === "sync" ? { ...f, x: { why: "resign", by: "w" } } : f);
    await link.reconnect();
    await link.advance(3000);
    expect(end(white)).toEqual({ result: "1-0", why: "resign" });
    expect(record(white).x).toEqual({ why: "resign", by: "b" });
    expect(white.notices).toContain("bad-message");
    // Nothing goes back and forth over it.
    const before = [syncs(white), syncs(black)];
    await link.advance(5000);
    expect([syncs(white), syncs(black)]).toEqual(before);
  });
});

describe("an older contact that keeps its own end", () => {
  it("is settled with from its sync when the rule picks its end: both show it", async () => {
    // Both resign on white's turn: white's resignation stands. White on the old Chess keeps it; black takes it from
    // white's sync, which an older Chess sends on an open (here a reconnect), not when the ends cross.
    const { link, white, black } = await atPly2([300, 0], "w");
    expect(white.game.view().features).not.toContain("settle");
    await bothResign(link, white, black);
    await link.advance(1000);
    expect(end(black)).toEqual({ result: "1-0", why: "resign" });
    await link.reconnect();
    await link.advance(1000);
    for (const side of [white, black]) expect(end(side), side.name).toEqual({ result: "0-1", why: "resign" });
  });

  it("keeps its own when the rule picks ours: each shows its own, as before, and no syncs go back and forth", async () => {
    // Both resign on white's turn: white's resignation stands. Black on the old Chess keeps its own.
    const { link, white, black } = await atPly2([300, 0], "b");
    await bothResign(link, white, black);
    await link.advance(1000);
    expect(end(white)).toEqual({ result: "0-1", why: "resign" });
    expect(end(black)).toEqual({ result: "1-0", why: "resign" });
    const before = [syncs(white), syncs(black)];
    await link.reconnect();
    await link.advance(5000);
    expect([syncs(white) - before[0], syncs(black) - before[1]]).toEqual([1, 1]);
    expect(end(white)).toEqual({ result: "0-1", why: "resign" });
  });
});
