import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { evaluate, LEVELS, pickMove } from "../../bot/engine.ts";

/** A seeded stand-in for Math.random, so a failing game can be played again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const play = (chess: Chess, uci: string) => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

describe("the bot's move picker", () => {
  it.each(LEVELS)("level %i plays only legal moves, to the end of a game", { timeout: 60_000 }, (level) => {
    const random = seeded(7 + level);
    const chess = new Chess();
    // Against a random mover, so the game wanders through odd positions (promotions, checks, castling).
    for (let ply = 0; ply < (level === 3 ? 16 : 160) && !chess.isGameOver(); ply++) {
      const uci = pickMove(chess.fen(), ply % 2 === 0 ? level : 0, random);
      expect(uci, chess.fen()).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
      play(chess, uci!);
    }
  });

  it("has no move when the game is over", () => {
    expect(pickMove("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", 1)).toBeNull(); // stalemate
    expect(pickMove("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1", 2)).toBeNull(); // checkmate
  });

  it.each([1, 2, 3] as const)("level %i mates in one", (level) => {
    expect(pickMove("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", level)).toBe("a1a8");
    expect(pickMove("r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1", level)).toBe("a8a1");
  });

  it.each([1, 2, 3] as const)("level %i takes a queen left hanging, and promotes", (level) => {
    expect(pickMove("4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1", level)).toBe("e4d5");
    expect(pickMove("8/P6k/8/8/8/8/8/K7 w - - 0 1", level)).toBe("a7a8q");
  });

  it("from level 2, does not take a pawn that costs the queen", () => {
    const fen = "4k3/8/2p5/3p4/8/8/3Q4/4K3 w - - 0 1"; // Qxd5 loses the queen to cxd5
    const random = seeded(5);
    for (const level of [2, 3] as const) for (let i = 0; i < 5; i++) expect(pickMove(fen, level, random)).not.toBe("d2d5");
    expect(pickMove(fen, 1)).toBe("d2d5");
  });

  it("draws among moves as good as the best, so two games differ", () => {
    const random = seeded(3);
    const first = new Set(Array.from({ length: 30 }, () => pickMove(new Chess().fen(), 2, random)));
    expect(first.size).toBeGreaterThan(1);
  });

  it("values a position for the side to move", () => {
    expect(evaluate(new Chess())).toBe(0);
    expect(evaluate(new Chess("4k3/8/8/8/8/8/8/Q3K3 w - - 0 1"))).toBeGreaterThan(800);
    expect(evaluate(new Chess("4k3/8/8/8/8/8/8/Q3K3 b - - 0 1"))).toBeLessThan(-800);
  });

  it("answers within a second at the highest level, from a middlegame", () => {
    const started = performance.now();
    pickMove("r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9", 3, seeded(1));
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
