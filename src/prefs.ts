/**
 * The settings, per chat, under the storage key "prefs". The broker's storage is per app and per chat (and an
 * opaque-origin frame has no localStorage), so each chat keeps its own: a board turned in one chat stays as it is in
 * another.
 *
 * What is read is checked, and anything missing or wrong falls back to its default, so a foreign or damaged value never
 * breaks the board. The record is written only when a setting changes: the broker allows 50 requests a second.
 *
 * `turned` is the board's orientation against the default (your colour at the bottom). It is not called `flip`, which
 * is the colour toss's storage key.
 *
 * `premove` is read only from a record that carries `pm: 1`, which Chess writes from 2.2.0 on. Chess 2.0 and 2.1 had
 * no premove control but wrote the whole record, `premove: false` (their default) included, on any change: that value
 * was never the player's choice, so such a record gets 2.2.0's default (on) instead.
 */
import type { MiniAppApi, MiniAppJson } from "./vendor/miniApp.ts";
import { PIECE_SETS, type PieceSet } from "./pieces.ts";

export const BOARD_THEMES = ["green", "brown", "blue"] as const;
export type BoardTheme = (typeof BOARD_THEMES)[number];

// A type, not an interface: it must pass as a JSON object to the broker's storage.
export type Prefs = {
  v: 1;
  theme: BoardTheme;
  pieces: PieceSet;
  /** Coordinates a-h and 1-8 on the edge squares. */
  coords: boolean;
  /** Promote to a queen without asking. */
  autoQueen: boolean;
  /** Dots and rings on the squares a picked piece may go to. */
  legal: boolean;
  /** Sounds: moves, captures, checks and the game's start and end (sound.ts). */
  sound: boolean;
  /** Premoves: a move queued on the contact's turn (premove.ts). */
  premove: boolean;
  /** The board is turned from its default orientation. */
  turned: boolean;
};

export const PREFS_KEY = "prefs";
/** The mark of a record written by 2.2.0 or later, whose `premove` is the player's choice. */
const PREMOVE_MARK = "pm";

export const DEFAULT_PREFS: Readonly<Prefs> = Object.freeze({
  v: 1,
  theme: "green",
  pieces: "cburnett",
  coords: true,
  autoQueen: false,
  legal: true,
  sound: true,
  premove: true,
  turned: false,
});

const BOOLEANS = ["coords", "autoQueen", "legal", "sound", "premove", "turned"] as const;

/** A stored value as Prefs: each field checked, the default where it is missing or wrong. */
export function readPrefs(value: MiniAppJson | undefined): Prefs {
  const prefs: Prefs = { ...DEFAULT_PREFS };
  if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1) return prefs;
  if ((BOARD_THEMES as readonly unknown[]).includes(value.theme)) prefs.theme = value.theme as BoardTheme;
  if ((PIECE_SETS as readonly unknown[]).includes(value.pieces)) prefs.pieces = value.pieces as PieceSet;
  for (const key of BOOLEANS) {
    if (key === "premove" && value[PREMOVE_MARK] !== 1) continue;
    if (typeof value[key] === "boolean") prefs[key] = value[key] as boolean;
  }
  return prefs;
}

/** The settings of this chat: read once, written when one changes. */
export class PrefsStore {
  private current: Prefs = { ...DEFAULT_PREFS };
  private readonly listeners = new Set<(prefs: Prefs) => void>();

  /** With no broker (a test, or a board shown on its own), the settings live in memory only. */
  constructor(private readonly api: Pick<MiniAppApi, "storage"> | null) {}

  async load(): Promise<Prefs> {
    try {
      this.current = readPrefs(this.api ? await this.api.storage.get(PREFS_KEY) : undefined);
    } catch {
      this.current = { ...DEFAULT_PREFS };
    }
    this.emit();
    return this.get();
  }

  get(): Prefs {
    return { ...this.current };
  }

  /** Changes settings; writes only when something differs. */
  async set(change: Partial<Omit<Prefs, "v">>): Promise<void> {
    const next = readPrefs({ ...this.current, ...change, [PREMOVE_MARK]: 1 } as unknown as MiniAppJson);
    if (BOOLEANS.every((k) => next[k] === this.current[k]) && next.theme === this.current.theme && next.pieces === this.current.pieces) return;
    this.current = next;
    this.emit();
    try {
      await this.api?.storage.set(PREFS_KEY, { ...next, [PREMOVE_MARK]: 1 });
    } catch {
      // Kept for this session; the next change tries again.
    }
  }

  subscribe(listener: (prefs: Prefs) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.get());
  }
}
