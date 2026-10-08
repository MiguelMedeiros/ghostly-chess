// covers: apps.chess
import { describe, expect, it } from "vitest";
import type { Square } from "chess.js";
import { ChessController, type Notice, type SavedFlip, type SavedGame } from "../src/game.ts";
import { pgnOfGame } from "../src/pgn.ts";
import { encodeMessage, encodeV1, MAX_MESSAGE_BYTES, speaksV2, type Envelope, type Message } from "../src/protocol.ts";
import { commitment, deal, deal2, newSalt } from "../src/toss.ts";
import { chatPair, MockBroker } from "./mockBroker.ts";

/** A side of the chat: its broker, its app, and what the app reported. */
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

/** Until no frame is on its way and both apps handled what they got. */
async function settle(...sides: Side[]): Promise<void> {
  for (let idle = 0; idle < 3; ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(sides.map((s) => s.game.settled()));
    idle = sides.every((s) => s.broker.inFlight === 0) ? idle + 1 : 0;
  }
}

/** Protocol 2: `inviter` invites to an unlimited game and `invitee` accepts it. */
async function agree(inviter: Side, invitee: Side): Promise<void> {
  await inviter.game.invite();
  await settle(inviter, invitee);
  await invitee.game.acceptInvitation();
  await settle(inviter, invitee);
}

/** Two open sides on Chess `version`, with a game: tossed by itself in version 1, invited and accepted in version 2. */
async function start(version = "2.0.0"): Promise<{ ana: Side; bob: Side; white: Side; black: Side }> {
  const [a, b] = chatPair(version);
  const ana = await open(a);
  const bob = await open(b);
  await settle(ana, bob);
  if (speaksV2(version)) await agree(ana, bob);
  const white = ana.game.view().me === "w" ? ana : bob;
  const black = white === ana ? bob : ana;
  return { ana, bob, white, black };
}

/** Plays a UCI ply by the side to move, through its app, and lets it arrive. */
async function play(sides: { white: Side; black: Side }, ...plies: string[]): Promise<void> {
  for (const uci of plies) {
    const mover = sides.white.game.view().turn === "w" ? sides.white : sides.black;
    const ok = await mover.game.move(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, uci[4] as "q" | undefined);
    expect(ok, `${uci} by ${mover.broker.name}`).toBe(true);
    await settle(sides.white, sides.black);
  }
}

const saved = (side: Side) => JSON.parse(side.broker.stored.get("game")!) as SavedGame;
const savedFlip = (side: Side) => JSON.parse(side.broker.stored.get("flip")!) as SavedFlip;
const kinds = (broker: MockBroker) => broker.sent.map((m) => (m as { k: string }).k);

/** Both protocols: with a 1.0.2-era version (1.0.2's own flow) and with protocol 2. */
const MODES = [
  { mode: "v1", version: "1.0.2", env: 1 as Envelope },
  { mode: "v2", version: "2.0.0", env: 2 as Envelope },
];
const SCHOLARS_MATE = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"];

