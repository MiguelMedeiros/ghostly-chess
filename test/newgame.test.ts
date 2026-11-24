/**
 * A new game invited right after one ends, with the link reconnecting meanwhile: both sides end on the new game.
 */
import { describe, expect, it } from "vitest";
import { play, timedGame } from "./link.ts";

describe("a new game right after a resignation", () => {
  it("stays in step on the inviter's side when the contact's opening, with the old game, crosses the accept", async () => {
    const { link, ana, bob, white, black } = await timedGame([600, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await link.advance(2000);
    await ana.game.resign();
    await ana.game.newGame();
    await ana.game.invite([60, 0]);
    await link.advance(300);
    expect(bob.game.view().invitation?.tc).toEqual([60, 0]);
    // The connection came back on Ana's side just before Bob accepts: she says hello again and holds her frames until
    // his answer, which brings his opening with the game he still holds, the one she resigned.
    link.a.peerEvent({ open: true, version: link.b.version });
    await bob.game.acceptInvitation();
    await link.advance(3000);
    const a = ana.game.view();
    const b = bob.game.view();
    expect(a.phase).toBe("playing");
    expect(b.phase).toBe("playing");
    expect([a.tc, b.tc]).toEqual([[60, 0], [60, 0]]);
    expect(a.me).not.toBe(b.me);
    expect(ana.notices).not.toContain("out-of-step");
  });

  // Both below capture a real sync of the old game from Bob with a reconnect, then inject it once the new game runs.
  it("answers a sync of the resigned game with its own after a reload on the new game, never out of step", async () => {
    const { link, ana, bob, white, black } = await timedGame([600, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await link.advance(2000);
    await ana.game.resign();
    await link.advance(300);
    const old = JSON.parse(bob.broker.stored.get("game")!).g as string;
    await link.reconnect();
    await link.advance(300);
    const stale = bob.broker.kinds("sync").filter((f) => f.g === old).at(-1);
    await ana.game.newGame();
    await ana.game.invite([60, 0]);
    await link.advance(300);
    await bob.game.acceptInvitation();
    await link.advance(1000);
    const now = JSON.parse(link.a.stored.get("game")!).g as string;
    // The reload forgets what the toss gave up: only the last finished game names the resigned one.
    await link.close(ana);
    const back = await link.open(link.a);
    await link.advance(1500);
    const before = back.broker.kinds("sync").length;
    link.a.inject(stale);
    await link.advance(500);
    expect(back.notices).not.toContain("out-of-step");
    expect(back.game.view().phase).toBe("playing");
    expect(back.broker.kinds("sync").slice(before).some((f) => f.g === now)).toBe(true);
  });

  it("answers a sync of an unfinished game its New game gave up from out of step, never out of step again", async () => {
    const { link, ana, bob, white, black } = await timedGame([600, 0]);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await link.advance(500);
    const old = JSON.parse(bob.broker.stored.get("game")!).g as string;
    await link.reconnect();
    await link.advance(300);
    const stale = bob.broker.kinds("sync").filter((f) => f.g === old).at(-1);
    // Ana loses her record, so Bob's game puts her out of step; her New game gives up a game that never finished.
    await link.close(ana);
    link.a.stored.clear();
    const back = await link.open(link.a);
    await link.advance(500);
    expect(back.game.view().phase).toBe("out-of-step");
    await back.game.newGame();
    await back.game.invite([60, 0]);
    await link.advance(300);
    await bob.game.acceptInvitation();
    await link.advance(1000);
    const now = JSON.parse(link.a.stored.get("game")!).g as string;
    back.notices.length = 0;
    const before = back.broker.kinds("sync").length;
    link.a.inject(stale);
    await link.advance(500);
    expect(back.notices).toEqual([]);
    expect(back.game.view().phase).toBe("playing");
    expect(back.broker.kinds("sync").slice(before).some((f) => f.g === now)).toBe(true);
  });
});
