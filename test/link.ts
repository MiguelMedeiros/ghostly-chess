/**
 * Two sides of one chat on a virtual clock, for the clock tests: a broker with the WISP's rules (like mockBroker.ts:
 * storage per chat, `chat.send` only while both are open) whose frames take `latency` ms of virtual time to arrive,
 * in order, and can be dropped, rewritten (a modified client) or refused (a held session). Each side's controller
 * reads its own monotonic clock, which can run slow or fast, and the wall clock; tests move time with `advance`, and
 * each step runs both controllers' tick(), as the page's ticker does.
 */
import type { Square } from "chess.js";
import { ChessController, type ControllerOptions, type Notice } from "../src/game.ts";
import type { TimeControl } from "../src/protocol.ts";
import { MINI_APP_LIMITS, type MiniAppApi, type MiniAppContext, type MiniAppJson, type MiniAppPeerEvent } from "../src/vendor/miniApp.ts";
import { strictJson } from "./mockBroker.ts";

/** The wall clock at virtual time 0: 2026-10-08. */
export const WALL0 = Date.UTC(2026, 9, 8, 12);

export class Clock {
  /** Virtual time, ms. */
  now = 0;
}

type Frame = Record<string, unknown>;

interface Arrival {
  due: number;
  value?: MiniAppJson;
  peer?: MiniAppPeerEvent;
}

export class LinkBroker implements MiniAppApi {
  readonly stored = new Map<string, string>();
  /** Every frame this side sent (after a rewrite), with the virtual time it left. */
  readonly sent: { at: number; frame: Frame }[] = [];
  /** storage.set calls, by key. */
  readonly sets: string[] = [];
  peer: LinkBroker | null = null;
  isOpen = false;
  /** Virtual ms a frame from this side takes to reach the peer. */
  latency = 10;
  /** Sends refused (a held session): set on both sides by `hold`. */
  held = false;
  /** Frames from this side that are sent but never arrive. */
  drop: ((frame: Frame) => boolean) | null = null;
  /** A modified client: rewrites (or, with null, swallows) what this side sends. */
  rewrite: ((frame: Frame) => Frame | null) | null = null;
  private inbox: Arrival[] = [];
  private lastDue = 0;
  private messageListeners = new Set<(data: MiniAppJson) => void>();
  private peerListeners = new Set<(peer: MiniAppPeerEvent) => void>();

  constructor(
    readonly name: string,
    readonly clock: Clock,
    public version = "2.1.0",
  ) {}

  async context(): Promise<MiniAppContext> {
    return { version: this.version, inChat: true, peer: this.peer?.isOpen ? { version: this.peer.version } : null };
  }

  async file(): Promise<ArrayBuffer> {
    throw new Error("no such file");
  }

  storage = {
    get: async (key: string): Promise<MiniAppJson | undefined> => {
      const text = this.stored.get(key);
      return text === undefined ? undefined : (JSON.parse(text) as MiniAppJson);
    },
    set: async (key: string, value: MiniAppJson): Promise<void> => {
      if (!strictJson(value)) throw new Error("bad-request");
      const text = JSON.stringify(value);
      if (new TextEncoder().encode(text).length > MINI_APP_LIMITS.storageValueBytes) throw new Error("value too big");
      this.sets.push(key);
      this.stored.set(key, text);
    },
    delete: async (key: string): Promise<void> => {
      this.stored.delete(key);
    },
    keys: async (): Promise<string[]> => [...this.stored.keys()],
  };

  chat = {
    send: async (value: MiniAppJson): Promise<void> => {
      const peer = this.peer;
      if (!this.isOpen || !peer?.isOpen || this.held) throw new Error("the peer does not have the app open");
      if (!strictJson(value)) throw new Error("bad-request");
      if (new TextEncoder().encode(JSON.stringify(value)).length > MINI_APP_LIMITS.chatDataBytes) throw new Error("frame too big");
      const frame = this.rewrite ? this.rewrite(JSON.parse(JSON.stringify(value)) as Frame) : (value as Frame);
      if (!frame) return;
      this.sent.push({ at: this.clock.now, frame });
      if (this.drop?.(frame)) return;
      peer.arrive(JSON.parse(JSON.stringify(frame)) as MiniAppJson, this.latency);
    },
    on: ((event: "message" | "peer", listener: (data: never) => void) => {
      const set = (event === "message" ? this.messageListeners : this.peerListeners) as Set<(data: never) => void>;
      set.add(listener);
      return () => set.delete(listener);
    }) as MiniAppApi["chat"]["on"],
  };

  async close(): Promise<void> {
    this.shutdown();
  }

  launch(): void {
    this.isOpen = true;
    this.peer?.peerEvent({ open: true, version: this.version });
  }

  /** The app closes (or reloads): its listeners go, and what was on its way to it is lost. */
  shutdown(): void {
    this.isOpen = false;
    this.messageListeners.clear();
    this.peerListeners.clear();
    this.inbox = [];
    this.peer?.peerEvent({ open: false });
  }

  /** A frame from the peer, at once (a hostile peer's script). */
  inject(value: unknown): void {
    this.arrive(value as MiniAppJson, 0);
  }

  peerEvent(event: MiniAppPeerEvent): void {
    if (!this.isOpen) return;
    this.inbox.push({ due: this.clock.now, peer: event });
  }

  private arrive(value: MiniAppJson, latency: number): void {
    // In order, as one connection delivers: never before a frame sent earlier.
    this.lastDue = Math.max(this.lastDue, this.clock.now + latency);
    this.inbox.push({ due: this.lastDue, value });
  }