describe("the colour toss in version 1 (as Chess 1.0.2)", () => {
  it("starts when the contact's side was open before this app listened (an event while loading is not lost)", async () => {
    // The client answered `context` before its chat open had (peer: null), then said the contact is open, and the
    // contact's seek came, all while this app was still loading: it waited for a contact who was there.
    class LateBroker extends MockBroker {
      override async context() { return { ...(await super.context()), peer: null }; }
    }
    const a = new MockBroker("ana", "1.0.2"), b = new LateBroker("bob", "1.0.2");
    a.peer = b;
    b.peer = a;
    const ana = await open(a);
    // Alone in the chat: the new-game panel, so an invitation can wait for the contact.
    expect(ana.game.view().phase).toBe("setup");
    const game = new ChessController(b);
    b.launch();
    b.emitPeer({ open: true, version: a.version });
    for (let i = 0; i < 10 || b.inFlight || a.inFlight; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await game.start();
    const bob: Side = { broker: b, game, notices: [] };
    await settle(ana, bob);
    expect(ana.game.view().phase).toBe("playing");
    expect(bob.game.view().phase).toBe("playing");
    expect(bob.game.view().peerOpen).toBe(true);
  });

  it("gives the two sides one game and opposite colours, by the v1 deal", async () => {
    const { ana, bob } = await start("1.0.2");
    const a = ana.game.view();
    const b = bob.game.view();
    expect(a.phase).toBe("playing");
    expect(b.phase).toBe("playing");
    expect(a.mode).toBe("v1");
    expect(new Set([a.me, b.me])).toEqual(new Set(["w", "b"]));
    expect(saved(ana).g).toBe(saved(bob).g);
    expect(saved(ana).s).toEqual([saved(bob).s[1], saved(bob).s[0]]);
    expect(saved(ana).dv).toBe(1);
    expect(saved(ana).g).toBe(deal(saved(ana).s[0], saved(ana).s[1]).g);
    expect(ana.notices).toEqual([]);
    expect(bob.notices).toEqual([]);
    // Nothing but version 1 frames went either way.
    for (const m of [...ana.broker.sent, ...bob.broker.sent]) expect((m as { v: number }).v).toBe(1);
  });

  it("decides colours from both salts, so either colour comes up", async () => {
    const colours = new Set<string>();
    for (let i = 0; i < 12 && colours.size < 2; i++) colours.add((await start("1.0.2")).ana.game.view().me!);
    expect(colours).toEqual(new Set(["w", "b"]));
  });

  it("refuses a reveal that does not match the commitment", async () => {
    const [a, b] = chatPair("1.0.2");
    const ana = await open(a);
    b.launch(); // Bob's side is a script here, not the app
    await settle(ana);
    const bobSalt = newSalt();
    a.inject(encodeV1({ k: "seek", c: commitment(bobSalt), a: [] }));
    await settle(ana);
    const anaSeek = a.sent.find((m) => (m as { k?: string }).k === "seek") as { c: string };
    a.inject(encodeV1({ k: "reveal", s: newSalt(), c: anaSeek.c }));
    await settle(ana);
    expect(ana.notices).toContain("bad-reveal");
    expect(ana.game.view().phase).toBe("toss");
  });

  it("does not let a peer skip the toss with a made-up game", async () => {
    for (const env of [1, 2] as Envelope[]) {
      const [a, b] = chatPair(env === 1 ? "1.0.2" : "2.0.0");
      const ana = await open(a);
      b.launch();
      await settle(ana);
      if (env === 2) a.inject(encodeMessage({ k: "hello", pv: 2, f: [] }));
      // A game from two salts Ana never saw, in which the forger's side happens to be white.
      let forged: { g: string; s: [string, string] } | undefined;
      while (!forged) {
        const mine = newSalt();
        const fake = newSalt();
        const d = env === 1 ? deal(mine, fake) : deal2(mine, fake, {});
        if (d.me === "w") forged = { g: d.g, s: [mine, fake] };
      }
      a.inject(encodeMessage({ k: "sync", g: forged.g, s: forged.s, m: ["e2e4"] }, env));
      await settle(ana);
      expect(ana.game.view().phase, `v${env}`).toBe("out-of-step");
      expect(ana.game.view().plies).toBe(0);
      expect(a.stored.has("game")).toBe(false);
    }
  });

  it("finishes the toss when one side reloads in the middle of it", async () => {
    const [a, b] = chatPair("1.0.2");
    const ana = await open(a);
    b.launch();
    const bob1 = new ChessController(b);
    await bob1.start();
    // Bob's app goes before the toss finishes; its salt is in storage, so the toss can end with the same colours.
    bob1.stop();
    b.shutdown();
    await settle(ana);
    const bob = await open(b);
    await settle(ana, bob);
    expect(ana.game.view().phase).toBe("playing");
    expect(bob.game.view().phase).toBe("playing");
    expect(new Set([ana.game.view().me, bob.game.view().me])).toEqual(new Set(["w", "b"]));
    expect(saved(ana).g).toBe(saved(bob).g);
  });
});

describe("invitations in version 2", () => {
  it("opens with hellos and the new-game panel, and no toss by itself", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    const bob = await open(b);
    await settle(ana, bob);
    for (const side of [ana, bob]) {
      expect(side.game.view().phase).toBe("setup");
      expect(side.game.view().mode).toBe("v2");
      // Each says hello, then answers the other's with re: 1. Neither answer is answered.
      expect(kinds(side.broker)).toEqual(["hello", "hello"]);
      expect(side.broker.sent.map((f) => (f as { re?: number }).re)).toEqual([undefined, 1]);
    }
  });

  it("starts a game when an invitation is accepted, by deal2 with its terms", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    const bob = await open(b);
    await settle(ana, bob);
    await ana.game.invite();
    await settle(ana, bob);
    expect(ana.game.view().phase).toBe("invited");
    expect(ana.game.view().proposal).toEqual({ rematch: false });
    expect(bob.game.view().invitation).toEqual({ rematch: false, playable: true });
    expect(bob.game.view().phase).toBe("setup");
    await bob.game.acceptInvitation();
    await settle(ana, bob);
    for (const side of [ana, bob]) {
      expect(side.game.view().phase).toBe("playing");
      expect(side.game.view().invitation).toBeUndefined();
      expect(side.notices).toEqual([]);
      expect(side.broker.stored.has("flip")).toBe(false);
    }
    expect(new Set([ana.game.view().me, bob.game.view().me])).toEqual(new Set(["w", "b"]));
    const record = saved(ana);
    expect(record.dv).toBe(2);
    expect(record.g).toBe(saved(bob).g);
    expect(record.g).toBe(deal2(record.s[0], record.s[1], {}).g);
    expect(record.g).not.toBe(deal(record.s[0], record.s[1]).g);
  });

  it("goes back to the new-game panel on both sides when an invitation is declined, with a notice", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    const bob = await open(b);
    await settle(ana, bob);
    await ana.game.invite();
    await settle(ana, bob);
    await bob.game.declineInvitation();
    await settle(ana, bob);
    expect(ana.game.view().phase).toBe("setup");
    expect(bob.game.view().phase).toBe("setup");
    expect(bob.game.view().invitation).toBeUndefined();
    expect(ana.notices).toEqual(["declined"]);
    expect(a.stored.has("flip")).toBe(false);
    const anaSeek = a.sent.find((m) => (m as { k: string }).k === "seek") as { c: string };
    expect(b.sent.filter((m) => (m as { k: string }).k === "decline")).toEqual([{ p: "chess", v: 2, k: "decline", c: anaSeek.c }]);
  });

  it("keeps two seeks with different terms open, each showing the other's, and the contact's latest replaces its card", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    b.launch(); // Bob is a later Chess with clocks: a script here
    await settle(ana);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: ["clock"] }));
    await settle(ana);
    await ana.game.invite();
    const bobSalt = newSalt();
    a.inject(encodeMessage({ k: "seek", c: commitment(bobSalt), a: [], tc: [300, 0] }));
    await settle(ana);
    // Both proposals stand: Ana's own, waiting, and Bob's, shown.
    expect(ana.game.view().phase).toBe("invited");
    expect(ana.game.view().proposal).toEqual({ rematch: false });
    expect(ana.game.view().invitation).toEqual({ tc: [300, 0], rematch: false, playable: true });
    // A seek with other terms never completes: no reveal went.
    expect(kinds(a)).toEqual(["hello", "hello", "seek"]);
    // Bob seeks again and again: one card, the latest.
    for (const tc of [[600, 0], [180, 2]] as [number, number][]) a.inject(encodeMessage({ k: "seek", c: commitment(newSalt()), a: [], tc }));
    await settle(ana);
    expect(ana.game.view().invitation).toEqual({ tc: [180, 2], rematch: false, playable: true });
    expect(ana.notices).toEqual([]);
    expect(a.stored.has("game")).toBe(false);
    expect(savedFlip(ana).tc).toBeUndefined();
  });

  it("keeps an invitation made while the contact is away, and sends it when they open Chess, also after a reload", async () => {
    const [a, b] = chatPair();
    const ana1 = await open(a);
    expect(ana1.game.view().phase).toBe("setup");
    await ana1.game.invite();
    expect(ana1.game.view().phase).toBe("invited");
    const flip = savedFlip(ana1);
    expect(flip).toMatchObject({ v: 2, a: [] });
    expect(a.sent).toEqual([]);
    // Ana reloads: the same invitation, the same salt.
    ana1.game.stop();
    a.shutdown();
    const ana = await open(a);
    expect(ana.game.view().phase).toBe("invited");
    expect(savedFlip(ana).salt).toBe(flip.salt);
    const bob = await open(b);
    await settle(ana, bob);
    expect(bob.game.view().invitation).toEqual({ rematch: false, playable: true });
    expect((a.sent.find((m) => (m as { k: string }).k === "seek") as { c: string }).c).toBe(commitment(flip.salt));
    await bob.game.acceptInvitation();
    await settle(ana, bob);
    expect(ana.game.view().phase).toBe("playing");
    expect(bob.game.view().phase).toBe("playing");
    expect(saved(ana).s[0]).toBe(flip.salt);
  });

  it("finishes the toss when the inviter reloads after the contact accepted", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    const bob = await open(b);
    await settle(ana, bob);
    await ana.game.invite();
    await settle(ana, bob);
    // Ana's app goes just as Bob accepts: his seek and reveal are lost.
    ana.game.stop();
    a.shutdown();
    await bob.game.acceptInvitation();
    await settle(bob);
    const back = await open(a);
    await settle(back, bob);
    expect(back.game.view().phase).toBe("playing");
    expect(bob.game.view().phase).toBe("playing");
    expect(saved(back).g).toBe(saved(bob).g);
  });

  it("takes a different game id for the same salts with other terms, and shows a sync claiming other terms as out of step", async () => {
    const mine = newSalt();
    const theirs = newSalt();
    expect(deal2(mine, theirs, {}).g).not.toBe(deal2(mine, theirs, { tc: [300, 0] }).g);
    expect(deal2(mine, theirs, { tc: [300, 0] }).g).not.toBe(deal2(mine, theirs, { tc: [300, 1] }).g);
    const { black } = await start();
    const s = saved(black);
    const other = deal2(s.s[0], s.s[1], { tc: [300, 0] }).g;
    black.broker.inject(encodeMessage({ k: "sync", g: other, s: [s.s[1], s.s[0]], m: [], tc: [300, 0] }));
    await settle(black);
    expect(black.game.view().phase).toBe("out-of-step");
    expect(black.notices).toEqual(["out-of-step"]);
  });

  it("shows a version 1 frame naming a dv:2 game as out of step", async () => {
    for (const frame of [
      (g: string, s: SavedGame) => encodeV1({ k: "move", g, n: 0, m: "e2e4" }),
      (g: string, s: SavedGame) => encodeV1({ k: "sync", g, s: [s.s[1], s.s[0]], m: [] }),
      (g: string) => encodeV1({ k: "resign", g }),
      (g: string) => encodeV1({ k: "draw", g, o: "offer" }),
    ]) {
      const { black } = await start();
      const s = saved(black);
      black.broker.inject(frame(s.g, s));
      await settle(black);
      expect(black.game.view().phase).toBe("out-of-step");
      expect(black.notices).toEqual(["out-of-step"]);
      expect(saved(black)).toEqual(s);
    }
  });

  it("declines a rematch of a game this side does not hold as its last one", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    b.launch();
    await settle(ana);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: ["rematch"] }));
    const c = commitment(newSalt());
    a.inject(encodeMessage({ k: "seek", c, a: [], r: "0123456789abcdef" }));
    await settle(ana);
    expect(ana.notices).toEqual([]);
    expect(ana.game.view().invitation).toBeUndefined();
    expect(a.sent.at(-1)).toEqual({ p: "chess", v: 2, k: "decline", c });
  });
});

