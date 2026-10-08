/**
 * A review cursor over the live game. The board is drawn from it: live, it is the game itself; reviewing, it shows the
 * position after the ply under the cursor, and no move can be made (nor a premove queued).
 *
 * The game goes on underneath: the contact's moves still land in the move list (with their sound, which the page
 * plays from the live game), while the board stays at the cursor. Reaching the last ply, Last, or Back to live return
 * to the game. Play steps once a second from the cursor (from the start when live) and stops at the live position.
 *
 * The cursor never changes the game: it is not saved and not sent, and the game stays in its phase.
 */
import { Chess, type Square } from "chess.js";
import type { BoardGame } from "./board.ts";
import type { ChessController, View } from "./game.ts";
import type { LastMove, Ply } from "./history.ts";

export const PLAY_STEP_MS = 1000;

function lastMoveOf(ply: Ply): LastMove {
  const { from, to, san, colour, piece, captured, promotion, castle } = ply;
  const out: LastMove = { from, to, san, colour, piece };
  if (captured) out.captured = captured;
  if (promotion) out.promotion = promotion;
  if (castle) out.castle = castle;
  return out;
}

export class Review implements BoardGame {
  /** The ply under the cursor (0 is the start), or null when live. */
  private cursor: number | null = null;
  /** The position at the cursor when it was set: a new game under it (another position there) goes live. */
  private cursorFen = "";
  private timer: ReturnType<typeof setInterval> | undefined;
  private cache: { fen: string; board: ReturnType<Chess["board"]> } | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly off: () => void;

  constructor(private readonly game: ChessController) {
    // Before the page's own listener (a Set calls in order): the cursor is checked against the new game first.
    this.off = game.subscribe(() => this.gameChanged());
  }

  stop(): void {
    this.pause();
    this.off();
  }

  /** The ply the board shows. */
  ply(): number {
    return this.cursor ?? this.game.view().plies;
  }

  reviewing(): boolean {
    return this.cursor !== null;
  }

  playing(): boolean {
    return this.timer !== undefined;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- moving the cursor ----------

  /** Shows the position after `ply`; the last ply is the live game. */
  go(ply: number, keepPlaying = false): void {
    if (!keepPlaying) this.pause();
    const plies = this.game.view().plies;
    const at = Math.max(0, Math.min(plies, Math.trunc(ply)));
    const next = at >= plies ? null : at;
    if (next === this.cursor) return this.changed();
    this.cursor = next;
    this.cursorFen = next === null ? "" : this.game.record().fens[next];
    if (next === null) this.pause();
    this.changed();
  }

  first(): void {
    this.go(0);
  }

  prev(): void {
    this.go(this.ply() - 1);
  }

  next(): void {
    if (this.cursor !== null) this.go(this.cursor + 1);
  }

  /** Back to the game. */
  live(): void {
    this.pause();
    if (this.cursor === null) return;
    this.cursor = null;
    this.changed();
  }

  /** Plays the game through from the cursor (from the start when live), a ply a second; again, it pauses. */
  play(): void {
    if (this.timer !== undefined) return this.pause();
    if (this.game.view().plies === 0) return;
    if (this.cursor === null) this.go(0);
    this.timer = setInterval(() => {
      if (this.cursor === null) return this.pause();
      this.go(this.cursor + 1, true);
    }, PLAY_STEP_MS);
    this.changed();
  }

  pause(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.changed();
  }

  // ---------- what the board reads ----------

  view(): View {
    const live = this.game.view();
    const at = this.cursor;
    if (at === null) return live;
    const record = this.game.record();
    const ply = record.plies[at - 1];
    return {
      ...live,
      fen: record.fens[at],
      turn: at % 2 === 0 ? "w" : "b",
      plies: at,
      lastMove: ply ? lastMoveOf(ply) : undefined,
      inCheck: ply?.check ?? false,
      canMove: false,
      canPremove: false,
    };
  }

  board(): ReturnType<Chess["board"]> {
    if (this.cursor === null) return this.game.board();
    const fen = this.game.record().fens[this.cursor];
    if (this.cache?.fen !== fen) this.cache = { fen, board: new Chess(fen).board() };
    return this.cache.board;
  }

  targets(square: Square): { to: Square; promotion: boolean }[] {
    return this.cursor === null ? this.game.targets(square) : [];
  }

  move(from: Square, to: Square, promotion?: "q" | "r" | "b" | "n"): Promise<boolean> {
    return this.cursor === null ? this.game.move(from, to, promotion) : Promise.resolve(false);
  }

  // ---------- helpers ----------

  /** The game changed: new moves leave the cursor where it is; a new game (or a takeback past it) goes live. */
  private gameChanged(): void {
    if (this.cursor === null) return;
    const record = this.game.record();
    if (this.cursor >= record.sans.length || record.fens[this.cursor] !== this.cursorFen) {
      this.cursor = null;
      this.pause();
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
