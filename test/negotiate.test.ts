// covers: apps.chess
// Which protocol a side speaks with the contact's Chess (src/negotiate.ts), and what it sends for it, on evidence
// rather than on the version string alone. The controller-level checks are at the end, on the mock broker.
import { describe, expect, it } from "vitest";
import { ChessController } from "../src/game.ts";
import { Negotiator } from "../src/negotiate.ts";
import { encodeMessage, encodeV1 } from "../src/protocol.ts";
import { commitment, newSalt } from "../src/toss.ts";
import { chatPair } from "./mockBroker.ts";

const settle = async (...games: ChessController[]) => {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(games.map((g) => g.settled()));
  }
};
const kinds = (sent: unknown[]) => sent.map((f) => `${(f as { v: number }).v}:${(f as { k: string }).k}`);

describe("the negotiator", () => {
  it("speaks version 1 at once to 1.0.2, 1.2.0, an unparseable version and a missing one, with no hello", () => {
    for (const version of ["1.0.2", "1.2.0", "1.99.0", "2.0.0-rc.1", "dev", "", undefined]) {
      const n = new Negotiator(["clock"]);
      expect(n.open(version), String(version)).toEqual({ sendHello: false, reply: false, sendOpening: false });
      expect(n.mode).toBe("v1");
      expect(n.envelope).toBe(1);
      expect(n.holding).toBe(false);
      expect(n.features).toEqual([]);
    }
  });

  it("sends hello first to 2.0.0 and holds game frames until the peer's hello", () => {
    const n = new Negotiator(["clock", "takeback"]);
    expect(n.open("2.0.0")).toEqual({ sendHello: true, reply: false, sendOpening: false });
    expect(n.mode).toBe("hello");
    expect(n.holding).toBe(true);
    expect(n.envelope).toBe(2);
    // The peer's answer to ours: the opening goes, and the answer is not answered.
    expect(n.receive(2, "hello", { f: ["takeback", "names"], n: "Bob", re: 1 })).toEqual({ handle: false, sendHello: false, sendOpening: true, changed: true });
    expect(n.mode).toBe("v2");
    expect(n.holding).toBe(false);
    expect(n.peerName).toBe("Bob");
  });

  it("switches to version 1 when a v1 frame comes instead of a hello, and sends the v1 opening first", () => {
    const n = new Negotiator([]);
    n.open("2.3.0");
    expect(n.receive(1, "seek")).toEqual({ handle: true, sendHello: false, sendOpening: true, changed: true });
    expect(n.mode).toBe("v1");
    expect(n.envelope).toBe(1);
    // Later v1 frames are just handled.
    expect(n.receive(1, "reveal")).toEqual({ handle: true, sendHello: false, sendOpening: false, changed: false });
  });

  it("upgrades on a v2 hello received in version 1 (a version misread), and answers with its own hello", () => {
    const n = new Negotiator(["clock"]);
    n.open("1.0.2");
    expect(n.receive(2, "hello", { f: ["clock"] })).toEqual({ handle: false, sendHello: true, sendOpening: true, changed: true });
    expect(n.mode).toBe("v2");
    expect(n.features).toEqual(["clock"]);
  });

  it("ignores a v2 game frame in version 1, and reads a v1 frame in version 2 (a game begun on 1.0.2)", () => {
    const n = new Negotiator([]);
    n.open("1.0.2");
    expect(n.receive(2, "move").handle).toBe(false);
    n.open("2.0.0");
    n.receive(2, "hello", { f: [] });
    expect(n.receive(1, "move")).toEqual({ handle: true, sendHello: false, sendOpening: false, changed: false });
    expect(n.mode).toBe("v2");
  });

  it("keeps a hello that came before the peer's open event, and opens in version 2 on it, whatever the version says", () => {
    for (const version of ["2.0.0", "1.0.2"]) {
      const n = new Negotiator(["clock"]);
      expect(n.receive(2, "hello", { f: ["clock"] })).toEqual({ handle: false, sendHello: false, sendOpening: false, changed: false });
      // Our hello goes as the answer to it.
      expect(n.open(version), version).toEqual({ sendHello: true, reply: true, sendOpening: true });
      expect(n.mode).toBe("v2");
      expect(n.features).toEqual(["clock"]);
      // A close forgets an early hello.
      n.close();
      n.receive(2, "hello", { f: [] });
      n.close();
      expect(n.open("2.0.0")).toEqual({ sendHello: true, reply: false, sendOpening: false });
    }
    // An early answer (to a hello of ours from an open before): the peer has ours, so only the opening goes.
    const n = new Negotiator([]);
    n.receive(2, "hello", { f: [], re: 1 });
    expect(n.open("2.0.0")).toEqual({ sendHello: false, reply: false, sendOpening: true });
    expect(n.mode).toBe("v2");
  });

  it("intersects the features, keeping its own order and dropping names it does not know", () => {
    const n = new Negotiator(["clock", "takeback", "rematch"]);
    n.open("2.1.0");
    expect(n.features).toEqual([]);
    n.receive(2, "hello", { f: ["rematch", "clock", "future-thing"] });
    expect(n.features).toEqual(["clock", "rematch"]);
    expect(n.peerFeatures).toEqual(["rematch", "clock", "future-thing"]);
    // A new open forgets them until the next hello.
    n.open("2.1.0");
    expect(n.features).toEqual([]);
  });

  it("always answers a hello without re, in any mode, and never one with re: no hello ping-pong", () => {
    const a = new Negotiator([]);
    const b = new Negotiator([]);
    a.open("2.0.0");
    b.open("2.0.0");
    // Both hellos cross: each answers the other's once, with its opening.
    expect(a.receive(2, "hello", { f: [] })).toEqual({ handle: false, sendHello: true, sendOpening: true, changed: true });
    expect(b.receive(2, "hello", { f: [] })).toEqual({ handle: false, sendHello: true, sendOpening: true, changed: true });
    // The answers are not answered.
    expect(a.receive(2, "hello", { f: [], re: 1 })).toEqual({ handle: false, sendHello: false, sendOpening: false, changed: false });
    expect(b.receive(2, "hello", { f: [], re: 1 })).toEqual({ handle: false, sendHello: false, sendOpening: false, changed: false });
    // A opened again on B's side (B did not see it close): A says hello and waits; B, in version 2, answers it.
    expect(a.open("2.0.0").sendHello).toBe(true);
    expect(b.receive(2, "hello", { f: [] })).toEqual({ handle: false, sendHello: true, sendOpening: true, changed: false });
    expect(a.receive(2, "hello", { f: [], re: 1 }).sendHello).toBe(false);
    expect(a.mode).toBe("v2");
    // A hello with re in version 1 or "hello" also moves to version 2, and sends the opening only.
    const c = new Negotiator([]);
    c.open("1.0.2");
    expect(c.receive(2, "hello", { f: [], re: 1 })).toEqual({ handle: false, sendHello: false, sendOpening: true, changed: true });
    expect(c.mode).toBe("v2");
  });
});

