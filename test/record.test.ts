// covers: apps.chess
// What Chess keeps in storage (src/record.ts): a 1.0.2 record reads as an untimed v:2 one with the same game id, a
// corrupt one is dropped, and the toss keeps its terms across a reload.
import { describe, expect, it } from "vitest";
import { ChessController } from "../src/game.ts";
import { readFlip, readGame, readPrev } from "../src/record.ts";
import { commitment, deal, newSalt } from "../src/toss.ts";
import { MockBroker } from "./mockBroker.ts";

const a = newSalt();
const b = newSalt();
const { g, me } = deal(a, b);
/** A game record exactly as Chess 1.0.2 wrote it. */
const v1 = { v: 1, g, me, s: [a, b], m: ["e2e4", "e7e5"], d: "peer" };

describe("the game record", () => {
  it("reads a 1.0.2 record as an untimed v:2 one, with the same game id, colour and salts", () => {
    expect(readGame(v1)).toEqual({ v: 2, g, me, s: [a, b], dv: 1, m: ["e2e4", "e7e5"], d: "peer" });
    expect(readGame({ ...v1, x: { why: "resign", by: "w" } })!.x).toEqual({ why: "resign", by: "w" });
    // 1.0.2 knew no other end, and no time control: a v2 field in a v:1 record is not read.
    expect(readGame({ ...v1, x: { why: "aborted" } })!.x).toBeUndefined();
    expect(readGame({ ...v1, tc: [300, 0], k: [1, 2] })).toEqual(readGame(v1));
  });

  it("reads a v:2 record with its terms and clocks, and leaves out a bad optional field", () => {
    const v2 = { v: 2, g, me, s: [a, b], dv: 2, m: ["e2e4"], tc: [300, 2], r: "0123456789abcdef", k: [300000], tw: 1_700_000_000_000, ts: 1_700_000_000_500, x: { why: "time", by: "b" }, d: "me", dn: 1, tb: 1, q: 0, pc: 1, fl: 1, sd: "2026.10.08" };
    expect(readGame(v2)).toEqual(v2);
    const read = readGame({ ...v2, tc: [1, 0], r: "x", k: [-1], tw: "now", dn: 9999, fl: 1.5, sd: "today", x: { why: "nope" } })!;
    for (const key of ["tc", "r", "k", "tw", "dn", "fl", "sd", "x"]) expect(read, key).not.toHaveProperty(key);
    // A dv:1 game is untimed, whatever the record says.
    expect(readGame({ ...v2, dv: 1 })!.tc).toBeUndefined();
  });

  it("drops a corrupt record, as before", () => {
    for (const bad of [
      null,
      "game",
      [],
      { ...v1, v: 3 },
      { ...v1, g: "nope" },
      { ...v1, me: "x" },
      { ...v1, s: [a] },
      { ...v1, s: [a, "b"] },
      { ...v1, m: "e2e4" },
      { ...v1, m: ["e2e4", 5] },
      { ...v1, m: ["Nf3"] },
      { ...v1, v: 2 },
      { ...v1, v: 2, dv: 3 },
    ]) expect(readGame(bad), JSON.stringify(bad)).toBeNull();
  });

  it("drops a game whose moves do not replay, and keeps a 1.0.2 game going in the controller", async () => {
    const broker = new MockBroker("ana", "2.0.0");
    broker.stored.set("game", JSON.stringify({ ...v1, m: ["e2e4", "e2e4"] }));
    broker.launch();
    const broken = new ChessController(broker);
    await broken.start();
    expect(broken.view().phase).toBe("setup");
    broker.stored.set("game", JSON.stringify(v1));
    const game = new ChessController(broker);
    await game.start();
    expect(game.view()).toMatchObject({ phase: "playing", me, plies: 2 });
    expect(game.view().tc).toBeUndefined();
  });
});

describe("the toss record", () => {
  it("reads a 1.0.2 toss as an untimed invitation, and a v:2 one with its terms", () => {
    const salt = newSalt();
    const peer = commitment(newSalt());
    expect(readFlip({ v: 1, salt, a: [g], peer })).toEqual({ v: 2, salt, a: [g], peer });
    expect(readFlip({ v: 1, salt, a: [], tc: [300, 0] })).toEqual({ v: 2, salt, a: [] });
    expect(readFlip({ v: 2, salt, a: [], tc: [180, 2], r: g })).toEqual({ v: 2, salt, a: [], tc: [180, 2], r: g });
    for (const bad of [null, { v: 2, salt: "x", a: [] }, { v: 2, salt, a: "x" }, { v: 2, salt, a: [g, g, g] }, { v: 2, salt, a: [], tc: [1, 1] }, { v: 2, salt, a: [], r: "x" }, { v: 9, salt, a: [] }]) {
      expect(readFlip(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("keeps an invitation's terms across a reload: the same seek goes again", async () => {
    const broker = new MockBroker("ana", "2.0.0");
    const salt = newSalt();
    // A v:2 toss record with terms, as a later Chess with clocks writes it.
    broker.stored.set("flip", JSON.stringify({ v: 2, salt, a: [], tc: [300, 0] }));
    const peer = new MockBroker("bob", "2.0.0");
    broker.peer = peer;
    peer.peer = broker;
    broker.launch();
    const game = new ChessController(broker);
    await game.start();
    expect(game.view().phase).toBe("invited");
    expect(game.view().proposal).toEqual({ tc: [300, 0], rematch: false });
    peer.launch();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await game.settled();
    broker.inject({ p: "chess", v: 2, k: "hello", pv: 2, f: [] });
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await game.settled();
    }
    expect(broker.sent.at(-1)).toEqual({ p: "chess", v: 2, k: "seek", c: commitment(salt), a: [], tc: [300, 0] });
  });

  it("drops an invitation with terms 1.0.2 cannot play when the contact turns out to be 1.0.2", async () => {
    const broker = new MockBroker("ana", "2.0.0");
    broker.stored.set("flip", JSON.stringify({ v: 2, salt: newSalt(), a: [], tc: [300, 0] }));
    const peer = new MockBroker("bob", "1.0.2");
    broker.peer = peer;
    peer.peer = broker;
    peer.launch();
    broker.launch();
    const game = new ChessController(broker);
    await game.start();
    expect(broker.sent).toHaveLength(1);
    expect(Object.keys(broker.sent[0] as object)).toEqual(["p", "v", "k", "c", "a"]);
    expect(JSON.parse(broker.stored.get("flip")!).tc).toBeUndefined();
  });
});

describe("the last game", () => {
  it("reads {g, me, tc}, or nothing", () => {
    expect(readPrev({ g, me: "w" })).toEqual({ g, me: "w" });
    expect(readPrev({ g, me: "b", tc: [600, 0] })).toEqual({ g, me: "b", tc: [600, 0] });
    expect(readPrev({ g, me: "b", tc: [6, 0] })).toEqual({ g, me: "b" });
    expect(readPrev({ g: "x", me: "w" })).toBeNull();
    expect(readPrev(undefined)).toBeNull();
  });
});
