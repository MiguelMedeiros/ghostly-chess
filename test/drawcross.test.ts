// covers: apps.chess
// A draw accept that crosses the offerer's next move, with a contact that names no takeback (Chess 2.0.x and 2.1.x;
// 1.0.2 is in compat.test.ts). Such a contact clears an offer on any move, as 1.0.2 does, so it can accept only
// before the offerer's move reaches it: it ends the game at the offer's ply. The offerer (today's Chess) drops its
// move and ends there too. On the virtual-clock link (test/link.ts): latency, drops and reloads.
import type { Square } from "chess.js";
import { describe, expect, it, vi } from "vitest";
import { OWN_FEATURES } from "../src/game.ts";
import type { Feature } from "../src/protocol.ts";
import { Link, record, type Side } from "./link.ts";

vi.setConfig({ testTimeout: 30_000 });

const AGREED = { result: "1/2-1/2", why: "agreed" };
const SCHOLARS_MATE = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"];

/** The contact's Chess: its version and the features it names. */
const OLDER: [string, Feature[]][] = [
  ["2.0.0", []],
  ["2.1.0", ["clock"]],
];

interface Pair {
  link: Link;
  /** Today's Chess, which offers. */
  now: Side;
  /** The contact, on `version` with `features`. */
  old: Side;
}

/** Today's Chess and a contact on `version` (naming `features`), with an unlimited game, or `tc`. */
async function pair(version: string, features: readonly Feature[], tc?: [number, number]): Promise<Pair> {
  const link = new Link("2.3.1", version);
  const now = await link.open(link.a);
  const old = await link.open(link.b, { features });
  await link.advance(100, 10);
  await now.game.invite(tc);
  await link.advance(100, 10);
  await old.game.acceptInvitation();
  await link.advance(100, 10);
  if (now.game.view().phase !== "playing" || Boolean(now.game.view().tc) !== Boolean(tc)) throw new Error("no game");
  return { link, now, old };
}

/** Plays `plies` by whoever is to move, each one arriving before the next. */
async function play({ link, now, old }: Pair, ...plies: string[]): Promise<void> {
  for (const uci of plies) {
    const mover = now.game.view().turn === now.game.view().me ? now : old;
    const ok = await mover.game.move(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, uci[4] as "q" | undefined);
    if (!ok) throw new Error(`${uci} was refused for ${mover.name}`);
    await link.advance(1000, 10);
  }
}

/** An opening that leaves today's Chess to move: e4 e5 for white, e4 e5 Nf3 for black; and its next ply. */
function opening(p: Pair, mate = false): { moves: string[]; next: [Square, Square] } {
  const white = p.now.game.view().me === "w";
  if (mate) return white ? { moves: SCHOLARS_MATE.slice(0, 6), next: ["h5", "f7"] } : { moves: ["f2f3", "e7e5", "g2g4"], next: ["d8", "h4"] };
  return white ? { moves: ["e2e4", "e7e5"], next: ["g1", "f3"] } : { moves: ["e2e4", "e7e5", "g1f3"], next: ["b8", "c6"] };
}

/** Today's Chess offers a draw on its turn, then moves; the contact accepts (or declines) before the move reaches it. */
async function cross(p: Pair, next: [Square, Square], accept = true): Promise<void> {
  await p.now.game.offerDraw();
  await p.link.advance(100, 10);
  expect(p.old.game.view().drawOffer).toBe("peer");
  const [moved] = await Promise.all([p.now.game.move(...next), p.old.game.answerDraw(accept)]);
  expect(moved).toBe(true);
}

