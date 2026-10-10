/**
 * A Ghostly daemon's local control API (WISP 1100), as the bot uses it: one JSON object per line each way over the
 * profile's Unix socket. `ghostly daemon status` says where the socket is. One connection carries the calls, another
 * the event stream, since `events.subscribe` turns its connection into one.
 */
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";

export interface DaemonEvent { seq: number; id: string; type: string; chat?: string; [field: string]: unknown }

/** A refused call: the daemon's `code`, its words, and `details.reason` when it names why (an app frame not sent). */
export class DaemonError extends Error {
  constructor(readonly code: string, message: string, readonly reason?: string) {
    super(message);
    this.name = "DaemonError";
  }
}

/** What the bot needs of a daemon; the tests give a stand-in. */
export interface Daemon {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Every event from now on, in order. Returns a function that stops it. */
  onEvent(listener: (event: DaemonEvent) => void): () => void;
  close(): void;
}

function lines(socket: Socket, onLine: (message: Record<string, unknown>) => void): void {
  // The reader says the socket's errors again as its own: unheard, a daemon that went away would end the bot.
  createInterface({ input: socket, crlfDelay: Infinity }).on("error", () => {}).on("line", (line) => {
    try { onLine(JSON.parse(line) as Record<string, unknown>); } catch { /* not a line of the API */ }
  });
}

const opened = (path: string) => new Promise<Socket>((resolve, reject) => {
  const socket = connect(path);
  socket.once("connect", () => { socket.off("error", reject); socket.on("error", () => {}); resolve(socket); });
  socket.once("error", reject);
});

/** Connects to the daemon at `socketPath`. `onGone` is called when it goes away (it stopped, or restarts). */
export async function connectDaemon(socketPath: string, onGone: () => void = () => {}): Promise<Daemon> {
  const [calls, stream] = await Promise.all([opened(socketPath), opened(socketPath)]);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(event: DaemonEvent) => void>();
  let nextId = 1;
  let gone = false;
  const went = () => {
    if (gone) return;
    gone = true;
    for (const waiting of pending.values()) waiting.reject(new DaemonError("unavailable", "The daemon went away"));
    pending.clear();
    calls.destroy();
    stream.destroy();
    onGone();
  };
  calls.on("close", went);
  stream.on("close", went);
  lines(calls, (message) => {
    const waiting = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (!waiting) return;
    pending.delete(message.id as number);
    const error = message.error as { code?: string; message?: string; details?: { reason?: string } } | undefined;
    if (error) waiting.reject(new DaemonError(error.code ?? "internal", error.message ?? "The daemon refused", error.details?.reason));
    else waiting.resolve(message.result);
  });
  // Subscribed before anything else is asked: no event of a call made later can come before the stream is on.
  await new Promise<void>((resolve, reject) => {
    let on = false;
    lines(stream, (message) => {
      if (message.event) { for (const listener of [...listeners]) listener(message.event as DaemonEvent); return; }
      if (on) return;
      on = true;
      if (message.error) reject(new DaemonError("unavailable", "The daemon gave no event stream")); else resolve();
    });
    stream.write(JSON.stringify({ id: 0, method: "events.subscribe", params: {} }) + "\n");
  });
  return {
    call: (method, params = {}) => new Promise((resolve, reject) => {
      if (gone) { reject(new DaemonError("unavailable", "The daemon went away")); return; }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      calls.write(JSON.stringify({ id, method, params }) + "\n");
    }),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    close: () => { gone = true; calls.end(); stream.end(); },
  };
}