describe("one deal per toss", () => {
  /** Ana (today's Chess) invites; a scripted contact accepts with its seek and holds its reveal. */
  async function heldReveal(): Promise<{ ana: Side; sA: string; sB: string }> {
    const [a, b] = chatPair();
    const ana = await open(a);
    b.launch();
    await settle(ana);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: [] }));
    await settle(ana);
    await ana.game.invite();
    const sB = newSalt();
    a.inject(encodeMessage({ k: "seek", c: commitment(sB), a: [] }));
    await settle(ana);
    const reveal = a.sent.find((m) => (m as { k: string }).k === "reveal") as { s: string } | undefined;
    expect(reveal).toBeDefined();
    expect(savedFlip(ana).dv).toBe(2);
    return { ana, sA: reveal!.s, sB };
  }

  it("starts no game from a version 1 sync of the same salts after a version 2 invitation: no side picks its colour", async () => {
    const { ana, sA, sB } = await heldReveal();
    // The contact has seen Ana's salt, and tries the version 1 deal of the same salts instead of revealing.
    ana.broker.inject(encodeV1({ k: "sync", g: deal(sB, sA).g, s: [sB, sA], m: [] }));
    await settle(ana);
    expect(ana.broker.stored.has("game")).toBe(false);
    expect(ana.game.view().phase).toBe("invited");
    expect(ana.notices).toEqual(["bad-message"]);
    // Nor in the version 2 envelope.
    ana.broker.inject(encodeMessage({ k: "sync", g: deal(sB, sA).g, s: [sB, sA], m: [] }));
    await settle(ana);
    expect(ana.broker.stored.has("game")).toBe(false);
    // The toss still ends, by the deal it is for.
    ana.broker.inject(encodeMessage({ k: "reveal", s: sB, c: commitment(sA) }));
    await settle(ana);
    expect(saved(ana)).toMatchObject({ dv: 2, g: deal2(sA, sB, {}).g, me: deal2(sA, sB, {}).me });
  });

  it("takes a reveal by the deal the toss is for, whatever envelope it comes in", async () => {
    const { ana, sA, sB } = await heldReveal();
    ana.broker.inject(encodeV1({ k: "reveal", s: sB, c: commitment(sA) }));
    await settle(ana);
    expect(saved(ana)).toMatchObject({ dv: 2, g: deal2(sA, sB, {}).g });
  });
});

