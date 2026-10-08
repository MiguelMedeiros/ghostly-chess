/**
 * Which protocol this side speaks with the contact's Chess, decided on each peer open, on evidence rather than on the
 * version string alone.
 *
 * - The peer's version (context().peer.version, or chat.peer {open, version}) below PROTO2_SINCE, unparseable or
 *   missing: version 1 at once. This side sends exactly Chess 1.0.2's opening frames and never a v2 frame.
 * - At or above it: this side sends hello first and holds every game frame until the peer's hello. If a v1 frame
 *   arrives instead, it switches to version 1 and sends the v1 opening frames.
 * - A v2 hello received in version 1 (a version misread) upgrades the mode, and this side answers with its own hello.
 * - The effective features are the intersection of both hellos' lists.
 * - A hello received in version 2 is answered with ours only when this side has sent no hello since the last one it
 *   received. So a side that re-opened (a second open event, a reload the other side did not see close) and is
 *   waiting again gets an answer, and two hellos never answer each other forever. Beyond that, as with 1.0.2's own
 *   opening, it relies on the broker telling each side when the other opens Chess.
 *
 * No nudge goes to a version 1 peer: Ghostly checks for app updates itself, and a v2 frame would make 1.0.2 show
 * "Update to keep playing" although play goes on.
 *
 * Pure state, no I/O: the controller (game.ts) asks it what to do and does it.
 */
import { speaksV2, type Envelope, type Kind } from "./protocol.ts";

/** "v1": Chess 1.0.2's protocol. "hello": our hello is out, the peer's is awaited. "v2": both hellos seen. */
export type Mode = "v1" | "hello" | "v2";

/** What the controller does with a frame that just arrived, and what it sends first. */
export interface FrameDecision {
  /** Handle the frame (in the mode now in force). */
  handle: boolean;
  /** Send our hello (we were in version 1 and the peer turned out to speak version 2). */
  sendHello: boolean;
  /** Send the opening of the mode now in force (the toss, the invitation or the game), before handling the frame. */
  sendOpening: boolean;
  /** The mode changed. */
  changed: boolean;
}

export class Negotiator {
  private current: Mode = "v1";
  private version: string | undefined;
  private peerList: string[] = [];
  private name: string | undefined;
  /** This side sent a hello after the last hello it received. */
  private sentSinceReceived = false;
  /** The peer's open has been seen (and not its close since). */
  private opened = false;
  /** A hello that came before this side saw the peer open: the peer's page can be quicker than the broker's event. */
  private early: { f: string[]; n?: string } | null = null;

  constructor(private readonly own: readonly string[]) {}

  /** The mode now in force. Before any open it is version 1, the only one a closed peer could have saved for. */
  get mode(): Mode {
    return this.current;
  }

  /** The envelope this side writes now. */
  get envelope(): Envelope {
    return this.current === "v1" ? 1 : 2;
  }

  /** The peer's version, as its client reported it on the last open. */
  get peerVersion(): string | undefined {
    return this.version;
  }

  /** The peer's display name, from its hello. */
  get peerName(): string | undefined {
    return this.name;
  }

  /** The features both sides named: empty until the peer's hello, and in version 1. */
  get features(): string[] {
    if (this.current !== "v2") return [];
    return this.own.filter((f) => this.peerList.includes(f));
  }

  /** The features the peer named in its hello. */
  get peerFeatures(): string[] {
    return [...this.peerList];
  }

  /** Game frames wait for the peer's hello. */
  get holding(): boolean {
    return this.current === "hello";
  }

  /**
   * The peer opened Chess (again, or in another version). Returns whether this side opens with a hello, and whether
   * the peer's hello is already here (it came before the open event), so the version 2 opening goes at once.
   */
  open(version: string | undefined): { sendHello: boolean; sendOpening: boolean } {
    this.version = typeof version === "string" && version ? version : undefined;
    this.opened = true;
    const early = this.early;
    this.early = null;
    this.peerList = early ? [...early.f] : [];
    this.name = early?.n;
    // A hello already here is evidence that beats the version string.
    this.current = early ? "v2" : speaksV2(this.version) ? "hello" : "v1";
    if (this.current !== "v1") this.sentSinceReceived = true;
    return { sendHello: this.current !== "v1", sendOpening: Boolean(early) };
  }

  /** The peer closed Chess: what it said before is forgotten until it opens again. */
  close(): void {
    this.opened = false;
    this.early = null;
  }

  /** A frame arrived in this envelope. */
  receive(envelope: Envelope, kind: Kind, hello?: { f: string[]; n?: string }): FrameDecision {
    const none: FrameDecision = { handle: false, sendHello: false, sendOpening: false, changed: false };
    if (kind === "hello" && !this.opened) {
      // Before the open event: kept for it (see open), nothing sent yet.
      this.early = { f: [...(hello?.f ?? [])], n: hello?.n };
      return none;
    }
    if (kind === "hello") {
      this.peerList = [...(hello?.f ?? [])];
      this.name = hello?.n;
      const before = this.current;
      const answered = this.sentSinceReceived;
      this.sentSinceReceived = false;
      this.current = "v2";
      // From version 1: the version was misread, so the peer has not had our hello. From "hello": both are out now.
      if (before === "v1") {
        this.sentSinceReceived = true;
        return { ...none, sendHello: true, sendOpening: true, changed: true };
      }
      if (before === "hello") return { ...none, sendOpening: true, changed: true };
      // A hello again in version 2: the peer opened again and waits. Answered once, with the opening after it.
      if (answered) return none;
      this.sentSinceReceived = true;
      return { ...none, sendHello: true, sendOpening: true };
    }
    if (envelope === 1) {
      // The peer speaks version 1 although its version said 2: switch, and open as Chess 1.0.2 does.
      if (this.current === "hello") {
        this.current = "v1";
        this.peerList = [];
        return { handle: true, sendHello: false, sendOpening: true, changed: true };
      }
      // In version 2, a version 1 frame is still read: it may be about a game begun on 1.0.2 (dv:1).
      return { ...none, handle: true };
    }
    // A version 2 frame other than hello. In version 1 it cannot be from the peer we negotiated with: ignored.
    if (this.current === "v1") return none;
    return { ...none, handle: true };
  }
}
