// covers: apps.chess
// An accept of our draw offer that our own next move cleared (dl), with a contact that names no takeback, that comes
// when it can no longer have crossed that move: after the move ended the game on the board, past the crossing window,
// or after a frame of the contact's (an ack, a sync, its own offer) showed it holds the move. The move stands.
// Crossing accepts are in drawcross.test.ts. On the virtual-clock link (test/link.ts).
import type { Square } from "chess.js";
import { describe, expect, it, vi } from "vitest";
import type { Feature } from "../src/protocol.ts";
import { Link, record, type Side } from "./link.ts";

vi.setConfig({ testTimeout: 60_000 });

interface Pair {
  link: Link;
  /** Today's Chess, which offers. */
  now: Side;
  /** The contact, on 2.1.0 with `features`. */
  old: Side;
}

/** Today's Chess and a contact on 2.1.0 (naming `features`), with an unlimited game, or `tc`. */
async function pair(features: readonly Feature[], tc?: [number, number]): Promise<Pair> {
  const link = new Link("2.3.1", "2.1.0");
  const now = await link.open(link.a);
  const old = await link.open(link.b, { features });
  await link.advance(100, 10);
  await now.game.invite(tc);
  await link.advance(100, 10);
  await old.game.acceptInvitation();
  await link.advance(100, 10);
  if (now.game.view().phase !== "playing") throw new Error("no game");
  return { link, now, old };
}

/** Plays `plies` by whoever is to move, each one arriving before the next. */
async function play({ link, now, old }: Pair, ...plies: string[]): Promise<void> {
  for (const uci of plies) {
    const mover = now.game.view().turn === now.game.view().me ? now : old;
    const ok = await mover.game.move(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square);
    if (!ok) throw new Error(`${uci} was refused for ${mover.name}`);
    await link.advance(1000, 10);
  }
}