describe("a side out of step in version 2", () => {
  it("starts a new game after its storage is lost mid-game: New game, Invite, and the contact accepts", async () => {
    const sides = await start();
    await play(sides, "e2e4", "e7e5");
    const { ana, bob } = sides;
    const old = saved(bob).g;
    ana.game.stop();
    ana.broker.shutdown();
    await settle(bob);
    ana.broker.stored.clear();
    const back = await open(ana.broker);
    await settle(back, bob);
    expect(back.game.view().phase).toBe("out-of-step");
    await back.game.newGame();
    await settle(back, bob);
    expect(back.game.view().phase).toBe("setup");
    await back.game.invite();
    await settle(back, bob);
    // The seek gives up the contact's game, so it shows as an invitation, not as a game to resync.
    expect((back.broker.sent.filter((m) => (m as { k: string }).k === "seek").at(-1) as { a: string[] }).a).toEqual([old]);
    expect(bob.game.view().invitation).toEqual({ rematch: false, playable: true });
    await bob.game.acceptInvitation();
    await settle(back, bob);
    for (const side of [back, bob]) {
      expect(side.game.view().phase).toBe("playing");
      expect(side.game.view().plies).toBe(0);
    }
    expect(saved(back).g).toBe(saved(bob).g);
    expect(saved(back).g).not.toBe(old);
  });
});

describe("terms this build cannot play", () => {
  it("shows a timed invitation from a contact that names no clock, but never accepts it", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    b.launch();
    await settle(ana);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: ["takeback"] }));
    await settle(ana);
    a.inject(encodeMessage({ k: "seek", c: commitment(newSalt()), a: [], tc: [60, 0] }));
    await settle(ana);
    expect(ana.game.view().invitation).toEqual({ tc: [60, 0], rematch: false, playable: false });
    const sent = a.sent.length;
    await ana.game.acceptInvitation();
    await settle(ana);
    expect(a.sent.length).toBe(sent);
    expect(a.stored.has("flip")).toBe(false);
    expect(ana.game.view().phase).toBe("setup");
    // Declining it still works.
    await ana.game.declineInvitation();
    await settle(ana);
    expect(kinds(a).at(-1)).toBe("decline");
  });

  it("shows a rematch invitation to a build without rematches (2.1.0), but never accepts it", async () => {
    const [a, b] = chatPair();
    const last = "0123456789abcdef";
    a.stored.set("prev", JSON.stringify({ g: last, me: "w" }));
    a.launch();
    const ana: Side = { broker: a, game: new ChessController(a, { features: ["clock"] }), notices: [] };
    ana.game.onNotice((n) => ana.notices.push(n));
    await ana.game.start();
    b.launch();
    await settle(ana);
    // The contact (scripted) names rematches and asks for one.
    a.inject(encodeMessage({ k: "hello", pv: 2, f: ["clock", "rematch"] }));
    a.inject(encodeMessage({ k: "seek", c: commitment(newSalt()), a: [], r: last }));
    await settle(ana);
    expect(ana.game.view().invitation).toEqual({ r: last, rematch: true, playable: false });
    const sent = a.sent.length;
    await ana.game.acceptInvitation();
    await settle(ana);
    expect(a.sent.length).toBe(sent);
    expect(a.stored.has("flip")).toBe(false);
    expect(ana.notices).toEqual([]);
  });
});

