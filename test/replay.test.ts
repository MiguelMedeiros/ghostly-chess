// covers: apps.chess
// Replay and staleness: every draw, takeback, ack, flag and dispute names the ply count n it is about, and one about
// another ply is ignored; a move again is a repeat; and a sync's end is taken only when this side could have
// reached it. A peer cannot end a game by claiming any end.
import type { Square } from "chess.js";
import { describe, expect, it } from "vitest";
import { ChessController, type Notice, type SavedGame } from "../src/game.ts";
import { encodeMessage, type GameEnd, type Message } from "../src/protocol.ts";
import { chatPair, MockBroker } from "./mockBroker.ts";

interface Side {
  broker: MockBroker;
  game: ChessController;
  notices: Notice[];
}

async function open(broker: MockBroker): Promise<Side> {
  broker.launch();
  const game = new ChessController(broker);
  const notices: Notice[] = [];
  game.onNotice((n) => notices.push(n));
  await game.start();
  return { broker, game, notices };
}

async function settle(...sides: Side[]): Promise<void> {
  for (let idle = 0; idle < 3; ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(sides.map((s) => s.game.settled()));
    idle = sides.every((s) => s.broker.inFlight === 0) ? idle + 1 : 0;
  }
}

/** A protocol 2 game, invited and accepted, with these plies played. */
async function game(...plies: string[]): Promise<{ white: Side; black: Side }> {
  const [a, b] = chatPair();
  const ana = await open(a);
  const bob = await open(b);
  await settle(ana, bob);
  await ana.game.invite();
  await settle(ana, bob);
  await bob.game.acceptInvitation();
  await settle(ana, bob);
  const white = ana.game.view().me === "w" ? ana : bob;
  const black = white === ana ? bob : ana;
  for (const uci of plies) {
    const mover = white.game.view().turn === "w" ? white : black;
    expect(await mover.game.move(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square)).toBe(true);
    await settle(white, black);
  }
  return { white, black };
}

const saved = (side: Side) => JSON.parse(side.broker.stored.get("game")!) as SavedGame;
/** Injects frames from the contact into a side, as if its peer sent them, and lets them be handled. */
async function from(side: Side, ...messages: Message[]): Promise<void> {
  for (const message of messages) side.broker.inject(encodeMessage(message));
  await settle(side);
}

describe("stale frames", () => {
  it("ignores a draw accept or decline naming an old ply count, and takes the one about this position", async () => {
    const { white, black } = await game("e2e4", "e7e5");
    await white.game.offerDraw();
    await settle(white, black);
    const g = saved(white).g;
    const before = JSON.stringify(saved(white));
    await from(white, { k: "draw", g, o: "accept", n: 1 }, { k: "draw", g, o: "decline", n: 0 }, { k: "draw", g, o: "accept", n: 3 });
    expect(JSON.stringify(saved(white))).toBe(before);
    expect(white.game.view().drawOffer).toBe("me");
    expect(white.notices).toEqual([]);
    // A draw offer about an old position is no offer.
    await from(black, { k: "draw", g, o: "offer", n: 0 });
    expect(saved(black).d).toBe("peer"); // the live offer from White, at ply 2, stands
    expect(saved(black).dn).toBe(2);
    await from(white, { k: "draw", g, o: "accept", n: 2 });
    expect(white.game.view().end).toEqual({ result: "1/2-1/2", why: "agreed" });
  });

  it("ignores a takeback accept, an ack, a flag and a dispute naming an old ply count, or another game", async () => {
    const { white, black } = await game("e2e4", "e7e5", "g1f3");
    const g = saved(black).g;
    const before = JSON.stringify(saved(black));
    await from(
      black,
      { k: "takeback", g, n: 1, o: "accept" },
      { k: "takeback", g, n: 2, o: "accept" },
      { k: "ack", g, n: 1 },
      { k: "ack", g, n: 3 },
      { k: "flag", g, n: 2, by: "b" },
      { k: "flag", g, n: 1, by: "w" },
      { k: "dispute", g, n: 2 },
      { k: "flag", g: "0123456789abcdef", n: 3, by: "b" },
      { k: "dispute", g: "0123456789abcdef", n: 3 },
      { k: "draw", g: "0123456789abcdef", o: "offer", n: 3 },
    );
    expect(JSON.stringify(saved(black))).toBe(before);
    expect(black.game.view().phase).toBe("playing");
    expect(black.notices).toEqual([]);
    // About this very ply: a flag in an untimed game, or a dispute of a claim never made, is a bad message, and still
    // changes nothing.
    await from(black, { k: "flag", g, n: 3, by: "b" }, { k: "dispute", g, n: 3 });
    expect(black.notices).toEqual(["bad-message", "bad-message"]);
    expect(JSON.stringify(saved(black))).toBe(before);
    void white;
  });

  it("takes a move again as a repeat: nothing changes, nothing is reported", async () => {
    const { white, black } = await game("e2e4", "e7e5", "g1f3");
    const g = saved(black).g;
    const before = JSON.stringify(saved(black));
    await from(black, { k: "move", g, n: 0, m: "e2e4" }, { k: "move", g, n: 2, m: "g1f3" }, { k: "move", g, n: 0, m: "e2e4" });
    expect(JSON.stringify(saved(black))).toBe(before);
    expect(black.notices).toEqual([]);
    // The same ply number with another move is not a repeat.
    await from(black, { k: "move", g, n: 2, m: "b1c3" });
    expect(black.notices).toEqual(["invalid-move"]);
    expect(JSON.stringify(saved(black))).toBe(before);
    void white;
  });
});

