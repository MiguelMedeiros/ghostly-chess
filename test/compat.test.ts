// @vitest-environment happy-dom
// covers: apps.chess
// Today's Chess against the real Chess 1.0.2 controller (test/legacy/1.0.2, byte-identical to what 1.0.2 shipped), on
// the mock broker: the compat mode speaks version 1 exactly as 1.0.2 does, a game in progress survives an update, and
// a move made while 1.0.2 was closed reaches it.
import type { Square } from "chess.js";
import { afterEach, describe, expect, it } from "vitest";
import { ChessController, OWN_FEATURES, type SavedGame } from "../src/game.ts";
import { presetState } from "../src/setup.ts";
import { PrefsStore } from "../src/prefs.ts";
import { en } from "../src/strings.ts";
import { mountChess } from "../src/ui.ts";
import { ChessController as Legacy, type Notice as LegacyNotice, type SavedGame as LegacySavedGame } from "./legacy/1.0.2/game.ts";
import { encodeMessage as legacyEncode, parseMessage as legacyParse } from "./legacy/1.0.2/protocol.ts";
import { chatPair, MockBroker } from "./mockBroker.ts";

afterEach(() => document.body.replaceChildren());

/** Either controller: the parts both have. */
interface Player {
  view(): { phase: string; me?: "w" | "b"; turn: "w" | "b"; plies: number; fen: string; canMove: boolean; end?: { result: string; why: string } };
  move(from: Square, to: Square, promotion?: "q" | "r" | "b" | "n"): Promise<boolean>;
  settled(): Promise<void>;
  stop(): void;
}

interface Side {
  broker: MockBroker;
  game: Player;
  notices: string[];
  legacy: boolean;
}

/** Opens Chess 1.0.2 (the frozen controller) on a broker. */
async function open102(broker: MockBroker): Promise<Side> {
  broker.launch();
  const game = new Legacy(broker);
  const notices: LegacyNotice[] = [];
  game.onNotice((n) => notices.push(n));
  await game.start();
  return { broker, game, notices, legacy: true };
}

/** Opens today's Chess on a broker. */
async function openNew(broker: MockBroker): Promise<Side & { game: ChessController }> {
  broker.launch();
  const game = new ChessController(broker);
  const notices: string[] = [];
  game.onNotice((n) => notices.push(n));
  await game.start();
  return { broker, game, notices, legacy: false };
}

async function settle(...sides: Side[]): Promise<void> {
  for (let idle = 0; idle < 3; ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(sides.map((s) => s.game.settled()));
    idle = sides.every((s) => s.broker.inFlight === 0) ? idle + 1 : 0;
  }
}

async function play(a: Side, b: Side, ...plies: string[]): Promise<void> {
  for (const uci of plies) {
    const mover = a.game.view().me === a.game.view().turn ? a : b;
    const ok = await mover.game.move(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, uci[4] as "q" | undefined);
    expect(ok, `${uci} by ${mover.broker.name}`).toBe(true);
    await settle(a, b);
  }
}

const close = async (side: Side, ...others: Side[]) => {
  side.game.stop();
  side.broker.shutdown();
  await settle(...others);
};

const SCHOLARS_MATE = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"];
const saved = (side: Side) => JSON.parse(side.broker.stored.get("game")!) as SavedGame | LegacySavedGame;

/**
 * Every frame today's Chess sent in version 1 is a frame Chess 1.0.2 could have written: version 1, read by 1.0.2's
 * own parser, and with exactly the keys 1.0.2's own encoder writes for it (no tc, n or other v2 field riding along).
 */
function expectOnly102Frames(side: Side): void {
  expect(side.broker.sent.length).toBeGreaterThan(0);
  for (const frame of side.broker.sent) {
    expect((frame as { v: number }).v, JSON.stringify(frame)).toBe(1);
    const parsed = legacyParse(JSON.parse(JSON.stringify(frame)));
    expect(parsed.ok, JSON.stringify(frame)).toBe(true);
    if (!parsed.ok) continue;
    const as102 = legacyEncode(parsed.message);
    expect(Object.keys(frame as object), JSON.stringify(frame)).toEqual(Object.keys(as102 as object));
    expect(frame).toEqual(as102);
  }
}

