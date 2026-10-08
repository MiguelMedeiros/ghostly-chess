/**
 * Sounds, synthesized with Web Audio (oscillators and noise bursts under short envelopes): no audio file, no licence.
 *
 * Browsers start audio only from a user activation, so there is one AudioContext, made and resumed inside the first
 * click, pointerup or keydown in the frame (a touch's pointerdown is not an activation under HTML's rules, and a
 * context made there would stay suspended). Before that, play() is silent; without Web Audio it is silent always,
 * and it never throws.
 *
 * One sound per event, by priority: game end > check > promote > castle > capture > move. Nothing plays while the
 * page is hidden, or when this chat's sound setting is off. On an iPhone, the ring/silent switch mutes Web Audio.
 */
import type { View } from "./game.ts";

export type SoundName = "move" | "capture" | "check" | "castle" | "promote" | "start" | "end" | "lowTime";

/** The events a ply can be, highest first: the first that applies is the one heard. */
export const PRIORITY = ["end", "check", "promote", "castle", "capture", "move"] as const;

/** What the page saw at its last render, to tell what changed. */
export interface Seen {
  plies: number;
  phase: View["phase"];
  ended: boolean;
}

/**
 * The one sound for a change of the live game, if any: a game that just ended, else the ply just played (check, then
 * promotion, castling, capture, a plain move), else a game that just began. A jump of several plies (a reload, a
 * catch-up) plays nothing.
 */
export function soundOf(before: Seen | null, view: View): SoundName | undefined {
  if (!before) return undefined;
  if (view.end && !before.ended && view.plies >= before.plies) return "end";
  if (view.plies === before.plies + 1 && view.lastMove) {
    const move = view.lastMove;
    if (view.inCheck) return "check";
    if (move.promotion) return "promote";
    if (move.castle) return "castle";
    if (move.captured) return "capture";
    return "move";
  }
  if (view.phase === "playing" && view.plies === 0 && before.phase === "toss") return "start";
  return undefined;
}

/** The part of an AudioContext the sounds use. */
export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNode;
  resume(): Promise<void>;
  createGain(): GainNode;
  createOscillator(): OscillatorNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  createBiquadFilter(): BiquadFilterNode;
}

export interface SoundOptions {
  /** This chat's setting: false is silent. */
  enabled: () => boolean;
  /** Makes the context; null when the browser has no Web Audio. Called only inside a user activation. */
  create?: () => AudioContextLike | null;
  hidden?: () => boolean;
  /** Where the activations are heard (the document). */
  target?: EventTarget;
  /** Plays a named sound on a running context (the synthesizer; tests count calls). */
  synth?: (context: AudioContextLike, name: SoundName) => void;
}

