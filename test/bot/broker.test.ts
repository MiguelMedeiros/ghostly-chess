import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonBroker, fileStore, memoryStore } from "../../bot/broker.ts";
import { connectDaemon, DaemonError, type Daemon, type DaemonEvent } from "../../bot/daemon.ts";
import type { MiniAppJson, MiniAppPeerEvent } from "../../src/vendor/miniApp.ts";

const CHAT = "chat1", APP = `${"y".repeat(52)}/chess`;

/** A stand-in daemon: its calls recorded and answered by `answer`, its events said with `say`. */
function standIn(answer: (method: string, params: Record<string, unknown>) => unknown = () => ({ sent: true })) {
  const calls: [string, Record<string, unknown>][] = [];
  const listeners = new Set<(event: DaemonEvent) => void>();
  let seq = 0;
  const daemon: Daemon = {
    call: async (method, params = {}) => { calls.push([method, params]); return answer(method, params); },
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    close: () => {},
  };
  const say = (type: string, fields: Record<string, unknown>) => { for (const l of [...listeners]) l({ seq: ++seq, id: `${type}:${seq}`, type, ...fields }); };
  return { daemon, calls, say, listening: () => listeners.size };
}

describe("the bot's broker", () => {
  it("sends a frame as app.send, and a refusal is the daemon's, by name", async () => {
    const { daemon, calls } = standIn((_, params) => { if (params.data === "late") throw new DaemonError("unavailable", "The contact's app is not open", "peer-closed"); return { sent: true }; });
    const broker = new DaemonBroker(daemon, { chat: CHAT, app: APP, version: "2.3.0", store: memoryStore() });
    await broker.chat.send({ p: "chess", v: 2, k: "hello" });
    expect(calls).toEqual([["app.send", { chat: CHAT, ref: APP, data: { p: "chess", v: 2, k: "hello" } }]]);
    await expect(broker.chat.send("late")).rejects.toMatchObject({ code: "unavailable", reason: "peer-closed" });
  });

  it("hands on the contact's frames and its open and close, of this chat and app only", async () => {
    const { daemon, say } = standIn();
    const broker = new DaemonBroker(daemon, { chat: CHAT, app: APP, version: "2.3.0", store: memoryStore() });
    const messages: MiniAppJson[] = [], peers: MiniAppPeerEvent[] = [];
    broker.chat.on("message", (data) => messages.push(data));
    const off = broker.chat.on("peer", (peer) => peers.push(peer));
    expect(await broker.context()).toEqual({ version: "2.3.0", inChat: true, peer: null });
    say("app.opened", { chat: CHAT, app: APP, version: "2.2.0" });
    expect((await broker.context()).peer).toEqual({ version: "2.2.0" });
    say("app.message", { chat: CHAT, app: APP, data: { k: "move" } });
    say("app.message", { chat: CHAT, app: APP, data: 0 });
    say("app.message", { chat: "another", app: APP, data: "not this chat" });
    say("app.message", { chat: CHAT, app: `${"y".repeat(52)}/poll`, data: "not this app" });
    say("message.received", { chat: CHAT, message: { text: "hi" } });
    say("app.closed", { chat: CHAT, app: APP, offline: true });
    expect(messages).toEqual([{ k: "move" }, 0]);
    expect(peers).toEqual([{ open: true, version: "2.2.0" }, { open: false }]);
    expect((await broker.context()).peer).toBeNull();
    off();
    say("app.opened", { chat: CHAT, app: APP, version: "2.3.0" });
    expect(peers).toHaveLength(2);
  });

  it("starts from what app open said of the contact, and gives the name only when it has one", async () => {
    const { daemon } = standIn();
    expect(await new DaemonBroker(daemon, { chat: CHAT, app: APP, version: "2.3.0", peer: "2.3.0", name: "Zero", store: memoryStore() }).context())
      .toEqual({ version: "2.3.0", inChat: true, peer: { version: "2.3.0" }, name: "Zero" });
  });

  it("close says app.close and stops listening", async () => {
    const { daemon, calls, listening } = standIn();
    const broker = new DaemonBroker(daemon, { chat: CHAT, app: APP, version: "2.3.0", store: memoryStore() });
    expect(listening()).toBe(1);
    await broker.close();
    expect(calls).toEqual([["app.close", { chat: CHAT, ref: APP }]]);
    expect(listening()).toBe(0);
  });

  it("keeps the game in one owner-only file, which another run reads back", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "chess-bot-")), "state", "chat1.json");
    const { daemon } = standIn();
    const broker = new DaemonBroker(daemon, { chat: CHAT, app: APP, version: "2.3.0", store: fileStore(path) });
    expect(await broker.storage.get("game")).toBeUndefined();
    await broker.storage.set("game", { v: 2, m: ["e2e4"] });
    await broker.storage.set("prev", { g: "00" });
    expect(await broker.storage.keys()).toEqual(["game", "prev"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new DaemonBroker(daemon, { chat: CHAT, app: APP, version: "2.3.0", store: fileStore(path) });
    expect(await again.storage.get("game")).toEqual({ v: 2, m: ["e2e4"] });
    await again.storage.delete("game");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ prev: { g: "00" } });
    // A file that does not read is an empty store, not a crash.
    writeFileSync(path, "{not json");
    expect(await again.storage.keys()).toEqual([]);
  });
});