describe("today's Chess with Chess 1.0.2", () => {
  it("answers 1.0.2's toss as 1.0.2 would, and Scholar's mate ends on both boards", async () => {
    for (const first of ["1.0.2", "new"]) {
      const [a, b] = chatPair("1.0.2", "2.0.0");
      let old: Side;
      let now: Side;
      if (first === "1.0.2") {
        old = await open102(a);
        now = await openNew(b);
      } else {
        now = await openNew(b);
        old = await open102(a);
      }
      await settle(old, now);
      // 1.0.2 seeks by itself as it opens; the new side tossed with it, with no invitation.
      expect(a.sent[0]).toMatchObject({ p: "chess", v: 1, k: "seek" });
      expect(old.game.view().phase).toBe("playing");
      expect(now.game.view().phase).toBe("playing");
      expect((now.game as ChessController).view().mode).toBe("v1");
      expect(saved(now).g).toBe(saved(old).g);
      expect(new Set([old.game.view().me, now.game.view().me])).toEqual(new Set(["w", "b"]));
      expect((saved(now) as SavedGame).dv).toBe(1);
      await play(old, now, ...SCHOLARS_MATE);
      for (const side of [old, now]) {
        expect(side.game.view().end).toEqual({ result: "1-0", why: "checkmate" });
        expect(side.game.view().plies).toBe(7);
      }
      expect(old.game.view().fen).toBe(now.game.view().fen);
      expectOnly102Frames(now);
      expect(old.notices, first).toEqual([]);
      expect(now.notices, first).toEqual([]);
    }
  });

  it("never sends 1.0.2 a v2 frame: not on open, in play, on a draw, a resignation or a new game", async () => {
    const [a, b] = chatPair("1.0.2", "2.0.0");
    const old = await open102(a);
    const now = await openNew(b);
    await settle(old, now);
    await play(old, now, "e2e4", "e7e5");
    const nowGame = now.game as ChessController;
    await nowGame.offerDraw();
    await settle(old, now);
    await (old.game as Legacy).answerDraw(false);
    await settle(old, now);
    await (old.game as Legacy).offerDraw();
    await settle(old, now);
    await nowGame.answerDraw(true);
    await settle(old, now);
    expect(nowGame.view().end).toEqual({ result: "1/2-1/2", why: "agreed" });
    expect(old.game.view().end).toEqual({ result: "1/2-1/2", why: "agreed" });
    // A new game: in version 1 a new toss at once, as 1.0.2 does, with no invitation and no terms.
    await nowGame.newGame();
    await settle(old, now);
    expect(nowGame.view().phase).toBe("playing");
    expect(old.game.view().phase).toBe("playing");
    await play(old, now, "d2d4");
    const resigner = nowGame.view().me === "b" ? now : old;
    await (resigner.game as ChessController).resign();
    await settle(old, now);
    // 1.0.2 reloads: the new side syncs it, in version 1.
    await close(old, now);
    const back = await open102(a);
    await settle(back, now);
    expect(back.game.view().end?.why).toBe("resign");
    expectOnly102Frames(now);
    expect([...old.notices, ...back.notices]).not.toContain("newer-version");
    expect([...old.notices, ...back.notices]).toEqual([]);
  });

  it("offers 1.0.2 no timed game, and never sends it an ack, a t or a time control", async () => {
    const [a, b] = chatPair("1.0.2", "2.1.0");
    const old = await open102(a);
    const now = await openNew(b);
    await settle(old, now);
    const nowGame = now.game as ChessController;
    const view = nowGame.view();
    expect(view.features).toEqual([]);
    expect(presetState([300, 0], view, OWN_FEATURES, en)).toEqual({ enabled: false, reason: "Your contact needs to update Chess (they have 1.0.2)" });
    await play(old, now, "e2e4", "e7e5", "g1f3");
    for (let i = 0; i < 3; i++) await nowGame.tick();
    expect(nowGame.clocks()).toBeUndefined();
    await nowGame.resign();
    await settle(old, now);
    await nowGame.newGame();
    await nowGame.invite([300, 0]);
    await settle(old, now);
    for (const frame of now.broker.sent as Record<string, unknown>[]) {
      expect(frame.k, JSON.stringify(frame)).not.toBe("ack");
      expect(frame.k, JSON.stringify(frame)).not.toBe("flag");
      expect("t" in frame || "tc" in frame || (frame.k === "sync" && "c" in frame), JSON.stringify(frame)).toBe(false);
    }
    expectOnly102Frames(now);
    expect(old.notices).toEqual([]);
  });

  it("continues a game 1.0.2 saved mid-way after one side updates: the record migrates and the game id stays", async () => {
    const [a, b] = chatPair("1.0.2", "1.0.2");
    const ana = await open102(a);
    const bob = await open102(b);
    await settle(ana, bob);
    await play(ana, bob, "e2e4", "e7e5", "f1c4");
    const before = saved(bob) as LegacySavedGame;
    expect(before.v).toBe(1);
    // Bob updates Chess: his app closes, and the new version opens on the same storage.
    await close(bob, ana);
    b.version = "2.0.0";
    const updated = await openNew(b);
    await settle(ana, updated);
    const view = (updated.game as ChessController).view();
    expect(view.phase).toBe("playing");
    expect(view.mode).toBe("v1");
    expect(view.me).toBe(before.me);
    expect(view.plies).toBe(3);
    await play(ana, updated, "b8c6", "d1h5", "g8f6", "h5f7");
    const after = saved(updated) as SavedGame;
    expect(after.v).toBe(2);
    expect(after.dv).toBe(1);
    expect(after.g).toBe(before.g);
    expect(after.s).toEqual(before.s);
    expect(after.tc).toBeUndefined();
    for (const side of [ana, updated]) expect(side.game.view().end).toEqual({ result: "1-0", why: "checkmate" });
    expectOnly102Frames(updated);
    expect(ana.notices).toEqual([]);
    expect(updated.notices).toEqual([]);
  });

  it("goes on with a game begun on 1.0.2 when both have updated: untimed, in the v2 envelope", async () => {
    const [a, b] = chatPair("1.0.2", "1.0.2");
    const ana = await open102(a);
    const bob = await open102(b);
    await settle(ana, bob);
    await play(ana, bob, "e2e4", "e7e5");
    const g = saved(ana).g;
    await close(ana, bob);
    await close(bob);
    a.version = "2.0.0";
    b.version = "2.0.0";
    const from = a.sent.length;
    const ana2 = await openNew(a);
    const bob2 = await openNew(b);
    await settle(ana2, bob2);
    expect((ana2.game as ChessController).view().mode).toBe("v2");
    expect(ana2.game.view().phase).toBe("playing");
    await play(ana2, bob2, "f1c4", "b8c6", "d1h5", "g8f6", "h5f7");
    expect(saved(ana2).g).toBe(g);
    expect((saved(ana2) as SavedGame).dv).toBe(1);
    expect(ana2.game.view().end?.why).toBe("checkmate");
    expect(bob2.game.view().end?.why).toBe("checkmate");
    expect(new Set(a.sent.slice(from).map((f) => (f as { v: number }).v))).toEqual(new Set([2]));
    expect([...ana2.notices, ...bob2.notices]).toEqual([]);
  });

  it("brings a move made while 1.0.2 was closed to it in the sync, and the banner shows 1.0.2's version", async () => {
    const [a, b] = chatPair("1.0.2", "2.0.0");
    const old = await open102(a);
    const now = await openNew(b);
    await settle(old, now);
    const nowGame = now.game as ChessController;
    const root = document.createElement("div");
    document.body.append(root);
    const prefs = new PrefsStore(b);
    await prefs.load();
    mountChess(root, nowGame, en, prefs);
    expect(root.querySelector(".standing-text")!.textContent).toBe("Your contact has Chess 1.0.2. Clocks, takebacks and rematches come when they update.");
    expect(root.querySelector<HTMLElement>(".standing .info-btn")!.hidden).toBe(false);
    // Whoever is white opens; then it is the new side's move, and 1.0.2 closes.
    if (nowGame.view().me === "w") await play(old, now, "e2e4", "e7e5");
    else await play(old, now, "e2e4");
    expect(nowGame.view().canMove).toBe(true);
    await close(old, now);
    expect(nowGame.view().peerOpen).toBe(false);
    expect(root.querySelector(".status")!.textContent).toBe("Your contact closed Chess. The game waits here.");
    expect(root.querySelector(".standing-text")!.textContent).toBe("You can still make your move. It goes when they are back.");
    const uci = nowGame.view().me === "w" ? "g1f3" : "g8f6";
    expect(await nowGame.move(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square)).toBe(true);
    const plies = nowGame.view().plies;
    // 1.0.2 opens again: the sync carries the move ("ours plus one ply", which 1.0.2 already takes).
    const back = await open102(a);
    await settle(back, now);
    expect(back.game.view().plies).toBe(plies);
    expect(back.game.view().fen).toBe(nowGame.view().fen);
    expect(back.game.view().canMove).toBe(true);
    expect(back.notices).toEqual([]);
    expect(root.querySelector(".standing-text")!.textContent).toBe("Your contact has Chess 1.0.2. Clocks, takebacks and rematches come when they update.");
    expectOnly102Frames(now);
  });

  it("sends an unlimited invitation made while the contact was away as 1.0.2's seek", async () => {
    const [a, b] = chatPair("1.0.2", "2.0.0");
    const now = await openNew(b);
    const nowGame = now.game as ChessController;
    expect(nowGame.view().phase).toBe("setup");
    await nowGame.invite();
    expect(nowGame.view().phase).toBe("invited");
    const old = await open102(a);
    await settle(old, now);
    expect(old.game.view().phase).toBe("playing");
    expect(nowGame.view().phase).toBe("playing");
    expect(saved(old).g).toBe(saved(now).g);
    expectOnly102Frames(now);
  });

  it("sends an invitation made in version 2 as 1.0.2's toss, for deal 1, when the contact comes back on 1.0.2", async () => {
    const [a, b] = chatPair("2.0.0", "2.0.0");
    const now = await openNew(a);
    const later = await openNew(b);
    await settle(now, later);
    expect((now.game as ChessController).view().mode).toBe("v2");
    await close(later, now);
    await now.game.invite();
    expect(JSON.parse(a.stored.get("flip")!).dv).toBe(2);
    // The contact comes back on Chess 1.0.2 (another device, or it went back): the invitation goes as 1.0.2's seek.
    b.version = "1.0.2";
    const old = await open102(b);
    await settle(now, old);
    expect(now.game.view().phase).toBe("playing");
    expect(old.game.view().phase).toBe("playing");
    expect((saved(now) as SavedGame).dv).toBe(1);
    expect(saved(now).g).toBe(saved(old).g);
  });

  it("finishes a 1.0.2 toss that ended on one side only, after both update", async () => {
    const [a, b] = chatPair("1.0.2", "1.0.2");
    const ana = await open102(a);
    const bob = await open102(b);
    await settle(ana, bob);
    expect(ana.game.view().phase).toBe("playing");
    // Bob's app closed before Ana's reveal reached it: he still has the toss, with Ana's commitment.
    const bobSalt = (saved(bob) as LegacySavedGame).s[0];
    const anaSeek = a.sent.find((m) => (m as { k: string }).k === "seek") as { c: string };
    const game = saved(ana).g;
    await close(ana, bob);
    await close(bob);
    b.stored.delete("game");
    b.stored.set("flip", JSON.stringify({ v: 1, salt: bobSalt, a: [], peer: anaSeek.c }));
    a.version = "2.0.0";
    b.version = "2.0.0";
    const ana2 = await openNew(a);
    const bob2 = await openNew(b);
    await settle(ana2, bob2);
    // Bob adopts Ana's game by the deal his toss was for (1), although both speak version 2 now.
    expect((saved(bob2) as SavedGame).dv).toBe(1);
    for (const side of [ana2, bob2]) {
      expect(side.game.view().phase).toBe("playing");
      expect(side.notices).toEqual([]);
      expect(saved(side).g).toBe(game);
    }
  });

  it("ends with one history when 1.0.2 resigns while away, and today's Chess had moved while 1.0.2 was closed", async () => {
    for (let tries = 0; tries < 20; tries++) {
      const [a, b] = chatPair("1.0.2", "2.0.0");
      const old = await open102(a);
      const now = await openNew(b);
      await settle(old, now);
      if (now.game.view().me !== "b") continue; // today's Chess moves second here
      await play(old, now, "e2e4");
      await close(old, now);
      expect(await now.game.move("e7", "e5")).toBe(true);
      await close(now);
      const old2 = await open102(a);
      await settle(old2);
      await (old2.game as Legacy).resign();
      await settle(old2);
      const now2 = await openNew(b);
      await settle(old2, now2);
      for (const side of [old2, now2]) {
        expect(side.game.view().phase).toBe("over");
        expect(side.game.view().end).toEqual({ result: "0-1", why: "resign" });
        expect(side.game.view().plies).toBe(1);
      }
      expect(now2.notices).toEqual([]);
      return;
    }
    throw new Error("no toss gave today's Chess black");
  });

  it("ends in one game when 1.0.2 reports a 2.x version: the hello, then version 1 on its seek", async () => {
    // The client misreports 1.0.2 as 2.0.0: today's side opens with a hello, and 1.0.2 answers with its toss.
    const [a, b] = chatPair("2.0.0", "2.0.0");
    const old = await open102(a);
    const now = await openNew(b);
    await settle(old, now);
    expect((now.game as ChessController).view().mode).toBe("v1");
    expect(old.game.view().phase).toBe("playing");
    expect(now.game.view().phase).toBe("playing");
    expect(saved(old).g).toBe(saved(now).g);
    // The one v2 frame 1.0.2 saw is the hello; it says "newer version" once, and plays on.
    expect(b.sent[0]).toMatchObject({ v: 2, k: "hello" });
    expect(b.sent.slice(1).every((f) => (f as { v: number }).v === 1)).toBe(true);
    expect(old.notices).toEqual(["newer-version"]);
    await play(old, now, ...SCHOLARS_MATE);
    expect(old.game.view().end?.why).toBe("checkmate");
    expect(now.game.view().end?.why).toBe("checkmate");
  });

  it("ends in one game, never a mismatched one, when a 2.x side is misread as 1.0.2", async () => {
    const [a, b] = chatPair("1.0.2", "2.0.0");
    const ana = await openNew(a);
    const bob = await openNew(b);
    await settle(ana, bob);
    for (const side of [ana, bob]) {
      expect((side.game as ChessController).view().mode).toBe("v2");
      expect(side.game.view().phase).toBe("playing");
    }
    const [x, y] = [saved(ana) as SavedGame, saved(bob) as SavedGame];
    expect(x.g).toBe(y.g);
    expect(x.dv).toBe(y.dv);
    expect(x.me).not.toBe(y.me);
    await play(ana, bob, ...SCHOLARS_MATE);
    expect(ana.game.view().end?.why).toBe("checkmate");
    expect(bob.game.view().end?.why).toBe("checkmate");
  });
});