/** An opening that leaves today's Chess to move (with a mate in one, or a quiet move, as its next ply). */
function opening(p: Pair, mate: boolean): { moves: string[]; next: [Square, Square] } {
  const white = p.now.game.view().me === "w";
  if (mate) return white ? { moves: ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6"], next: ["h5", "f7"] } : { moves: ["f2f3", "e7e5", "g2g4"], next: ["d8", "h4"] };
  return white ? { moves: ["e2e4", "e7e5"], next: ["g1", "f3"] } : { moves: ["e2e4", "e7e5", "g1f3"], next: ["b8", "c6"] };
}

/** The contact's accept of the offer at ply count n, as a frame of its own, `after` ms after our move. */
async function lateAccept(p: Pair, n: number, after: number): Promise<void> {
  await p.link.advance(after, 100);
  const g = (record(p.now) as unknown as { g: string }).g;
  p.link.a.inject({ p: "chess", v: 2, k: "draw", g, o: "accept", n });
  await p.link.advance(3000, 10);
}

describe("an accept of our offer that our move cleared, when it can no longer have crossed that move", () => {
  for (const [label, tc] of [["untimed", undefined], ["timed", [300, 2]]] as const) {
    it(`keeps a mate the contact saw 60 s earlier (${label})`, async () => {
      const p = await pair(["clock"], tc as [number, number] | undefined);
      const { moves, next } = opening(p, true);
      await play(p, ...moves);
      await p.now.game.offerDraw();
      await p.link.advance(1000, 10);
      expect(await p.now.game.move(...next)).toBe(true);
      await lateAccept(p, moves.length, 60_000);
      expect(p.now.game.view().end).toEqual({ result: p.now.game.view().me === "w" ? "1-0" : "0-1", why: "checkmate" });
      expect(record(p.now).m).toHaveLength(moves.length + 1);
    });
  }

  it("keeps a mate even when the accept comes at once: a move that ended the game is never dropped", async () => {
    const p = await pair(["clock"]);
    const { moves, next } = opening(p, true);
    await play(p, ...moves);
    await p.now.game.offerDraw();
    await p.link.advance(1000, 10);
    await p.now.game.move(...next);
    await lateAccept(p, moves.length, 50);
    expect(p.now.game.view().end?.why).toBe("checkmate");
    expect(record(p.now).m).toHaveLength(moves.length + 1);
  });

  it("keeps a move the contact saw 30 s earlier, when it accepts instead of moving (untimed)", async () => {
    const p = await pair(["clock"]);
    const { moves, next } = opening(p, false);
    await play(p, ...moves);
    await p.now.game.offerDraw();
    await p.link.advance(1000, 10);
    await p.now.game.move(...next);
    await lateAccept(p, moves.length, 30_000);
    expect(p.now.game.view().phase).toBe("playing");
    expect(record(p.now).m).toHaveLength(moves.length + 1);
  });

  it("keeps a move the contact acked, also within the window (timed)", async () => {
    const p = await pair(["clock"], [300, 2]);
    const { moves, next } = opening(p, false);
    await play(p, ...moves);
    await p.now.game.offerDraw();
    await p.link.advance(1000, 10);
    await p.now.game.move(...next);
    await p.link.advance(500, 10);
    // The contact's ack names our move: it holds it, so the offer that move cleared is gone.
    expect(p.link.b.sent.some(({ frame }) => frame.k === "ack" && frame.n === moves.length + 1)).toBe(true);
    expect("dl" in record(p.now)).toBe(false);
    await lateAccept(p, moves.length, 0);
    expect(p.now.game.view().phase).toBe("playing");
    expect(record(p.now).m).toHaveLength(moves.length + 1);
  });

  it("keeps a move the contact's sync shows it holds, also within the window", async () => {
    const p = await pair(["clock"]);
    const { moves, next } = opening(p, false);
    await play(p, ...moves);
    await p.now.game.offerDraw();
    await p.link.advance(1000, 10);
    await p.now.game.move(...next);
    await p.link.advance(500, 10);
    const now = record(p.now) as unknown as { g: string; s: [string, string]; m: string[] };
    p.link.a.inject({ p: "chess", v: 2, k: "sync", g: now.g, s: [now.s[1], now.s[0]], m: now.m.join(" ") });
    await p.link.advance(100, 10);
    expect("dl" in record(p.now)).toBe(false);
    await lateAccept(p, moves.length, 0);
    expect(p.now.game.view().phase).toBe("playing");
    expect(record(p.now).m).toHaveLength(moves.length + 1);
  });

  it("keeps a move the contact's own draw offer shows it holds, also within the window", async () => {
    const p = await pair(["clock"]);
    const { moves, next } = opening(p, false);
    await play(p, ...moves);
    await p.now.game.offerDraw();
    await p.link.advance(1000, 10);
    await p.now.game.move(...next);
    await p.link.advance(500, 10);
    // The contact offers at the ply after our move: it holds the move, so the offer that move cleared is gone.
    await p.old.game.offerDraw();
    await p.link.advance(100, 10);
    expect(p.link.b.kinds("draw")).toContainEqual(expect.objectContaining({ o: "offer", n: moves.length + 1 }));
    expect(p.now.game.view().drawOffer).toBe("peer");
    expect("dl" in record(p.now)).toBe(false);
    await lateAccept(p, moves.length, 0);
    expect(p.now.game.view().phase).toBe("playing");
    expect(record(p.now).m).toHaveLength(moves.length + 1);
  });

  it("keeps the move against a late sync that says agreed at the offer's ply: the games differ", async () => {
    const p = await pair(["clock"]);
    const { moves, next } = opening(p, false);
    await play(p, ...moves);
    await p.now.game.offerDraw();
    await p.link.advance(1000, 10);
    await p.now.game.move(...next);
    await p.link.advance(30_000, 100);
    const now = record(p.now) as unknown as { g: string; s: [string, string]; m: string[] };
    p.link.a.inject({ p: "chess", v: 2, k: "sync", g: now.g, s: [now.s[1], now.s[0]], m: now.m.slice(0, -1).join(" "), x: { why: "agreed" } });
    await p.link.advance(1000, 10);
    expect(p.now.game.view().end).toBeUndefined();
    expect(record(p.now).m).toHaveLength(moves.length + 1);
    expect(p.now.notices).toEqual(["out-of-step"]);
  });
});