describe("a draw accept that crosses the offerer's next move, with a contact that names no takeback", () => {
  it.each(OLDER)("ends agreed at the offer's ply on both sides, with a contact on %s: the offerer's move goes", async (version, features) => {
    const p = await pair(version, features);
    const { moves, next } = opening(p);
    await play(p, ...moves);
    await cross(p, next);
    await p.link.advance(3000, 10);
    for (const side of [p.now, p.old]) {
      expect(side.game.view().end, side.name).toEqual(AGREED);
      expect(record(side).m, side.name).toEqual(moves);
      expect(side.notices, side.name).toEqual([]);
    }
    expect(p.now.game.history()).toEqual(p.old.game.history());
    // A few frames, then quiet: no syncs back and forth.
    const sent = p.link.a.sent.length + p.link.b.sent.length;
    await p.link.advance(10_000, 100);
    expect(p.link.a.sent.length + p.link.b.sent.length).toBe(sent);
  });

  it("drops a mating move that crossed the accept too: the game ends agreed, not on the board", async () => {
    const p = await pair("2.0.0", []);
    const { moves, next } = opening(p, true);
    await play(p, ...moves);
    await cross(p, next);
    await p.link.advance(3000, 10);
    for (const side of [p.now, p.old]) {
      expect(side.game.view().end, side.name).toEqual(AGREED);
      expect(record(side).m, side.name).toEqual(moves);
      expect(side.notices, side.name).toEqual([]);
    }
  });

  it("drops the move's time with it in a timed game with a contact on 2.1.0: one clock entry per ply", async () => {
    const p = await pair("2.1.0", ["clock"], [300, 2]);
    const { moves, next } = opening(p);
    await play(p, ...moves);
    await cross(p, next);
    await p.link.advance(3000, 10);
    for (const side of [p.now, p.old]) {
      expect(side.game.view().end, side.name).toEqual(AGREED);
      expect(record(side).m, side.name).toEqual(moves);
      expect(record(side).k?.length ?? moves.length, side.name).toBe(moves.length);
      expect(side.notices, side.name).toEqual([]);
    }
  });

  it("ends the same from the contact's sync when the accept frame is lost on the way", async () => {
    const p = await pair("2.1.0", ["clock"]);
    const { moves, next } = opening(p);
    await play(p, ...moves);
    p.link.b.drop = (frame) => frame.k === "draw";
    await cross(p, next);
    await p.link.advance(3000, 10);
    // The contact, already ended, answers the crossing move with its sync: that ends it here.
    for (const side of [p.now, p.old]) {
      expect(side.game.view().end, side.name).toEqual(AGREED);
      expect(record(side).m, side.name).toEqual(moves);
    }
    expect(p.now.notices).toEqual([]);
  });

  it("ends the same after the offerer's reload: the lapsed offer is kept with the game", async () => {
    const p = await pair("2.1.0", ["clock"]);
    const { moves, next } = opening(p);
    await play(p, ...moves);
    // The offerer's page reloads right after its move, before the accept (and its move's answer) reach it.
    p.link.b.drop = (frame) => frame.k === "draw" || frame.k === "sync";
    await cross(p, next);
    await p.link.advance(3000, 10);
    expect(p.now.game.view().phase).toBe("playing");
    p.link.b.drop = null;
    await p.link.close(p.now);
    const now = await p.link.open(p.link.a);
    await p.link.advance(3000, 10);
    for (const side of [now, p.old]) {
      expect(side.game.view().end, side.name).toEqual(AGREED);
      expect(record(side).m, side.name).toEqual(moves);
    }
    expect(now.notices).toEqual([]);
  });

  it("takes a decline that crossed the move as nothing: no notice, the game goes on", async () => {
    const p = await pair("2.1.0", ["clock"]);
    const { moves, next } = opening(p);
    await play(p, ...moves);
    await cross(p, next, false);
    await p.link.advance(3000, 10);
    for (const side of [p.now, p.old]) {
      expect(side.game.view().phase, side.name).toBe("playing");
      expect(record(side).m, side.name).toHaveLength(moves.length + 1);
      expect(side.game.view().drawOffer, side.name).toBeUndefined();
      expect(side.notices, side.name).toEqual([]);
    }
  });

  it("refuses an accept of the offer's ply that comes after the accepter's own move: it is stale", async () => {
    const p = await pair("2.1.0", ["clock"]);
    const { moves, next } = opening(p);
    await play(p, ...moves);
    await p.now.game.offerDraw();
    await p.link.advance(100, 10);
    await p.now.game.move(...next);
    await p.link.advance(1000, 10);
    // The contact's reply: the offer lapsed on its side with the move; then an accept naming the offer's ply.
    await play(p, p.now.game.view().me === "w" ? "b8c6" : "f1c4");
    const g = (record(p.now) as unknown as { g: string }).g;
    p.link.a.inject({ p: "chess", v: 2, k: "draw", g, o: "accept", n: moves.length });
    await p.link.advance(1000, 10);
    expect(p.now.game.view().phase).toBe("playing");
    expect(record(p.now).m).toHaveLength(moves.length + 2);
    expect(p.now.notices).toEqual(["bad-message"]);
  });

  it("refuses an accept when the offer was made on the contact's turn and both moved since", async () => {
    const p = await pair("2.1.0", ["clock"]);
    const { moves, next } = opening(p);
    await play(p, ...moves);
    await p.now.game.move(...next);
    await p.link.advance(1000, 10);
    // Offered on the contact's turn: the contact's move clears it, and today's next move makes nothing of it.
    await p.now.game.offerDraw();
    await p.link.advance(100, 10);
    const white = p.now.game.view().me === "w";
    await play(p, white ? "b8c6" : "f1c4", white ? "f1c4" : "g8f6");
    const g = (record(p.now) as unknown as { g: string }).g;
    p.link.a.inject({ p: "chess", v: 2, k: "draw", g, o: "accept", n: moves.length + 1 });
    await p.link.advance(1000, 10);
    expect(p.now.game.view().phase).toBe("playing");
    expect(record(p.now).m).toHaveLength(moves.length + 3);
  });

  it("leaves a contact that names takeback as it was: the offer stands through the move, and the sync decides", async () => {
    const link = new Link("2.3.1", "2.3.1");
    const now = await link.open(link.a);
    const old = await link.open(link.b, { features: OWN_FEATURES });
    await link.advance(100, 10);
    await now.game.invite();
    await link.advance(100, 10);
    await old.game.acceptInvitation();
    await link.advance(100, 10);
    const p = { link, now, old };
    const { moves, next } = opening(p);
    await play(p, ...moves);
    await p.now.game.offerDraw();
    await link.advance(100, 10);
    await p.now.game.move(...next);
    // Our offer stands through our own move: nothing lapsed is kept.
    expect(p.now.game.view().drawOffer).toBe("me");
    expect("dl" in record(p.now)).toBe(false);
    await link.advance(1000, 10);
    // The contact saw the move, and accepts at the later ply.
    await p.old.game.answerDraw(true);
    await link.advance(3000, 10);
    for (const side of [p.now, p.old]) {
      expect(side.game.view().end, side.name).toEqual(AGREED);
      expect(record(side).m, side.name).toHaveLength(moves.length + 1);
    }
  });
});