describe("a sync's end", () => {
  /** The sync White's side would send Black, with an end. */
  const sync = (side: Side, x: GameEnd, m = saved(side).m): Message => {
    const s = saved(side);
    return { k: "sync", g: s.g, s: [s.s[1], s.s[0]], m, x };
  };

  it("is a bad message, and changes nothing, when this side could not have reached it", async () => {
    const { white, black } = await game("e2e4", "e7e5", "g1f3");
    const before = JSON.stringify(saved(black));
    const ends: GameEnd[] = [
      { why: "resign", by: "b" }, // this side's own resignation
      { why: "agreed" }, // a draw this side never offered
      { why: "time", by: "w" }, // time, in an untimed game
      { why: "time", by: "b" }, // this side out of time, with no claim it accepted
      { why: "aborted" }, // after ply 2
      { why: "disputed" }, // no claim at this ply
    ];
    for (const x of ends) await from(black, sync(black, x));
    expect(black.notices).toEqual(ends.map(() => "bad-message"));
    expect(JSON.stringify(saved(black))).toBe(before);
    expect(black.game.view().end).toBeUndefined();
    void white;
  });

  it("is taken for the sender's resignation, and for a draw this side offered at that ply", async () => {
    const { black } = await game("e2e4", "e7e5", "g1f3");
    await from(black, sync(black, { why: "resign", by: "w" }));
    expect(black.game.view().end).toEqual({ result: "0-1", why: "resign" });
    const other = await game("e2e4", "e7e5");
    await other.black.game.offerDraw();
    // White never got the offer's frame (it was busy); then the sync says agreed at that ply.
    await from(other.black, sync(other.black, { why: "agreed" }));
    expect(other.black.game.view().end).toEqual({ result: "1/2-1/2", why: "agreed" });
  });

  it("is taken for an abort only before ply 2", async () => {
    const early = await game("e2e4");
    await from(early.black, sync(early.black, { why: "aborted" }));
    expect(early.black.game.view().end).toEqual({ result: "*", why: "aborted" });
    expect(early.black.notices).toEqual([]);
    const late = await game("e2e4", "e7e5");
    await from(late.black, sync(late.black, { why: "aborted" }));
    expect(late.black.notices).toEqual(["bad-message"]);
    expect(late.black.game.view().end).toBeUndefined();
  });

  it("is not taken with a history this side does not hold", async () => {
    const { black } = await game("e2e4", "e7e5");
    const before = JSON.stringify(saved(black));
    // A history of two plies past ours: not provable, so out of step; the end is never read.
    await from(black, sync(black, { why: "resign", by: "w" }, ["e2e4", "e7e5", "g1f3", "b8c6"]));
    expect(black.game.view().phase).toBe("out-of-step");
    expect(JSON.stringify(saved(black))).toBe(before);
  });
});