describe("a resignation and a move made while the contact was away", () => {
  it("ends with one history: the resigner's, and the move it never saw is dropped", async () => {
    const sides = await start();
    await play(sides, "e2e4");
    const { white, black } = sides;
    // White closes; black moves while white is away, then closes.
    white.game.stop();
    white.broker.shutdown();
    await settle(black);
    expect(await black.game.move("e7", "e5")).toBe(true);
    black.game.stop();
    black.broker.shutdown();
    // White opens while black is away and resigns at ply 1 (its board still says black to move).
    const w = await open(white.broker);
    await settle(w);
    await w.game.resign();
    await settle(w);
    const b = await open(black.broker);
    await settle(w, b);
    for (const side of [w, b]) {
      expect(side.game.view().phase).toBe("over");
      expect(side.game.view().end).toEqual({ result: "0-1", why: "resign" });
      expect(side.game.view().plies).toBe(1);
      expect(side.notices).toEqual([]);
    }
    expect(saved(b).m).toEqual(["e2e4"]);
  });
});

describe.each(MODES)("a game over the mock broker, $mode", ({ version, env }) => {
  it("plays Scholar's mate, and both boards show mate", async () => {
    const sides = await start(version);
    await play(sides, ...SCHOLARS_MATE);
    for (const side of [sides.white, sides.black]) {
      const view = side.game.view();
      expect(view.phase).toBe("over");
      expect(view.end).toEqual({ result: "1-0", why: "checkmate" });
      expect(view.plies).toBe(7);
      expect(view.canMove).toBe(false);
      expect(side.notices).toEqual([]);
    }
    expect(sides.white.game.view().fen).toBe(sides.black.game.view().fen);
    expect(saved(sides.white).m).toEqual(SCHOLARS_MATE);
    expect(saved(sides.black).m).toEqual(SCHOLARS_MATE);
    for (const m of [...sides.ana.broker.sent, ...sides.bob.broker.sent]) expect((m as { v: number }).v).toBe(env);
  });

  it("keeps every message well under the frame cap", async () => {
    const sides = await start(version);
    await play(sides, ...SCHOLARS_MATE);
    for (const value of [...sides.ana.broker.sent, ...sides.bob.broker.sent]) {
      expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThan(MAX_MESSAGE_BYTES);
    }
  });

  it("moves while the contact has Chess closed, and the move reaches them in the sync", async () => {
    const sides = await start(version);
    await play(sides, "e2e4");
    sides.white.game.stop();
    sides.white.broker.shutdown();
    await settle(sides.black);
    expect(sides.black.game.view().peerOpen).toBe(false);
    expect(sides.black.game.view().canMove).toBe(true);
    const sentBefore = sides.black.broker.sent.length;
    expect(await sides.black.game.move("e7", "e5")).toBe(true);
    // Frames stay live-only: nothing went, the move waits here.
    expect(sides.black.broker.sent.length).toBe(sentBefore);
    expect(saved(sides.black).m).toEqual(["e2e4", "e7e5"]);
    expect(sides.black.notices).toEqual([]);
    // Only one: it is the contact's turn now.
    expect(await sides.black.game.move("d7", "d5")).toBe(false);
    const white = await open(sides.white.broker);
    await settle(white, sides.black);
    expect(saved(white).m).toEqual(["e2e4", "e7e5"]);
    expect(white.game.view().canMove).toBe(true);
    expect([...white.notices, ...sides.black.notices]).toEqual([]);
  });

  it("resumes after a reload mid-game, from storage and the catch-up", async () => {
    const sides = await start(version);
    await play(sides, "e2e4", "e7e5", "f1c4");
    // Black reloads: its app goes, then comes back on the same storage.
    sides.black.game.stop();
    sides.black.broker.shutdown();
    await settle(sides.white);
    const black = await open(sides.black.broker);
    await settle(sides.white, black);
    const view = black.game.view();
    expect(view.phase).toBe("playing");
    expect(view.me).toBe("b");
    expect(view.plies).toBe(3);
    expect(view.fen).toBe(sides.white.game.view().fen);
    expect(view.canMove).toBe(true);
    await play({ white: sides.white, black }, "b8c6", "d1h5", "g8f6", "h5f7");
    expect(black.game.view().end).toEqual({ result: "1-0", why: "checkmate" });
    expect(sides.white.game.view().end).toEqual({ result: "1-0", why: "checkmate" });
    expect([...sides.white.notices, ...black.notices]).toEqual([]);
  });

  it("catches up a move that was lost when the contact's app closed", async () => {
    const sides = await start(version);
    await play(sides, "e2e4", "e7e5");
    // White moves, and Black's app closes before the frame arrives.
    await sides.white.game.move("f1", "c4");
    sides.black.game.stop();
    sides.black.broker.shutdown();
    await settle(sides.white);
    expect(saved(sides.black).m).toEqual(["e2e4", "e7e5"]);
    const black = await open(sides.black.broker);
    await settle(sides.white, black);
    expect(black.game.view().plies).toBe(3);
    expect(saved(black).m).toEqual(["e2e4", "e7e5", "f1c4"]);
    expect(black.game.view().canMove).toBe(true);
  });
});

