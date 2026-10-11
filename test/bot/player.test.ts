import { describe, expect, it } from "vitest";
import { drawWelcome, Player, type Policy, type Said } from "../../bot/player.ts";
import { open, settle, type Side } from "../sides.ts";
import { chatPair } from "../mockBroker.ts";

/** A seeded stand-in for Math.random, so a failing game can be played again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Two sides of one chat on Chess 2.3.0, both open; `bot` plays `side` by `policy`, and what it says is kept. */
async function chat() {
  const [a, b] = chatPair("2.3.0");
  const ana = await open(a), bob = await open(b);
  await settle(ana, bob);
  return { ana, bob };
}
function bot(side: Side, policy: Partial<Policy>, seed = 1) {
  const said: Said[] = [];
  const player = new Player(side.game, { level: 1, accept: true, takebacks: true, ...policy }, (s) => said.push(s), seeded(seed));
  void player.act();
  return { player, said };
}
/** Lets the two sides talk until neither has anything left to do. */
async function quiet(ana: Side, bob: Side, done: () => boolean, rounds = 4000): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) { await settle(ana, bob); await new Promise((resolve) => setTimeout(resolve, 0)); }
  expect(done(), "the two sides came to it").toBe(true);
}

describe("the bot as a player", () => {
  it("invites, and two bots play a whole game to its end", { timeout: 120_000 }, async () => {
    const { ana, bob } = await chat();
    const inviter = bot(ana, { invite: "unlimited", level: 1 }, 11);
    const guest = bot(bob, { level: 0 }, 12);
    await quiet(ana, bob, () => ana.game.view().phase === "over" && bob.game.view().phase === "over");
    expect(inviter.said[0]).toEqual({ what: "invited", tc: null });
    expect(guest.said[0]).toEqual({ what: "accepted", tc: null, rematch: false });
    const [a, b] = [ana.game.view(), bob.game.view()];
    // Both hold the same game, ended the same way, each on its own colour.
    expect(a.end).toEqual(b.end);
    expect(a.fen).toBe(b.fen);
    expect(new Set([a.me, b.me])).toEqual(new Set(["w", "b"]));
    expect(inviter.said.at(-1)).toEqual({ what: "over", end: a.end, plies: a.plies });
    expect(guest.said.at(-1)).toEqual({ what: "over", end: a.end, plies: a.plies });
    // Each bot moved only on its own turn: its plies are all of one parity.
    for (const side of [inviter, guest]) expect(new Set(side.said.filter((s) => s.what === "moved").map((s) => (s as { ply: number }).ply % 2)).size).toBe(1);
    inviter.player.stop(); guest.player.stop();
  });

  it("invites with a clock, and the game it starts has it", async () => {
    const { ana, bob } = await chat();
    const inviter = bot(ana, { invite: [600, 5] });
    await quiet(ana, bob, () => !!bob.game.view().invitation);
    expect(bob.game.view().invitation).toMatchObject({ tc: [600, 5], rematch: false, playable: true });
    await bob.game.acceptInvitation();
    await quiet(ana, bob, () => ana.game.view().phase === "playing");
    expect(ana.game.view().tc).toEqual([600, 5]);
    expect(inviter.said.find((s) => s.what === "started")).toMatchObject({ tc: [600, 5] });
    inviter.player.stop();
  });

  it("accepts a person's invitation and answers their moves; declines when told to play only its own", async () => {
    const { ana, bob } = await chat();
    const guest = bot(bob, {});
    await ana.game.invite([300, 0]);
    await quiet(ana, bob, () => ana.game.view().phase === "playing" && (ana.game.view().me === "w" ? ana.game.view().canMove : ana.game.view().plies === 1));
    expect(guest.said[0]).toEqual({ what: "accepted", tc: [300, 0], rematch: false });
    guest.player.stop();

    const other = await chat();
    const shy = bot(other.bob, { accept: false });
    await other.ana.game.invite();
    await quiet(other.ana, other.bob, () => shy.said.length > 0);
    expect(shy.said).toEqual([{ what: "declined", tc: null, rematch: false }]);
    expect(other.ana.game.view().phase).not.toBe("playing");
    shy.player.stop();
  });

  it("lets a move be taken back, or not, as told", async () => {
    for (const takebacks of [true, false]) {
      const { ana, bob } = await chat();
      const guest = bot(bob, { takebacks, level: 0 });
      await ana.game.invite();
      await quiet(ana, bob, () => ana.game.view().phase === "playing" && ana.game.view().canMove && ana.game.view().plies <= 1);
      const before = ana.game.view().plies;
      const target = ana.game.view().me === "w" ? (["e2", "e4"] as const) : (["e7", "e5"] as const);
      expect(await ana.game.move(target[0], target[1])).toBe(true);
      // Asked at once, before the bot's answer to the move is in: whichever came first, the bot answers the ask.
      await ana.game.takeback();
      await quiet(ana, bob, () => guest.said.some((s) => s.what === "takeback") || ana.game.view().plies > before + 1);
      const answer = guest.said.find((s) => s.what === "takeback");
      if (answer) expect(answer).toEqual({ what: "takeback", accepted: takebacks });
      guest.player.stop();
    }
  });

  it("takes a draw only when it is worse, or a long game stands even", () => {
    const even = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const queenDown = "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"; // black has no queen
    expect(drawWelcome(even, "w", 10)).toBe(false);
    expect(drawWelcome(even, "b", 130)).toBe(true);
    expect(drawWelcome(queenDown, "b", 10)).toBe(true);
    expect(drawWelcome(queenDown, "w", 130)).toBe(false);
  });
});