describe("the daemon's socket", () => {
  const servers: Server[] = [];
  afterEach(() => { for (const server of servers.splice(0)) server.close(); });

  /** A daemon's socket, as packages/cli serves it: a line in, a line out, and a stream after events.subscribe. */
  async function socketDaemon() {
    const path = join(mkdtempSync(join(tmpdir(), "chess-bot-sock-")), "daemon.sock");
    const streams = new Set<Socket>(), all = new Set<Socket>();
    const server = createServer((socket) => {
      all.add(socket);
      socket.on("error", () => {});
      createInterface({ input: socket }).on("error", () => {}).on("line", (line) => {
        const { id, method, params } = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
        if (method === "events.subscribe") { streams.add(socket); socket.write(JSON.stringify({ id, result: { subscribed: true, lastSeq: 0 } }) + "\n"); }
        else if (method === "app.send" && params.data === "late") socket.write(JSON.stringify({ id, error: { code: "unavailable", message: "not open", details: { reason: "peer-closed" } } }) + "\n");
        else if (method !== "never answered") socket.write(JSON.stringify({ id, result: { method, params } }) + "\n");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const say = (event: Record<string, unknown>) => { for (const socket of streams) socket.write(JSON.stringify({ event }) + "\n"); };
    return { path, say, drop: () => { for (const socket of all) socket.destroy(); } };
  }

  it("answers calls, names a refusal, streams events, and says when the daemon is gone", async () => {
    const { path, say, drop } = await socketDaemon();
    let gone = 0;
    const daemon = await connectDaemon(path, () => gone++);
    expect(await daemon.call("app.served")).toEqual({ method: "app.served", params: {} });
    await expect(daemon.call("app.send", { data: "late" })).rejects.toMatchObject({ name: "DaemonError", code: "unavailable", reason: "peer-closed" });
    const events: DaemonEvent[] = [];
    daemon.onEvent((event) => events.push(event));
    say({ seq: 1, id: "a", type: "app.opened", chat: "c", app: "x", version: "2.3.0" });
    say({ seq: 2, id: "b", type: "app.message", chat: "c", app: "x", data: { k: "hello" } });
    await expect.poll(() => events.map((e) => e.type)).toEqual(["app.opened", "app.message"]);
    const waiting = daemon.call("never answered").catch((error: unknown) => error);
    drop();
    await expect.poll(() => gone).toBe(1);
    await expect(waiting).resolves.toMatchObject({ code: "unavailable" });
    await expect(daemon.call("status")).rejects.toMatchObject({ code: "unavailable" });
  });
});