function defaultContext(): AudioContextLike | null {
  const w = globalThis as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

const ACTIVATIONS = ["click", "pointerup", "keydown"] as const;

export class Sounds {
  private context: AudioContextLike | null = null;
  private failed = false;
  /** A resume() asked inside an activation and not settled yet: a sound played meanwhile starts when it does. */
  private resuming = false;
  private readonly options: Required<Omit<SoundOptions, "target">> & { target: EventTarget | undefined };
  private readonly unlock = () => this.activate();

  constructor(options: SoundOptions) {
    this.options = {
      enabled: options.enabled,
      create: options.create ?? defaultContext,
      hidden: options.hidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden"),
      target: options.target ?? (typeof document !== "undefined" ? document : undefined),
      synth: options.synth ?? synthesize,
    };
    // Capture phase: before a handler further down can stop the event.
    for (const type of ACTIVATIONS) this.options.target?.addEventListener(type, this.unlock, true);
  }

  stop(): void {
    for (const type of ACTIVATIONS) this.options.target?.removeEventListener(type, this.unlock, true);
  }

  /** The context's state, for tests: "none" before the first activation. */
  state(): string {
    return this.context?.state ?? "none";
  }

  /** Inside a user activation: makes the context once, and resumes it whenever it is not running. */
  private activate(): void {
    if (this.failed) return;
    try {
      this.context ??= this.options.create();
      if (!this.context) {
        this.failed = true;
        return;
      }
      if (this.context.state !== "running" && !this.resuming) {
        this.resuming = true;
        const done = () => void (this.resuming = false);
        this.context.resume().then(done, done);
      }
    } catch {
      this.failed = true;
      this.context = null;
    }
  }

  play(name: SoundName | undefined): void {
    if (!name || !this.options.enabled() || this.options.hidden()) return;
    const context = this.context;
    if (!context || (context.state !== "running" && !this.resuming)) return;
    try {
      this.options.synth(context, name);
    } catch {
      // A sound is never worth an error.
    }
  }
}

// ---------- the synthesizer ----------

const noiseBuffers = new WeakMap<AudioContextLike, AudioBuffer>();

function noiseBuffer(context: AudioContextLike): AudioBuffer {
  let buffer = noiseBuffers.get(context);
  if (!buffer) {
    const length = Math.floor(context.sampleRate * 0.25);
    buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x2545f491;
    for (let i = 0; i < length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    }
    noiseBuffers.set(context, buffer);
  }
  return buffer;
}

/** A gain envelope: a fast attack to `peak`, then an exponential fall over `length` seconds. */
function envelope(context: AudioContextLike, at: number, length: number, peak: number, out: AudioNode): GainNode {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  gain.connect(out);
  return gain;
}

function tone(context: AudioContextLike, out: AudioNode, at: number, length: number, freq: number, peak: number, type: OscillatorType = "sine", to?: number): void {
  const osc = context.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, at + length);
  osc.connect(envelope(context, at, length, peak, out));
  osc.start(at);
  osc.stop(at + length + 0.02);
}

/** A wooden knock: a band of noise and a low thump. */
function knock(context: AudioContextLike, out: AudioNode, at: number, loud: number, pitch: number): void {
  const source = context.createBufferSource();
  source.buffer = noiseBuffer(context);
  const filter = context.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(pitch, at);
  filter.Q.setValueAtTime(1.2, at);
  source.connect(filter);
  filter.connect(envelope(context, at, 0.06 + 0.03 * loud, 0.5 * loud, out));
  source.start(at);
  source.stop(at + 0.12);
  tone(context, out, at, 0.05 + 0.03 * loud, 150 / loud, 0.35 * loud, "triangle", 70);
}

/** Plays one named sound now. */
export function synthesize(context: AudioContextLike, name: SoundName): void {
  const out = context.createGain();
  out.gain.setValueAtTime(0.35, context.currentTime);
  out.connect(context.destination);
  const t = context.currentTime + 0.005;
  switch (name) {
    case "move":
      return knock(context, out, t, 1, 1700);
    case "capture":
      return knock(context, out, t, 1.6, 1100);
    case "castle":
      knock(context, out, t, 1, 1700);
      return knock(context, out, t + 0.09, 1, 1500);
    case "check":
      knock(context, out, t, 1, 1700);
      return tone(context, out, t + 0.02, 0.16, 880, 0.22, "triangle");
    case "promote":
      knock(context, out, t, 1, 1700);
      return tone(context, out, t + 0.03, 0.22, 520, 0.2, "triangle", 1040);
    case "start":
      tone(context, out, t, 0.12, 523, 0.22, "triangle");
      return tone(context, out, t + 0.11, 0.2, 784, 0.22, "triangle");
    case "end":
      tone(context, out, t, 0.18, 784, 0.22, "triangle");
      tone(context, out, t + 0.14, 0.18, 659, 0.22, "triangle");
      return tone(context, out, t + 0.28, 0.32, 523, 0.24, "triangle");
    case "lowTime":
      tone(context, out, t, 0.07, 1320, 0.18, "square");
      return tone(context, out, t + 0.12, 0.07, 1320, 0.18, "square");
  }
}
