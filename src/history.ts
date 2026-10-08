/**
 * Everything the panel shows about the moves, derived from chess.js's verbose history: SAN with move numbers, the
 * position after each ply (for review and the opening name), the pieces each side took, and the material balance.
 * No DOM and no state: the controller caches one GameHistory per position.
 */
import type { Move, Square } from "chess.js";

export type PieceType = "k" | "q" | "r" | "b" | "n" | "p";
export type Taken = "q" | "r" | "b" | "n" | "p";
type Colour = "w" | "b";

/** One ply, as the board, the move list and the announcements show it. */
export interface LastMove {
  from: Square;
  to: Square;
  san: string;
  colour: Colour;
  /** The piece that moved (a pawn when it promoted). */
  piece: PieceType;
  captured?: Taken;
  promotion?: "q" | "r" | "b" | "n";
  /** "k" or "q" when the move castled on that side. */
  castle?: "k" | "q";
}

export interface Ply extends LastMove {
  /** The FEN after this ply. */
  after: string;
  check: boolean;
  mate: boolean;
}

/** The values the material balance counts (the king counts nothing). */
export const VALUES: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** The order captured pieces are shown in: pawns first, as chess.com does. */
const TAKEN_ORDER: Taken[] = ["p", "n", "b", "r", "q"];
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function plyOf(move: Move): Ply {
  const out: Ply = { from: move.from, to: move.to, san: move.san, colour: move.color, piece: move.piece, after: move.after, check: /[+#]$/.test(move.san), mate: move.san.endsWith("#") };
  // En passant is a capture of a pawn: chess.js says so in `captured`.
  if (move.captured) out.captured = move.captured as Taken;
  if (move.promotion) out.promotion = move.promotion as Ply["promotion"];
  if (move.isKingsideCastle()) out.castle = "k";
  else if (move.isQueensideCastle()) out.castle = "q";
  return out;
}

/** "1. e4 e5 2. Nf3": SAN with move numbers, from white's first move. */
export function numbered(sans: readonly string[]): string {
  const parts: string[] = [];
  sans.forEach((san, i) => {
    if (i % 2 === 0) parts.push(`${i / 2 + 1}.`);
    parts.push(san);
  });
  return parts.join(" ");
}

/** White's material minus black's, from the pieces on the board of a FEN (so a promotion counts by itself). */
export function materialOf(fen: string): number {
  let score = 0;
  for (const ch of fen.split(" ", 1)[0]) {
    const lower = ch.toLowerCase();
    if (!(lower in VALUES)) continue;
    const value = VALUES[lower as PieceType];
    score += ch === lower ? -value : value;
  }
  return score;
}

export interface GameHistory {
  readonly plies: readonly Ply[];
  readonly sans: readonly string[];
  /** fens[0] is the start, fens[i] the position after ply i. */
  readonly fens: readonly string[];
  /** The pieces each colour took up to ply `at` (all plies by default), in display order: w took black's pieces. */
  taken(at?: number): Record<Colour, Taken[]>;
  /** White's material minus black's after ply `at`. */
  material(at?: number): number;
}

export function historyOf(moves: readonly Move[], start: string = START_FEN): GameHistory {
  const plies = moves.map(plyOf);
  const sans = plies.map((p) => p.san);
  const fens = [start, ...plies.map((p) => p.after)];
  const clamp = (at: number | undefined) => Math.max(0, Math.min(plies.length, at ?? plies.length));
  return {
    plies,
    sans,
    fens,
    taken(at) {
      const out: Record<Colour, Taken[]> = { w: [], b: [] };
      const end = clamp(at);
      for (let i = 0; i < end; i++) {
        const ply = plies[i];
        if (ply.captured) out[ply.colour].push(ply.captured);
      }
      for (const c of ["w", "b"] as const) out[c].sort((a, b) => TAKEN_ORDER.indexOf(a) - TAKEN_ORDER.indexOf(b));
      return out;
    },
    material(at) {
      return materialOf(fens[clamp(at)]);
    },
  };
}
