/**
 * Premoves: one move queued during the contact's turn, played as soon as the contact's move arrives.
 *
 * - The targets are where the piece could go on a later turn: its moves on an empty board (a pawn's push, its double
 *   push from its start, and both diagonals; a king's castling squares from its start), whatever stands there now. A
 *   recapture onto a square one's own piece holds now is a premove too.
 * - It is played through the controller as an ordinary move the moment it is this side's turn after one more ply,
 *   so it is checked, timed and sent like any move. Illegal then, it is dropped and nothing is sent.
 * - A pawn's premove to the last rank promotes to a queen: the picker cannot open on the contact's turn.
 * - Anything else that changes the game (a takeback, an end, a new game) drops it. The page drops it on Escape, a
 *   right-click or a long press, a click on a square that is not a target, while reviewing, and when the "premove"
 *   setting is off. It is local: no frame, no feature.
 */
import type { Square } from "chess.js";
import type { ChessController } from "./game.ts";

const FILES = "abcdefgh";
type Grid = ReturnType<ChessController["board"]>;

const STEPS = {
  n: [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]],
  k: [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
};

/** The piece on a square of chess.js's board (rank 8 first). */
const at = (grid: Grid, square: Square) => grid[8 - Number(square[1])][FILES.indexOf(square[0])];

/** Where the piece on `from` could go on a later turn, by its moves on an empty board. */
export function premoveTargets(grid: Grid, from: Square): Square[] {
  const piece = at(grid, from);
  if (!piece) return [];
  const f = FILES.indexOf(from[0]);
  const r = Number(from[1]) - 1;
  const out: Square[] = [];
  const add = (df: number, dr: number) => {
    const x = f + df;
    const y = r + dr;
    if (x >= 0 && x < 8 && y >= 0 && y < 8) out.push(`${FILES[x]}${y + 1}` as Square);
  };
  const up = piece.color === "w" ? 1 : -1;
  const home = piece.color === "w" ? 0 : 7;
  if (piece.type === "p") {
    add(0, up);
    if (r === home + up) add(0, 2 * up);
    add(-1, up);
    add(1, up);
  } else if (piece.type === "n" || piece.type === "k") {
    for (const [df, dr] of STEPS[piece.type]) add(df, dr);
    if (piece.type === "k" && f === 4 && r === home) {
      add(2, 0);
      add(-2, 0);
    }
  } else {
    const dirs = piece.type === "q" ? [...STEPS.r, ...STEPS.b] : STEPS[piece.type as "r" | "b"];
    for (const [df, dr] of dirs) for (let i = 1; i < 8; i++) add(df * i, dr * i);
  }
  return out;
}

export interface Queued {
  from: Square;
  to: Square;
}

export class Premove {
  private queued: (Queued & { plies: number }) | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly off: () => void;

  /** `enabled` reads the "premove" setting. */
  constructor(
    private readonly game: ChessController,
    private readonly enabled: () => boolean,
  ) {
    this.off = game.subscribe(() => this.changed());
  }

  stop(): void {
    this.off();
  }

  get(): Queued | null {
    return this.queued && { from: this.queued.from, to: this.queued.to };
  }

  /** Where the piece on `from` may be premoved now: one of this side's pieces, on the contact's turn. */
  targets(from: Square): Square[] {
    const view = this.game.view();
    if (!this.enabled() || !view.canPremove) return [];
    const piece = at(this.game.board(), from);
    return piece?.color === view.me ? premoveTargets(this.game.board(), from) : [];
  }

  /** Queues from → to (replacing a premove queued before); false when it is not a target now. */
  set(from: Square, to: Square): boolean {
    if (!this.targets(from).includes(to)) return false;
    this.queued = { from, to, plies: this.game.view().plies };
    this.emit();
    return true;
  }

  clear(): void {
    if (!this.queued) return;
    this.queued = null;
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The game changed: still the contact's turn, the premove waits; after its one ply, it is played; else dropped. */
  private changed(): void {
    const queued = this.queued;
    if (!queued) return;
    const view = this.game.view();
    if (view.canPremove && view.plies === queued.plies) return;
    this.queued = null;
    this.emit();
    if (!view.canMove || view.plies !== queued.plies + 1 || !this.enabled()) return;
    const piece = at(this.game.board(), queued.from);
    const promotion = piece?.type === "p" && /[18]$/.test(queued.to) ? "q" : undefined;
    void this.game.move(queued.from, queued.to, promotion);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
