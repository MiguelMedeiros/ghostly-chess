// covers: apps.chess
// A takeback declined in a session gap: the broker refuses the decline (`offline`) and says open again when the
// session is back. The asker sends its ask again on that open; the side that declined it answers the same again, so
// the asker is never left waiting with its board locked.
import { describe, expect, it } from "vitest";
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

/** White declines black's ask while the session is held, and the session comes back. */
async function declineInGap(link: Link, white: Side, black: Side): Promise<void> {
  await black.game.takeback();
  await link.advance(100, 10);
  expect(white.game.view().takeback).toBe("peer");
  link.hold(true);
  await white.game.answerTakeback(false);
  await link.advance(500, 10);
  link.hold(false);
  await link.reconnect();
}

describe("a takeback declined while the session was held", () => {
  it("reaches the asker when the session comes back, untimed: its board is free again", async () => {
    const link = new Link();
    const { white, black } = await untimedGame(link);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await play(link, white, "g1f3");
    await play(link, black, "b8c6");
    await declineInGap(link, white, black);
    await link.advance(1000, 10);
    expect(black.game.view().takeback).toBeUndefined();
    expect(black.notices).toContain("takeback-declined");
    // The ask is not shown again on the side that declined it.
    expect(white.game.view().takeback).toBeUndefined();
    expect(record(black).m).toEqual(["e2e4", "e7e5", "g1f3", "b8c6"]);
    // White moves, and black answers it.
    await play(link, white, "f1c4");
    expect(black.game.view().canMove).toBe(true);
    await play(link, black, "g8f6");
    expect(record(white).m).toHaveLength(6);
  });

  it("goes again at most once a second, however many copies of the ask come", async () => {
    const link = new Link();
    const { white, black } = await untimedGame(link);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await play(link, white, "g1f3");
    await play(link, black, "b8c6");
    await black.game.takeback();
    await link.advance(100, 10);
    await white.game.answerTakeback(false);
    await link.advance(100, 10);
    const g = (record(white) as unknown as { g: string }).g;
    const declines = () => white.broker.kinds("takeback").filter((f) => f.o === "decline").length;
    const before = declines();
    for (let i = 0; i < 10; i++) white.broker.inject({ p: "chess", v: 2, k: "takeback", g, n: 3, o: "ask", h: 4 });
    await link.advance(50, 10);
    expect(declines() - before).toBe(1);
    expect(white.game.view().takeback).toBeUndefined();
  });

  it("reaches the asker, timed: it moves on, and does not lose on time", async () => {
    const { link, white, black } = await timedGame([180, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await play(link, white, "g1f3");
    await play(link, black, "b8c6");
    await play(link, white, "f1c4");
    await declineInGap(link, white, black);
    await link.advance(1000, 10);
    expect(black.game.view().takeback).toBeUndefined();
    expect(black.game.view().canMove).toBe(true);
    await play(link, black, "g8f6");
    await link.advance(1000, 10);
    for (const side of [white, black]) expect(side.game.view().end, side.name).toBeUndefined();
    expect(record(white).m).toEqual(record(black).m);
  });
});
