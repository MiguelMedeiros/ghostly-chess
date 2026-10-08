// @vitest-environment happy-dom
// covers: apps.chess
// The sounds, with a fake AudioContext: made and resumed only inside a user activation, one sound per event by
// priority, silent when muted, hidden, or without Web Audio.
import { describe, expect, it } from "vitest";
import type { View } from "../src/game.ts";
import { PRIORITY, soundOf, Sounds, synthesize, type AudioContextLike, type Seen, type SoundName } from "../src/sound.ts";

/** An AudioParam that takes every call. */
const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} });
const node = () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, gain: param(), frequency: param(), Q: param(), type: "", buffer: null });

/** A fake context: records what made it, its resumes and the nodes started. */
class FakeContext implements AudioContextLike {
  state = "suspended";
  currentTime = 0;
  sampleRate = 8000;
  destination = node() as unknown as AudioNode;
  resumes = 0;
  started = 0;
  resume(): Promise<void> {
    this.resumes++;
    this.state = "running";
    return Promise.resolve();
  }
  createGain() {
    return node() as unknown as GainNode;
  }
  createOscillator() {
    const n = node();
    n.start = () => void this.started++;
    return n as unknown as OscillatorNode;
  }
  createBuffer(_c: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data } as unknown as AudioBuffer;
  }
  createBufferSource() {
    const n = node();
    n.start = () => void this.started++;
    return n as unknown as AudioBufferSourceNode;
  }
  createBiquadFilter() {
    return node() as unknown as BiquadFilterNode;
  }
}

function setup(options: { enabled?: () => boolean; hidden?: () => boolean; create?: () => AudioContextLike | null } = {}) {
  const target = new EventTarget();
  const contexts: FakeContext[] = [];
  const played: SoundName[] = [];
  const sounds = new Sounds({
    target,
    enabled: options.enabled ?? (() => true),
    hidden: options.hidden ?? (() => false),
    create:
      options.create ??
      (() => {
        const c = new FakeContext();
        contexts.push(c);
        return c;
      }),
    synth: (_context, name) => played.push(name),
  });
  return { target, contexts, played, sounds };
}

const pointerEvent = (type: string, pointerType: string) => {
  const e = new Event(type) as Event & { pointerType: string };
  e.pointerType = pointerType;
  return e;
};