describe("negotiation on the mock broker", () => {
  it("sends nothing but hello to a 2.x contact until its hello, then the opening", async () => {
    const [a, b] = chatPair("2.0.0");
    a.launch();
    const ana = new ChessController(a);
    await ana.start();
    await ana.invite();
    expect(a.sent).toEqual([]); // the contact is away: the invitation waits
    b.launch(); // Bob is a script; his client says he opened Chess
    await settle(ana);
    expect(kinds(a.sent)).toEqual(["2:hello"]);
    // A game frame from the contact before its hello does not make this side send.
    a.inject(encodeMessage({ k: "seek", c: commitment(newSalt()), a: [] }));
    await settle(ana);
    expect(kinds(a.sent)).toEqual(["2:hello"]);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: [] }));
    await settle(ana);
    // The contact's hello (not an answer) is answered with re: 1, then the opening.
    expect(kinds(a.sent)).toEqual(["2:hello", "2:hello", "2:seek"]);
    expect(a.sent[1]).toEqual({ p: "chess", v: 2, k: "hello", pv: 2, f: [], re: 1 });
  });

  it("switches to version 1 on a v1 seek and answers it as 1.0.2 does: its own seek, then the reveal", async () => {
    const [a, b] = chatPair("2.0.0");
    a.launch();
    const ana = new ChessController(a);
    await ana.start();
    b.launch();
    await settle(ana);
    a.inject(encodeV1({ k: "seek", c: commitment(newSalt()), a: [] }));
    await settle(ana);
    expect(ana.view().mode).toBe("v1");
    expect(kinds(a.sent)).toEqual(["2:hello", "1:seek", "1:seek", "1:reveal"]);
    expect(Object.keys(a.sent[1] as object)).toEqual(["p", "v", "k", "c", "a"]);
  });

  it("speaks version 1 at once to 1.0.2: its seek, and no v2 frame", async () => {
    for (const version of ["1.0.2", "1.2.0", "not-a-version", ""]) {
      const [a, b] = chatPair("2.0.0", version);
      a.launch();
      const ana = new ChessController(a);
      await ana.start();
      b.launch();
      await settle(ana);
      expect(kinds(a.sent), version).toEqual(["1:seek"]);
      expect(ana.view().mode).toBe("v1");
    }
  });

  it("upgrades when a contact read as 1.x says hello, and answers with its own", async () => {
    const [a, b] = chatPair("2.0.0", "1.2.0");
    a.launch();
    const ana = new ChessController(a);
    await ana.start();
    b.launch();
    await settle(ana);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: ["clock"] }));
    await settle(ana);
    expect(ana.view().mode).toBe("v2");
    // Its v1 toss becomes its invitation, now in the v2 envelope.
    expect(kinds(a.sent)).toEqual(["1:seek", "2:hello", "2:seek"]);
    expect(ana.view().features).toEqual([]);
  });

  it("takes the contact's hello that came before the broker said it opened (a quick page), and opens in version 2", async () => {
    const [a, b] = chatPair("2.0.0");
    a.launch();
    const ana = new ChessController(a);
    await ana.start();
    await ana.invite();
    a.inject(encodeMessage({ k: "hello", pv: 2, f: [] }));
    await settle(ana);
    expect(a.sent).toEqual([]);
    b.launch();
    await settle(ana);
    expect(ana.view().mode).toBe("v2");
    expect(kinds(a.sent)).toEqual(["2:hello", "2:seek"]);
  });

  it("answers the contact's hello again when the broker says it opened twice", async () => {
    const [a, b] = chatPair("2.0.0");
    let clock = 0;
    const now = () => clock;
    a.launch();
    const ana = new ChessController(a, { now });
    await ana.start();
    b.launch();
    const bob = new ChessController(b, { now });
    await bob.start();
    await settle(ana, bob);
    // Each says hello and answers the other's.
    expect(kinds(a.sent)).toEqual(["2:hello", "2:hello"]);
    expect(kinds(b.sent)).toEqual(["2:hello", "2:hello"]);
    // A second open event for Bob's side, with no close: Bob says hello again and holds; Ana answers.
    clock += 5000;
    b.emitPeer({ open: true, version: "2.0.0" });
    await settle(ana, bob);
    expect(bob.view().mode).toBe("v2");
    expect(ana.view().mode).toBe("v2");
    await ana.invite();
    await settle(ana, bob);
    expect(bob.view().invitation).toEqual({ rematch: false, playable: true });
  });

  it("reaches version 2 again when the contact reloads after an early hello, and a move goes through", async () => {
    // The review's case: the handshake took the early path (Bob's hello before the broker said he opened), then Bob's
    // page reloads and Ana is not told. Before replies were explicit, Bob waited for a hello for good.
    const [a, b] = chatPair("2.0.0");
    let clock = 0;
    const now = () => clock;
    a.launch();
    const ana = new ChessController(a, { now });
    await ana.start();
    b.isOpen = true; // Bob's page is quick: his hello reaches Ana before the broker's open event for him
    const bob1 = new ChessController(b, { now });
    await bob1.start();
    await settle(ana, bob1);
    a.emitPeer({ open: true, version: "2.0.0" });
    await settle(ana, bob1);
    expect(ana.view().mode).toBe("v2");
    expect(bob1.view().mode).toBe("v2");
    await ana.invite();
    await settle(ana, bob1);
    await bob1.acceptInvitation();
    await settle(ana, bob1);
    expect(ana.view().phase).toBe("playing");
    // Bob's page reloads; Ana's app sees no close and no open.
    bob1.stop();
    clock += 5000;
    const bob = new ChessController(b, { now });
    await bob.start();
    await settle(ana, bob);
    expect(bob.view().mode).toBe("v2");
    expect(bob.view().phase).toBe("playing");
    const white = ana.view().me === "w" ? ana : bob;
    const black = white === ana ? bob : ana;
    expect(await white.move("e2", "e4")).toBe(true);
    await settle(ana, bob);
    expect(await black.move("e7", "e5")).toBe(true);
    await settle(ana, bob);
    expect(ana.view().plies).toBe(2);
    expect(bob.view().plies).toBe(2);
  });

  it("answers a stray hello at most once, and an answer never", async () => {
    const [a, b] = chatPair("2.0.0");
    a.launch();
    const ana = new ChessController(a);
    await ana.start();
    b.launch();
    await settle(ana);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: [], re: 1 }));
    await settle(ana);
    expect(ana.view().mode).toBe("v2");
    expect(kinds(a.sent)).toEqual(["2:hello"]);
    // Three stray hellos within a second: one answer now, and the others share one when the second is up.
    for (let i = 0; i < 3; i++) a.inject(encodeMessage({ k: "hello", pv: 2, f: [] }));
    await settle(ana);
    expect(kinds(a.sent)).toEqual(["2:hello", "2:hello"]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await settle(ana);
    expect(kinds(a.sent)).toEqual(["2:hello", "2:hello", "2:hello"]);
    expect(a.sent.slice(1).every((f) => (f as { re?: number }).re === 1)).toBe(true);
    // Answers are never answered.
    for (let i = 0; i < 3; i++) a.inject(encodeMessage({ k: "hello", pv: 2, f: [], re: 1 }));
    await settle(ana);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await settle(ana);
    expect(kinds(a.sent)).toEqual(["2:hello", "2:hello", "2:hello"]);
    ana.stop();
  });

  it("says hello again while it waits for the contact's, until it comes", async () => {
    const [a, b] = chatPair("2.0.0");
    a.launch();
    const ana = new ChessController(a, { helloRetryMs: 10 });
    await ana.start();
    b.launch(); // a script that lost Ana's first hello
    await settle(ana);
    await new Promise((resolve) => setTimeout(resolve, 45));
    await settle(ana);
    expect(a.sent.length).toBeGreaterThan(1);
    expect(kinds(a.sent).every((k) => k === "2:hello")).toBe(true);
    expect(a.sent.every((f) => (f as { re?: number }).re === undefined)).toBe(true);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: [], re: 1 }));
    await settle(ana);
    expect(ana.view().mode).toBe("v2");
    const answered = a.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 45));
    await settle(ana);
    expect(a.sent.length).toBe(answered);
    ana.stop();
  });
});
