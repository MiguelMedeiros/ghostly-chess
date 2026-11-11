// covers: apps.chess
// A resignation and a move that cross live: the resign frame names no ply, so the resigner's sync that follows it says
// which history the game ended on, and both sides keep that one (as with a move made while the resigner was away).
import { describe, expect, it } from "vitest";
import type { TimeControl } from "../src/protocol.ts";
import { Link, play, record, timedGame, type Side } from "./link.ts";

async function untimedGame(link: Link): Promise<{ white: Side; black: Side }> {
  const ana = await link.open(link.a);
  const bob = await link.open(link.b);
  await link.advance(100, 10);
  await ana.game.invite();
  await link.advance(100, 10);
  await bob.game.acceptInvitation();
  await link.advance(100, 10);
  const white = ana.game.view().me === "w" ? ana : bob;
  return { white, black: white === ana ? bob : ana };
}

async function cross(link: Link, white: Side, black: Side): Promise<void> {
  await play(link, white, "e2e4");
  await play(link, black, "e7e5");
  await play(link, white, "g1f3");
  await link.advance(500);
  // Black moves; before that move reaches white, white resigns.
  link.a.latency = link.b.latency = 200;
  expect(await black.game.move("b8", "c6")).toBe(true);
  await white.game.resign();
  await link.advance(2000, 10);
}

describe("a resignation that crosses the contact's move", () => {
  it("ends with the resigner's history on both sides, untimed", async () => {
    const link = new Link();
    const { white, black } = await untimedGame(link);
    await cross(link, white, black);
    for (const side of [white, black]) {
      expect(side.game.view().end, side.name).toEqual({ result: "0-1", why: "resign" });
      expect(record(side).m, side.name).toEqual(["e2e4", "e7e5", "g1f3"]);
      expect(side.game.view().plies, side.name).toBe(3);
    }
  });

  it("ends with the resigner's history on both sides, and one k per ply, in a timed game", async () => {
    const { link, white, black } = await timedGame([300, 0] as TimeControl);
    await cross(link, white, black);
    for (const side of [white, black]) {
      expect(side.game.view().end, side.name).toEqual({ result: "0-1", why: "resign" });
      expect(record(side).m, side.name).toEqual(["e2e4", "e7e5", "g1f3"]);
      expect(record(side).k, side.name).toHaveLength(3);
    }
    expect(record(black).k).toEqual(record(white).k);
  });
});