describe.each(MODES)("a hostile or broken peer, $mode", ({ version, env }) => {
  const enc = (message: Message) => encodeMessage(message, env);

  it("ignores and reports a move out of turn, illegal moves, a wrong ply number and a wrong promotion", async () => {
    const sides = await start(version);
    await play(sides, "e2e4");
    const { black, white } = sides;
    const g = saved(black).g;
    // Black is to move, so any move from White's side now is out of turn.
    black.broker.inject(enc({ k: "move", g, n: 1, m: "d2d4" }));
    await settle(black, white);
    expect(black.notices).toEqual(["invalid-move"]);
    expect(saved(black).m).toEqual(["e2e4"]);
    await play(sides, "e7e5");
    const position = black.game.view().fen;
    for (const m of ["e4e5", "g1g4", "e1e3"]) black.broker.inject(enc({ k: "move", g, n: 2, m })); // illegal
    black.broker.inject(enc({ k: "move", g, n: 4, m: "d2d4" })); // a ply that is not next
    black.broker.inject(enc({ k: "move", g, n: 2, m: "g1f3q" })); // a legal move with a promotion it does not have
    await settle(black, white);
    expect(black.notices.filter((n) => n === "invalid-move")).toHaveLength(6);
    expect(black.game.view().fen).toBe(position);
    expect(saved(black).m).toEqual(["e2e4", "e7e5"]);
    // The game goes on as if nothing came.
    await play(sides, "f1c4", "b8c6", "d1h5", "g8f6", "h5f7");
    expect(black.game.view().end?.why).toBe("checkmate");
    expect(white.notices).toEqual([]);
  });

  it("ignores and reports malformed messages", async () => {
    const sides = await start(version);
    await play(sides, "e2e4");
    const { black } = sides;
    const g = saved(black).g;
    const before = JSON.stringify(saved(black));
    const junk: unknown[] = [
      null,
      42,
      "e7e5",
      [],
      {},
      { p: "checkers", v: env, k: "move", g, n: 1, m: "e7e5" },
      { p: "chess", v: String(env), k: "move", g, n: 1, m: "e7e5" },
      { p: "chess", v: env, k: "castle" },
      { p: "chess", v: env, k: "move", g: "not-a-game-id!!!", n: 1, m: "e7e5" },
      { p: "chess", v: env, k: "move", g, n: -1, m: "e7e5" },
      { p: "chess", v: env, k: "move", g, n: 1.5, m: "e7e5" },
      { p: "chess", v: env, k: "move", g, n: 1, m: "Nf3" },
      { p: "chess", v: env, k: "move", g, n: 1, m: { from: "e7", to: "e5" } },
      { p: "chess", v: env, k: "sync", g, s: ["x", "y"], m: "" },
      { p: "chess", v: env, k: "sync", g, s: [newSalt(), newSalt()], m: "e2e4  e7e5" },
      { p: "chess", v: env, k: "sync", g, s: [newSalt(), newSalt()], m: "", x: { why: "timeout" } },
      { p: "chess", v: env, k: "seek", c: "abc", a: [] },
      { p: "chess", v: env, k: "seek", c: commitment(newSalt()), a: [g, g, g] },
      { p: "chess", v: env, k: "draw", g, o: "maybe" },
      { p: "chess", v: env, k: "resign" },
      { p: "chess", v: 0, k: "resign", g },
    ];
    for (const value of junk) black.broker.inject(value);
    await settle(sides.white, black);
    expect(black.notices.filter((n) => n === "bad-message")).toHaveLength(junk.length);
    expect(JSON.stringify(saved(black))).toBe(before);
    expect(black.game.view().phase).toBe("playing");
  });

  it("says when the contact has a newer Chess", async () => {
    const sides = await start(version);
    sides.black.broker.inject({ p: "chess", v: 3, k: "move", g: saved(sides.black).g, n: 0, m: "e2e4" });
    await settle(sides.black);
    expect(sides.black.notices).toEqual(["newer-version"]);
  });

  it("ignores and reports an oversized message before reading it", async () => {
    const sides = await start(version);
    await play(sides, "e2e4");
    const { black } = sides;
    const g = saved(black).g;
    const huge = { p: "chess", v: env, k: "sync", g, s: saved(black).s, m: Array.from({ length: 4000 }, () => "e2e4").join(" ") };
    expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    black.broker.inject(huge);
    black.broker.inject({ p: "chess", v: env, k: "move", g, n: 1, m: "e7e5", pad: "x".repeat(MAX_MESSAGE_BYTES) });
    await settle(black);
    expect(black.notices).toEqual(["too-big", "too-big"]);
    expect(saved(black).m).toEqual(["e2e4"]);
  });

  it("does not take a resignation for this side, or an accepted draw it never offered", async () => {
    const sides = await start(version);
    await play(sides, "e2e4");
    const { black } = sides;
    const s = saved(black);
    black.broker.inject(enc({ k: "sync", g: s.g, s: [s.s[1], s.s[0]], m: s.m, x: { why: "resign", by: "b" } }));
    black.broker.inject(enc({ k: "sync", g: s.g, s: [s.s[1], s.s[0]], m: s.m, x: { why: "agreed" } }));
    black.broker.inject(enc({ k: "draw", g: s.g, o: "accept", n: s.m.length }));
    await settle(black);
    expect(black.notices).toEqual(["bad-message", "bad-message", "bad-message"]);
    expect(black.game.view().end).toBeUndefined();
  });
});

