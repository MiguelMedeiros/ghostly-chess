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
});
