// covers: apps.chess
// The virtual-clock link itself (test/link.ts): a peer event waits behind the frames already on their way, as one
// connection delivers them, and settle() comes back when a side closes with a frame to its contact still in flight.
import { describe, expect, it, vi } from "vitest";
import type { MiniAppJson, MiniAppPeerEvent } from "../src/vendor/miniApp.ts";
import { Clock, LinkBroker, Link, record, timedGame } from "./link.ts";

// Without the fix this hangs until the timeout: keep it short.
vi.setConfig({ testTimeout: 5000 });

describe("the link's inbox", () => {
  it("hands a peer event over after a frame sent before it, at the frame's time, and is not due before", () => {
    const clock = new Clock();
    const a = new LinkBroker("ana", clock);
    const b = new LinkBroker("bob", clock);
    a.peer = b;
    b.peer = a;
    a.launch();
    b.launch();
    const got: { at: number; what: MiniAppJson | MiniAppPeerEvent }[] = [];
    b.chat.on("message", (data) => got.push({ at: clock.now, what: data }));
    b.chat.on("peer", (peer) => got.push({ at: clock.now, what: peer }));
    a.latency = 150;
    void a.chat.send({ k: "hi" });
    a.shutdown(); // its close goes out after the frame
    expect(b.due()).toBe(false);
    expect(b.pump()).toBe(false);
    expect(b.nextDue()).toBe(150);
    clock.now = 149;
    expect(b.due()).toBe(false);
    clock.now = 150;
    expect(b.due()).toBe(true);
    expect(b.pump()).toBe(true);
    expect(got).toEqual([
      { at: 150, what: { k: "hi" } },
      { at: 150, what: { open: false } },
    ]);
    expect(b.due()).toBe(false);
  });
});

describe("settle()", () => {
  it("comes back when a side closes right after a move still on its way (150 ms), and the contact gets both in order", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    white.broker.latency = 150;
    expect(await white.game.move("e2", "e4")).toBe(true);
    const started = performance.now();
    await link.close(white); // the move is still in flight to black
    expect(performance.now() - started).toBeLessThan(2000);
    // Nothing reached black yet: the move, then the close, are due 150 ms after they left.
    expect(black.game.view().peerOpen).toBe(true);
    expect(black.game.view().turn).toBe("w");
    await link.advance(200);
    expect(record(black).m).toEqual(["e2e4"]);
    expect(black.game.view().turn).toBe("b");
    expect(black.game.view().peerOpen).toBe(false);
  });

  it("comes back for a reconnect queued behind a frame in flight", async () => {
    const link = new Link();
    await link.open(link.a);
    await link.open(link.b);
    await link.advance(100); // the hellos have arrived: nothing on its way
    link.a.latency = 300;
    void link.a.chat.send({ k: "noise" });
    const started = performance.now();
    await link.reconnect();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(link.b.nextDue()).toBe(link.clock.now + 300);
  });
});
