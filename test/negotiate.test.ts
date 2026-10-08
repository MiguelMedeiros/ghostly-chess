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
      expect(n.open(version), String(version)).toEqual({ sendHello: false });
      expect(n.mode).toBe("v1");
      expect(n.envelope).toBe(1);
      expect(n.holding).toBe(false);
      expect(n.features).toEqual([]);
    }
  });

  it("sends hello first to 2.0.0 and holds game frames until the peer's hello", () => {
    const n = new Negotiator(["clock", "takeback"]);
    expect(n.open("2.0.0")).toEqual({ sendHello: true });
    expect(n.mode).toBe("hello");
    expect(n.holding).toBe(true);
    expect(n.envelope).toBe(2);
    expect(n.receive(2, "hello", { f: ["takeback", "names"], n: "Bob" })).toEqual({ handle: false, sendHello: false, sendOpening: true, changed: true });
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

  it("answers a hello in version 2 only when it sent none since the last it got: no hello ping-pong", () => {
    const a = new Negotiator([]);
    const b = new Negotiator([]);
    a.open("2.0.0");
    b.open("2.0.0");
    // Both hellos cross: neither answers.
    expect(a.receive(2, "hello", { f: [] }).sendHello).toBe(false);
    expect(b.receive(2, "hello", { f: [] }).sendHello).toBe(false);
    // A sees B open again (B did not see A close): A says hello again, and waits.
    expect(a.open("2.0.0").sendHello).toBe(true);
    // B is in version 2 and had sent nothing since A's hello: it answers, once, with its opening.
    expect(b.receive(2, "hello", { f: [] })).toEqual({ handle: false, sendHello: true, sendOpening: true, changed: false });
    expect(a.receive(2, "hello", { f: [] }).sendHello).toBe(false);
    expect(a.mode).toBe("v2");
    // A stray hello again: B answered last, so it does not answer it; two answers never answer each other.
    expect(b.receive(2, "hello", { f: [] }).sendHello).toBe(false);
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
    expect(kinds(a.sent)).toEqual(["2:hello", "2:seek"]);
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

  it("answers the contact's hello again when the broker says it opened twice", async () => {
    const [a, b] = chatPair("2.0.0");
    a.launch();
    const ana = new ChessController(a);
    await ana.start();
    b.launch();
    const bob = new ChessController(b);
    await bob.start();
    await settle(ana, bob);
    expect(kinds(a.sent)).toEqual(["2:hello"]);
    expect(kinds(b.sent)).toEqual(["2:hello"]);
    // A second open event for Bob's side, with no close: Bob says hello again and holds; Ana answers.
    b.emitPeer({ open: true, version: "2.0.0" });
    await settle(ana, bob);
    expect(bob.view().mode).toBe("v2");
    expect(ana.view().mode).toBe("v2");
    await ana.invite();
    await settle(ana, bob);
    expect(bob.view().invitation).toEqual({ rematch: false });
  });
});