describe.each(MODES)("ending a game, $mode", ({ mode, version }) => {
  it("resigns, and both sides see who won", async () => {
    const sides = await start(version);
    await play(sides, "e2e4");
    await sides.black.game.resign();
    await settle(sides.white, sides.black);
    for (const side of [sides.white, sides.black]) expect(side.game.view().end).toEqual({ result: "1-0", why: "resign" });
    expect(await sides.white.game.move("d2", "d4")).toBe(false);
  });

  it("draws by agreement, and a declined offer lapses", async () => {
    const sides = await start(version);
    await play(sides, "e2e4");
    await sides.black.game.offerDraw();
    await settle(sides.white, sides.black);
    expect(sides.white.game.view().drawOffer).toBe("peer");
    await sides.white.game.answerDraw(false);
    await settle(sides.white, sides.black);
    expect(sides.black.game.view().drawOffer).toBeUndefined();
    await sides.white.game.offerDraw();
    await settle(sides.white, sides.black);
    await sides.black.game.answerDraw(true);
    await settle(sides.white, sides.black);
    for (const side of [sides.white, sides.black]) expect(side.game.view().end).toEqual({ result: "1/2-1/2", why: "agreed" });
  });

  it("draws by threefold repetition", async () => {
    const sides = await start(version);
    await play(sides, "g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8");
    for (const side of [sides.white, sides.black]) expect(side.game.view().end).toEqual({ result: "1/2-1/2", why: "repetition" });
  });

  it(mode === "v1" ? "starts a new game after one ends, with a new toss at once" : "starts a new game after one ends, through the new-game panel", async () => {
    const sides = await start(version);
    const first = saved(sides.white).g;
    await play(sides, ...SCHOLARS_MATE);
    await sides.black.game.newGame();
    await settle(sides.white, sides.black);
    if (mode === "v2") {
      expect(sides.black.game.view().phase).toBe("setup");
      expect(sides.black.game.view().end).toBeUndefined();
      expect(sides.white.game.view().phase).toBe("over");
      await agree(sides.black, sides.white);
    }
    for (const side of [sides.white, sides.black]) {
      expect(side.game.view().phase).toBe("playing");
      expect(side.game.view().plies).toBe(0);
    }
    expect(saved(sides.white).g).not.toBe(first);
    expect(saved(sides.white).g).toBe(saved(sides.black).g);
    // The finished game is kept as the last one, for a rematch's colours.
    expect(JSON.parse(sides.white.broker.stored.get("prev")!)).toMatchObject({ g: first });
  });
});

