// covers: apps.chess
// Rematches (the "rematch" feature, 2.2.0): a seek with r = the finished game and the same time control. Colours swap
// through deal2's prevColour, checked against 'prev'.
import { describe, expect, it } from "vitest";
import { ChessController, type SavedGame } from "../src/game.ts";
import { encodeMessage } from "../src/protocol.ts";
import { commitment, deal2, newSalt } from "../src/toss.ts";
import { en } from "../src/strings.ts";
import { featureHint } from "../src/ui.ts";
import { chatPair } from "./mockBroker.ts";
import { open, play, settle, startChat, type Side } from "./sides.ts";

const saved = (side: Side) => JSON.parse(side.broker.stored.get("game")!) as SavedGame;
const kinds = (side: Side) => side.broker.sent.map((f) => (f as { k: string }).k);

/** A 5|0 game between Ana and Bob, ended by White's resignation after a few moves. */
async function finished(): Promise<{ ana: Side; bob: Side; white: Side; black: Side; g: string }> {
  const [a, b] = chatPair();
  const ana = await open(a);
  const bob = await open(b);
  await settle(ana, bob);
  await ana.game.invite([300, 0]);
  await settle(ana, bob);
  await bob.game.acceptInvitation();
  await settle(ana, bob);
  const white = ana.game.view().me === "w" ? ana : bob;
  const black = white === ana ? bob : ana;
  await play({ white, black }, "e2e4", "e7e5");
  await white.game.resign();
  await settle(ana, bob);
  return { ana, bob, white, black, g: saved(ana).g };
}

describe("a rematch", () => {
  it("swaps each side's colour, keeps the time control, and is a new game", async () => {
    const { white, black, g } = await finished();
    expect(white.game.view().canRematch).toBe(true);
    await black.game.rematch();
    await settle(white, black);
    expect(black.game.view().phase).toBe("invited");
    expect(black.game.view().proposal).toEqual({ tc: [300, 0], r: g, rematch: true });
    expect(white.game.view().invitation).toEqual({ tc: [300, 0], r: g, rematch: true, playable: true });
    await white.game.acceptInvitation();
    await settle(white, black);
    for (const side of [white, black]) {
      expect(side.game.view().phase).toBe("playing");
      expect(saved(side).g).not.toBe(g);
      expect(saved(side).r).toBe(g);
      expect(saved(side).tc).toEqual([300, 0]);
    }
    expect(saved(white).g).toBe(saved(black).g);
    expect(white.game.view().me).toBe("b");
    expect(black.game.view().me).toBe("w");
    // The id is deal2's for these salts and terms.
    const s = saved(white);
    expect(deal2(s.s[0], s.s[1], { tc: [300, 0], r: g }, "w")).toEqual({ g: s.g, me: "b" });
    // And the rematch of the rematch swaps back.
    await play({ white: black, black: white }, "e2e4");
    await white.game.resign();
    await settle(white, black);
    await white.game.rematch();
    await settle(white, black);
    await black.game.acceptInvitation();
    await settle(white, black);
    expect(white.game.view().me).toBe("w");
    expect(black.game.view().me).toBe("b");
  });

  it("is declined when it names a game this side does not hold as its last one, or other terms", async () => {
    const { white, black, g } = await finished();
    for (const seek of [
      { c: commitment(newSalt()), a: [g], r: "0123456789abcdef", tc: [300, 0] as [number, number] },
      { c: commitment(newSalt()), a: [g], r: g, tc: [60, 0] as [number, number] },
      { c: commitment(newSalt()), a: [g], r: g },
    ]) {
      const count = black.broker.sent.length;
      black.broker.inject(encodeMessage({ k: "seek", ...seek }));
      await settle(black);
      expect(black.broker.sent.slice(count)).toEqual([{ p: "chess", v: 2, k: "decline", c: seek.c }]);
      expect(black.game.view().invitation).toBeUndefined();
    }
    expect(black.notices).toEqual([]);
    void white;
  });

  it("starts one game when both ask for it at once", async () => {
    const { white, black, g } = await finished();
    await Promise.all([white.game.rematch(), black.game.rematch()]);
    await settle(white, black);
    for (const side of [white, black]) {
      expect(side.game.view().phase).toBe("playing");
      expect(saved(side).r).toBe(g);
    }
    expect(saved(white).g).toBe(saved(black).g);
    expect(white.game.view().me).toBe("b");
    expect(black.game.view().me).toBe("w");
    expect(white.notices).toEqual([]);
    expect(black.notices).toEqual([]);
  });

  it("is one at a time: asking again while it waits sends nothing", async () => {
    const { white, black } = await finished();
    await black.game.rematch();
    await settle(white, black);
    const count = black.broker.sent.length;
    await black.game.rematch();
    await settle(white, black);
    expect(black.broker.sent.length).toBe(count);
  });

  it("is off, with the update hint, against a contact whose Chess has no rematches (2.1.0), and nothing is sent", async () => {
    const [a, b] = chatPair("2.1.0");
    const ana = await open(a);
    b.launch();
    const bob: Side = { broker: b, game: new ChessController(b, { features: ["clock"] }), notices: [], prefs: ana.prefs };
    await bob.game.start();
    await settle(ana, bob);
    await ana.game.invite();
    await settle(ana, bob);
    await bob.game.acceptInvitation();
    await settle(ana, bob);
    await ana.game.resign();
    await settle(ana, bob);
    const view = ana.game.view();
    expect(view.canRematch).toBe(true);
    expect(featureHint(view, "rematch", en)).toBe("Your contact needs to update Chess (they have 2.1.0)");
    const count = a.sent.length;
    await ana.game.rematch();
    await settle(ana, bob);
    expect(a.sent.length).toBe(count);
    expect(kinds(ana)).not.toContain("decline");
  });

  it("is never asked of Chess 1.0.2: no rematch frame in version 1", async () => {
    const sides = await startChat("1.0.2");
    await sides.white.game.resign();
    await settle(sides.white, sides.black);
    const count = sides.white.broker.sent.length;
    await sides.white.game.rematch();
    await settle(sides.white, sides.black);
    expect(sides.white.broker.sent.length).toBe(count);
    expect(featureHint(sides.white.game.view(), "rematch", en)).toBe("Your contact needs to update Chess (they have 1.0.2)");
  });
});