  /** When the next frame is due, if one is on its way. */
  nextDue(): number | undefined {
    return this.inbox[0]?.due;
  }

  /** Whether something is due now. */
  due(): boolean {
    return this.inbox.some((a) => a.due <= this.clock.now);
  }

  /** Hands over what is due now, in order. */
  pump(): boolean {
    let any = false;
    while (this.inbox.length && this.inbox[0].due <= this.clock.now) {
      const next = this.inbox.shift()!;
      any = true;
      if (!this.isOpen) continue;
      if (next.peer) for (const l of [...this.peerListeners]) l(next.peer);
      else for (const l of [...this.messageListeners]) l(next.value!);
    }
    return any;
  }

  /** The frames of a kind this side sent. */
  kinds(kind: string): Frame[] {
    return this.sent.map((s) => s.frame).filter((f) => f.k === kind);
  }
}

export interface Side {
  name: string;
  broker: LinkBroker;
  game: ChessController;
  notices: Notice[];
  /** This side's monotonic clock: it starts anywhere (a new page starts it again) and runs at `rate`. */
  mono: number;
  rate: number;
}

export class Link {
  readonly clock = new Clock();
  readonly a: LinkBroker;
  readonly b: LinkBroker;
  readonly sides: Side[] = [];

  constructor(versionA = "2.1.0", versionB = versionA) {
    this.a = new LinkBroker("ana", this.clock, versionA);
    this.b = new LinkBroker("bob", this.clock, versionB);
    this.a.peer = this.b;
    this.b.peer = this.a;
  }

  /** Opens Chess on a broker (again after a close: a new page, its monotonic clock started afresh). */
  async open(broker: LinkBroker, options: ControllerOptions = {}): Promise<Side> {
    const old = this.sides.find((s) => s.broker === broker);
    if (old) this.sides.splice(this.sides.indexOf(old), 1);
    broker.launch();
    const side = { name: broker.name, broker, notices: [] as Notice[], mono: 1_000_000 + Math.floor(this.clock.now / 7), rate: 1 } as Side;
    side.game = new ChessController(broker, { now: () => WALL0 + this.clock.now, mono: () => side.mono, helloRetryMs: 0, ...options });
    side.game.onNotice((n) => side.notices.push(n));
    this.sides.push(side);
    await side.game.start();
    await this.settle();
    return side;
  }

  /** Closes a side's Chess (or its page reloads). */
  async close(side: Side): Promise<void> {
    side.game.stop();
    side.broker.shutdown();
    this.sides.splice(this.sides.indexOf(side), 1);
    await this.settle();
  }

  /** Until nothing is due and both controllers are idle. */
  async settle(): Promise<void> {
    for (let idle = 0; idle < 3; ) {
      let any = false;
      for (const broker of [this.a, this.b]) any = broker.pump() || any;
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.all(this.sides.map((s) => s.game.settled()));
      idle = !any && !this.a.due() && !this.b.due() ? idle + 1 : 0;
    }
  }

  /**
   * Moves virtual time on by `ms`, in steps (and to the moment each frame is due, so it arrives on time), with each
   * open side's tick() at every step.
   */
  async advance(ms: number, step = 100): Promise<void> {
    for (let done = 0; done < ms; ) {
      const next = Math.min(...[this.a.nextDue(), this.b.nextDue()].filter((d): d is number => d !== undefined && d > this.clock.now));
      const d = Math.max(1, Math.min(step, ms - done, Number.isFinite(next) ? next - this.clock.now : Infinity));
      done += d;
      this.clock.now += d;
      for (const s of this.sides) s.mono += d * s.rate;
      await this.settle();
      for (const s of this.sides) await s.game.tick();
      await this.settle();
    }
  }

  /** The chat's connection dropped and came back: each side hears the other open again. */
  async reconnect(): Promise<void> {
    this.a.peerEvent({ open: true, version: this.b.version });
    this.b.peerEvent({ open: true, version: this.a.version });
    await this.settle();
  }

  /** A held session: sends refused on both sides. */
  hold(on: boolean): void {
    this.a.held = this.b.held = on;
  }
}

/** Ana invites to `tc`, Bob accepts: a timed game. */
export async function timedGame(tc: TimeControl, link = new Link()): Promise<{ link: Link; ana: Side; bob: Side; white: Side; black: Side }> {
  const ana = await link.open(link.a);
  const bob = await link.open(link.b);
  await link.advance(100);
  await ana.game.invite(tc);
  await link.advance(100);
  await bob.game.acceptInvitation();
  await link.advance(100);
  const white = ana.game.view().me === "w" ? ana : bob;
  const black = white === ana ? bob : ana;
  if (!white.game.view().tc || black.game.view().me !== "b") throw new Error("no timed game");
  return { link, ana, bob, white, black };
}

/** Plays one UCI ply by the side to move, and lets 20 ms go by (a quick connection carries it meanwhile). */
export async function play(link: Link, side: Side, uci: string): Promise<void> {
  const ok = await side.game.move(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, uci[4] as "q" | undefined);
  if (!ok) throw new Error(`${uci} was refused for ${side.name}`);
  await link.advance(20, 10);
}

/** The game record a side keeps. */
export const record = (side: Side) => JSON.parse(side.broker.stored.get("game")!) as { m: string[]; k?: number[]; ts?: number; tw?: number; pc?: number; fl?: number; x?: unknown };
