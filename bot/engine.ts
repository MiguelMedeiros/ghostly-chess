/**
 * The bot's move picker: a small search over chess.js, enough to play legal, sensible chess. Strength is not the
 * point. Levels: 0 plays any legal move; 1 looks one ply ahead (takes what hangs, mates in one); 2 and 3 search two
 * and three plies with alpha-beta. Among moves as good as the best one is drawn at random, so two games differ.
 */
import { Chess, type Move } from "chess.js";

export const LEVELS = [0, 1, 2, 3] as const;
export type Level = (typeof LEVELS)[number];

const VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100_000;
/** Moves this close to the best one (centipawns) are as good: one is drawn among them, so two games differ. */
const NEAR = 10;
/** A mate a ply sooner is worth more than `NEAR`, so the quickest one is played. */
const MATE_PLY = 100;

/** A piece nearer the centre is worth a little more: enough to develop and to push central pawns. */
function placed(type: string, file: number, rank: number): number {
  if (type === "k" || type === "r" || type === "q") return 0;
  const centre = 3 - Math.max(Math.abs(file - 3.5), Math.abs(rank - 3.5)) + 0.5;
  return Math.round(centre * (type === "p" ? 6 : 10));
}

/** The position's worth for the side to move, in centipawns: material and placement. */
export function evaluate(chess: Chess): number {
  let score = 0;
  const board = chess.board();
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = board[rank]![file];
      if (!piece) continue;
      const worth = VALUE[piece.type]! + placed(piece.type, file, rank);
      score += piece.color === chess.turn() ? worth : -worth;
    }
  }
  return score;
}

/** Captures first, the richest victim first: alpha-beta cuts sooner. */
function ordered(moves: Move[]): Move[] {
  const worth = (m: Move) => (m.captured ? VALUE[m.captured]! * 10 - VALUE[m.piece]! : 0) + (m.promotion ? VALUE[m.promotion]! : 0);
  return moves.sort((a, b) => worth(b) - worth(a));
}

/** Negamax with alpha-beta. The moves are made once per node: chess.js is slow at it, and a mate or a stalemate is having none. */
function search(chess: Chess, depth: number, alpha: number, beta: number, ply: number): number {
  if (depth === 0) return chess.inCheck() && chess.isCheckmate() ? -MATE + ply * MATE_PLY : evaluate(chess);
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return chess.inCheck() ? -MATE + ply * MATE_PLY : 0;
  if (chess.isInsufficientMaterial()) return 0;
  let best = -Infinity;
  for (const move of ordered(moves)) {
    chess.move(move);
    const score = -search(chess, depth - 1, -beta, -alpha, ply + 1);
    chess.undo();
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

export const uciOf = (move: Pick<Move, "from" | "to" | "promotion">): string => `${move.from}${move.to}${move.promotion ?? ""}`;

/**
 * A legal move for the side to move in `fen`, in UCI (`e2e4`, `e7e8q`), or null when it has none (the game is over).
 * `random` is 0 to 1, as Math.random.
 */
export function pickMove(fen: string, level: Level, random: () => number = Math.random): string | null {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const any = (among: Move[]) => uciOf(among[Math.min(among.length - 1, Math.floor(random() * among.length))]!);
  if (level === 0) return any(moves);
  // Each move's worth: what the search finds, and a little of what the board shows at once, so a gain is taken now
  // and not a move later (a pawn that can promote does).
  const scored: { move: Move; score: number }[] = [];
  let best = -Infinity;
  for (const move of ordered(moves)) {
    chess.move(move);
    const now = -evaluate(chess);
    // A window under the best so far: any move within the margin still scores exactly, to be drawn among.
    const found = -search(chess, level - 1, -Infinity, -(best - NEAR - 1), 1);
    chess.undo();
    const score = found + Math.round(now / 50);
    scored.push({ move, score });
    if (score > best) best = score;
  }
  return any(scored.filter((s) => s.score >= best - NEAR).map((s) => s.move));
}