describe("the audio context", () => {
  it("is made and resumed only inside a click, a pointerup or a keydown, never a touch's pointerdown", async () => {
    for (const type of ["click", "pointerup", "keydown"]) {
      const { target, contexts, played, sounds } = setup();
      sounds.play("move");
      expect(played, "nothing before an activation").toEqual([]);
      expect(sounds.state()).toBe("none");
      target.dispatchEvent(pointerEvent("pointerdown", "touch"));
      target.dispatchEvent(pointerEvent("pointerdown", "mouse"));
      target.dispatchEvent(new Event("touchstart"));
      expect(contexts, `no context from a pointerdown (${type})`).toHaveLength(0);
      target.dispatchEvent(type === "pointerup" ? pointerEvent(type, "touch") : new Event(type));
      expect(contexts).toHaveLength(1);
      expect(contexts[0].resumes).toBe(1);
      await Promise.resolve();
      expect(sounds.state()).toBe("running");
      sounds.play("move");
      expect(played).toEqual(["move"]);
      // One context, ever; resumed again only when it stopped running.
      target.dispatchEvent(new Event("click"));
      expect(contexts).toHaveLength(1);
      expect(contexts[0].resumes).toBe(1);
      contexts[0].state = "suspended";
      target.dispatchEvent(new Event("keydown"));
      expect(contexts[0].resumes).toBe(2);
      sounds.stop();
    }
  });

  it("is silent and never throws without Web Audio", () => {
    const none = setup({ create: () => null });
    none.target.dispatchEvent(new Event("click"));
    expect(() => none.sounds.play("check")).not.toThrow();
    expect(none.played).toEqual([]);
    expect(none.sounds.state()).toBe("none");
    // A constructor that throws (a browser out of contexts) is the same.
    const broken = setup({
      create: () => {
        throw new Error("no audio");
      },
    });
    expect(() => broken.target.dispatchEvent(new Event("click"))).not.toThrow();
    expect(() => broken.sounds.play("end")).not.toThrow();
    expect(broken.played).toEqual([]);
    // With the browser's own default: happy-dom has no AudioContext.
    const target = new EventTarget();
    const real = new Sounds({ target, enabled: () => true });
    expect(() => target.dispatchEvent(new Event("click"))).not.toThrow();
    expect(() => real.play("move")).not.toThrow();
    expect(real.state()).toBe("none");
  });

  it("is silent when the chat's sound setting is off, or the page is hidden", async () => {
    let on = false;
    let hidden = false;
    const { target, played, sounds } = setup({ enabled: () => on, hidden: () => hidden });
    target.dispatchEvent(new Event("click"));
    await Promise.resolve();
    sounds.play("move");
    expect(played).toEqual([]);
    on = true;
    hidden = true;
    sounds.play("move");
    expect(played).toEqual([]);
    hidden = false;
    sounds.play("move");
    expect(played).toEqual(["move"]);
  });

  it("synthesizes every sound on a context without throwing", () => {
    const context = new FakeContext();
    context.state = "running";
    for (const name of ["move", "capture", "check", "castle", "promote", "start", "end", "lowTime"] as SoundName[]) {
      const before = context.started;
      expect(() => synthesize(context, name)).not.toThrow();
      expect(context.started, name).toBeGreaterThan(before);
    }
  });
});

describe("one sound per event", () => {
  const view = (over: Partial<View>): View => ({ phase: "playing", peerOpen: true, fen: "", turn: "w", plies: 1, inCheck: false, canMove: true, ...over });
  const seen = (over: Partial<Seen> = {}): Seen => ({ plies: 0, phase: "playing", ended: false, ...over });
  const lastMove = { from: "e7", to: "e8", san: "x", colour: "w", piece: "p" } as const;

  it("follows the priority: game end > check > promote > castle > capture > move", () => {
    expect(PRIORITY).toEqual(["end", "check", "promote", "castle", "capture", "move"]);
    const all = { ...lastMove, captured: "r", promotion: "q", castle: "k" } as const;
    // A mating move that promotes and captures: the game end, once.
    expect(soundOf(seen(), view({ lastMove: all, inCheck: true, end: { result: "1-0", why: "checkmate" } }))).toBe("end");
    expect(soundOf(seen(), view({ lastMove: all, inCheck: true }))).toBe("check");
    expect(soundOf(seen(), view({ lastMove: all }))).toBe("promote");
    expect(soundOf(seen(), view({ lastMove: { ...lastMove, castle: "k", captured: "p" } }))).toBe("castle");
    expect(soundOf(seen(), view({ lastMove: { ...lastMove, captured: "p" } }))).toBe("capture");
    expect(soundOf(seen(), view({ lastMove }))).toBe("move");
  });

  it("plays the start when the toss gives a game, the end on a resignation, and nothing for a jump or the first render", () => {
    expect(soundOf(seen({ phase: "toss" }), view({ plies: 0 }))).toBe("start");
    expect(soundOf(seen({ plies: 3 }), view({ plies: 3, phase: "over", end: { result: "0-1", why: "resign" } }))).toBe("end");
    // A catch-up of several plies (a reload, a sync) and the page's first render are silent.
    expect(soundOf(seen({ plies: 0 }), view({ plies: 5, lastMove }))).toBeUndefined();
    expect(soundOf(null, view({ lastMove }))).toBeUndefined();
    // A new game after a finished one (fewer plies, no end) is not an end.
    expect(soundOf(seen({ plies: 9, ended: true, phase: "over" }), view({ phase: "toss", plies: 0 }))).toBeUndefined();
  });
});