describe("draw offers in version 2 (both sides on 2.2.0)", () => {
  it("keeps this side's offer through its own next move, and both sides agree on it", async () => {
    const sides = await start();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5");
    await white.game.offerDraw();
    await settle(white, black);
    await play(sides, "g1f3");
    expect(white.game.view().drawOffer).toBe("me");
    expect(black.game.view().drawOffer).toBe("peer");
    expect(white.game.view().drawAt).toBe(2);
    expect(black.game.view().drawAt).toBe(2);
    expect(sides.white.broker.sent.filter((m) => (m as { k: string }).k === "draw")).toEqual([expect.objectContaining({ o: "offer", n: 2 })]);
    await black.game.answerDraw(true);
    await settle(white, black);
    for (const side of [white, black]) {
      expect(side.game.view().end).toEqual({ result: "1/2-1/2", why: "agreed" });
      expect(side.game.view().plies).toBe(3);
      expect(side.notices).toEqual([]);
    }
  });

  it("lets the offer lapse when the contact moves instead of answering, on both sides", async () => {
    const sides = await start();
    const { white, black } = sides;
    await play(sides, "e2e4");
    await white.game.offerDraw(); // on Black's turn, after White's own move
    await settle(white, black);
    expect(black.game.view().drawOffer).toBe("peer");
    await play(sides, "e7e5");
    for (const side of [white, black]) expect(side.game.view().drawOffer).toBeUndefined();
    // One offer per own move: White may offer again only after its next move.
    expect(white.game.view().canDraw).toBe(false);
    await play(sides, "g1f3");
    expect(white.game.view().canDraw).toBe(true);
  });

  it("takes the contact's offer from a sync one ply back when that ply is the offerer's", async () => {
    const sides = await start();
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5");
    await white.game.offerDraw();
    // Black's Chess closes before it hears the offer, and White moves meanwhile.
    black.game.stop();
    black.broker.shutdown();
    await settle(white);
    expect(await white.game.move("g1", "f3")).toBe(true);
    const b = await open(black.broker);
    await settle(white, b);
    expect(saved(b).m).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(b.game.view().drawOffer).toBe("peer");
    expect(b.game.view().drawAt).toBe(2);
    await b.game.answerDraw(true);
    await settle(white, b);
    for (const side of [white, b]) expect(side.game.view().end).toEqual({ result: "1/2-1/2", why: "agreed" });
  });

  it("keeps 1.0.2's rule in version 1: any move clears an offer", async () => {
    const sides = await start("1.0.2");
    const { white, black } = sides;
    await play(sides, "e2e4", "e7e5");
    await white.game.offerDraw();
    await settle(white, black);
    expect(black.game.view().drawOffer).toBe("peer");
    await play(sides, "g1f3");
    for (const side of [white, black]) expect(side.game.view().drawOffer).toBeUndefined();
    expect(white.broker.sent.filter((m) => (m as { k: string }).k === "draw")).toEqual([{ p: "chess", v: 1, k: "draw", g: saved(white).g, o: "offer" }]);
  });

  it("clears an offer on any move with a contact on 2.1.0, as 1.0.2 does, so the two sides never disagree", async () => {
    const [a, b] = chatPair("2.1.0");
    const ana = await open(a);
    b.launch();
    const bob: Side = { broker: b, game: new ChessController(b, { features: ["clock"] }), notices: [] };
    await bob.game.start();
    await settle(ana, bob);
    await agree(ana, bob);
    const white = ana.game.view().me === "w" ? ana : bob;
    const black = white === ana ? bob : ana;
    await play({ white, black }, "e2e4", "e7e5");
    await white.game.offerDraw();
    await settle(white, black);
    await play({ white, black }, "g1f3");
    for (const side of [white, black]) expect(side.game.view().drawOffer).toBeUndefined();
  });
});

describe("abort", () => {
  it("is offered only before ply 2, to either side, and ends with no winner", async () => {
    const sides = await start();
    const { white, black } = sides;
    expect(white.game.view().canAbort).toBe(true);
    expect(black.game.view().canAbort).toBe(true);
    await play(sides, "e2e4");
    expect(black.game.view().canAbort).toBe(true);
    await black.game.abort();
    await settle(white, black);
    for (const side of [white, black]) {
      expect(side.game.view().end).toEqual({ result: "*", why: "aborted" });
      expect(side.game.view().phase).toBe("over");
      expect(saved(side).x).toEqual({ why: "aborted" });
      expect(side.notices).toEqual([]);
      const pgn = pgnOfGame(side.game);
      expect(pgn).toContain('[Result "*"]');
      expect(pgn).toContain('[Termination "abandoned"]');
      expect(pgn.trim().endsWith("1. e4 *")).toBe(true);
    }
    const late = await start();
    await play(late, "e2e4", "e7e5");
    expect(late.white.game.view().canAbort).toBe(false);
    await late.white.game.abort();
    await settle(late.white, late.black);
    expect(late.white.game.view().end).toBeUndefined();
  });

  it("drops a move that crossed the abort, so both sides end with one history", async () => {
    const sides = await start();
    const { white, black } = sides;
    await play(sides, "e2e4");
    // Both act at once: White aborts while Black plays its first move.
    await Promise.all([white.game.abort(), black.game.move("e7", "e5")]);
    await settle(white, black);
    for (const side of [white, black]) {
      expect(side.game.view().end).toEqual({ result: "*", why: "aborted" });
      expect(saved(side).m).toEqual(["e2e4"]);
      expect(side.notices).toEqual([]);
    }
  });

  it("is a bad message in a sync at ply 2 or later", async () => {
    const sides = await start();
    await play(sides, "e2e4", "e7e5");
    const s = saved(sides.black);
    sides.black.broker.inject(encodeMessage({ k: "sync", g: s.g, s: [s.s[1], s.s[0]], m: s.m, x: { why: "aborted" } }));
    await settle(sides.black);
    expect(sides.black.notices).toEqual(["bad-message"]);
    expect(sides.black.game.view().end).toBeUndefined();
  });

  it("is not offered to Chess 1.0.2: Resign stays", async () => {
    const sides = await start("1.0.2");
    expect(sides.white.game.view().canAbort).toBe(false);
  });
});

describe("alone", () => {
  it("plays both sides on one device and keeps the game", async () => {
    const broker = new MockBroker("solo", "1.0.0", false);
    broker.isOpen = true;
    const game = new ChessController(broker);
    await game.start();
    expect(game.view().phase).toBe("alone");
    for (const uci of SCHOLARS_MATE) expect(await game.move(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square)).toBe(true);
    expect(game.view().end).toEqual({ result: "1-0", why: "checkmate" });
    const again = new ChessController(broker);
    await again.start();
    expect(again.view().plies).toBe(7);
    expect(broker.sent).toEqual([]);
  });
});
