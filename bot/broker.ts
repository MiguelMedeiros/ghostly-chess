/**
 * The broker the bot gives Chess's own controller (src/game.ts), made of a Ghostly daemon: what `window.ghostly` is to
 * the app in a person's client (src/vendor/miniApp.ts), a daemon that serves Chess is to the bot (`ghostly app serve`,
 * WISP 1200 § A bot on the other side). So the bot speaks docs/protocol.md with the code the app runs, and cannot drift
 * from it.
 *
 *   chat.send        `app.send`: one frame, live only, refused by name when it cannot go
 *   chat.on message  `app.message` events of this chat and app
 *   chat.on peer     `app.opened` and `app.closed`
 *   storage          one JSON file per chat, written whole and renamed into place
 *   context          the served version, the contact's while its Chess is open, the profile's name when granted
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MiniAppApi, MiniAppContext, MiniAppJson, MiniAppPeerEvent } from "../src/vendor/miniApp.ts";
import { DaemonError, type Daemon, type DaemonEvent } from "./daemon.ts";

/** Where one chat's game is kept. */
export interface Store {
  read(): Record<string, MiniAppJson>;
  write(all: Record<string, MiniAppJson>): void;
}

/** A store in one JSON file, owner-only. A file that does not read is an empty store: Chess starts a new game. */
export function fileStore(path: string): Store {
  return {
    read() {
      try {
        const read = JSON.parse(readFileSync(path, "utf8")) as unknown;
        return read && typeof read === "object" && !Array.isArray(read) ? (read as Record<string, MiniAppJson>) : {};
      } catch { return {}; }
    },
    write(all) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, JSON.stringify(all), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
  };
}

export const memoryStore = (all: Record<string, MiniAppJson> = {}): Store => ({ read: () => all, write: (next) => { all = next; } });

export interface BrokerOptions {
  /** The chat's id, as the daemon's events name it. */
  chat: string;
  /** The served app's reference and version (`app.served`). */
  app: string;
  version: string;
  /** The contact's Chess version when it is open already (`app.open` says). */
  peer?: string | null;
  /** The profile's name in this chat: only when the app was served with `--grant name`. */
  name?: string;
  store: Store;
  /** A frame the daemon did not send, and why (`details.reason`: `offline`, `peer-closed`, `too-fast`…). */
  refused?: (reason: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** A frame refused as `too-fast` goes again after this long, this many times: the limit is 48 a second (WISP 1200). */
const TOO_FAST_WAIT_MS = 300;
const TOO_FAST_TRIES = 5;

export class DaemonBroker implements MiniAppApi {
  private peer: string | null;
  private readonly messageListeners = new Set<(data: MiniAppJson) => void>();
  private readonly peerListeners = new Set<(peer: MiniAppPeerEvent) => void>();
  private readonly off: () => void;

  constructor(private readonly daemon: Daemon, private readonly options: BrokerOptions) {
    this.peer = options.peer ?? null;
    this.off = daemon.onEvent((event) => this.heard(event));
  }

  /**
   * An event of the daemon's. Public for the ones that came between `app.open` and this broker being made: the bot
   * collects them and hands them over, so the contact's open is never missed when both sides open at once.
   */
  heard(event: DaemonEvent): void {
    if (event.chat !== this.options.chat || event.app !== this.options.app) return;
    if (event.type === "app.message") {
      // A frame for an app the contact has closed is never reported; one that comes is the contact's own, untrusted.
      for (const listener of [...this.messageListeners]) listener(event.data as MiniAppJson);
    } else if (event.type === "app.opened" && typeof event.version === "string") {
      this.peer = event.version;
      for (const listener of [...this.peerListeners]) listener({ open: true, version: event.version });
    } else if (event.type === "app.closed") {
      this.peer = null;
      for (const listener of [...this.peerListeners]) listener({ open: false });
    }
  }

  async context(): Promise<MiniAppContext> {
    return { version: this.options.version, inChat: true, peer: this.peer === null ? null : { version: this.peer }, ...(this.options.name !== undefined && { name: this.options.name }) };
  }

  async file(): Promise<ArrayBuffer> {
    throw new Error("no such file");
  }

  storage = {
    get: async (key: string): Promise<MiniAppJson | undefined> => this.options.store.read()[key],
    set: async (key: string, value: MiniAppJson): Promise<void> => {
      // As JSON keeps it: what cannot be written back is refused here, not found missing after a restart.
      const kept = JSON.parse(JSON.stringify(value)) as MiniAppJson;
      this.options.store.write({ ...this.options.store.read(), [key]: kept });
    },
    delete: async (key: string): Promise<void> => {
      const { [key]: _gone, ...rest } = this.options.store.read();
      this.options.store.write(rest);
    },
    keys: async (): Promise<string[]> => Object.keys(this.options.store.read()),
  };

  chat = {
    send: async (value: MiniAppJson): Promise<void> => {
      const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      for (let tries = 1; ; tries++) {
        try {
          await this.daemon.call("app.send", { chat: this.options.chat, ref: this.options.app, data: value });
          return;
        } catch (error) {
          const reason = error instanceof DaemonError ? error.reason ?? error.code : "error";
          // Too many frames in a second is the sender's to wait out; any other refusal is Chess's to handle.
          if (reason !== "too-fast" || tries >= TOO_FAST_TRIES) { this.options.refused?.(reason); throw error; }
          await sleep(TOO_FAST_WAIT_MS);
        }
      }
    },
    on: ((event: "message" | "peer", listener: (data: never) => void) => {
      const set = (event === "message" ? this.messageListeners : this.peerListeners) as Set<(data: never) => void>;
      set.add(listener);
      return () => set.delete(listener);
    }) as MiniAppApi["chat"]["on"],
  };

  /** Chess is closed in this chat: the contact's Chess hears it. */
  async close(): Promise<void> {
    this.off();
    await this.daemon.call("app.close", { chat: this.options.chat, ref: this.options.app }).catch(() => {});
  }
}
