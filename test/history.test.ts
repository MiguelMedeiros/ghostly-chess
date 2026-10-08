// covers: apps.chess
// The move list's data: SAN with move numbers, the position after each ply, the pieces each side took and the
// material balance, all from chess.js's verbose history.
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { historyOf, materialOf, numbered, START_FEN } from "../src/history.ts";

/** The verbose history after these SAN moves. */
function movesOf(...sans: string[]) {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.history({ verbose: true });
}

describe("the move list", () => {
  it("numbers the moves: '1. e4 e5 2. Nf3'", () => {
    const h = historyOf(movesOf("e4", "e5", "Nf3"));
    expect(numbered(h.sans)).toBe("1. e4 e5 2. Nf3");
    expect(numbered([])).toBe("");
  });

  it("keeps the position after every ply, the start first", () => {
    const h = historyOf(movesOf("e4", "e5"));
    expect(h.fens).toHaveLength(3);
    expect(h.fens[0]).toBe(START_FEN);
    expect(h.fens[1]).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
    expect(h.plies[1]).toMatchObject({ san: "e5", colour: "b", from: "e7", to: "e5", piece: "p", check: false });
  });

  it("marks castling, check and mate on a ply", () => {
    const h = historyOf(movesOf("e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "O-O"));
    expect(h.plies[6].castle).toBe("k");
    const mate = historyOf(movesOf("f3", "e5", "g4", "Qh4#"));
    expect(mate.plies[3]).toMatchObject({ check: true, mate: true });
  });
});

describe("captured pieces and material", () => {
  it("counts en passant as a pawn", () => {
    const h = historyOf(movesOf("e4", "a6", "e5", "d5", "exd6"));
    expect(h.plies[4].captured).toBe("p");
    expect(h.taken()).toEqual({ w: ["p"], b: [] });
    expect(h.material()).toBe(1);
    // Before the capture, nothing was taken.
    expect(h.taken(4)).toEqual({ w: [], b: [] });
    expect(h.material(4)).toBe(0);
  });

  it("counts a promotion with capture by the pieces on the board", () => {
    // White's b-pawn takes its way to a8 and becomes a queen: it took a pawn and a rook, and the pawn is now worth 9.
    const h = historyOf(movesOf("b4", "a5", "bxa5", "h6", "a6", "h5", "axb7", "h4", "bxa8=Q"));
    expect(h.taken()).toEqual({ w: ["p", "p", "r"], b: [] });
    // White: one pawn fewer (it promoted), one queen more; black: two pawns and a rook fewer.
    expect(h.material()).toBe(-1 + 9 + 2 + 5);
    expect(h.plies[8]).toMatchObject({ promotion: "q", captured: "r", piece: "p" });
  });

  it("counts an underpromotion as the piece it became", () => {
    const h = historyOf(movesOf("b4", "a5", "bxa5", "h6", "a6", "h5", "axb7", "h4", "bxa8=N"));
    expect(h.plies[8].promotion).toBe("n");
    expect(h.material()).toBe(-1 + 3 + 2 + 5);
    // The captured pieces are shown in order: pawns, then the pieces.
    expect(h.taken().w).toEqual(["p", "p", "r"]);
  });

  it("reads a position's balance from its FEN", () => {
    expect(materialOf(START_FEN)).toBe(0);
    expect(materialOf("4k3/8/8/8/8/8/8/3QK3 w - - 0 1")).toBe(9);
    expect(materialOf("4k3/8/8/8/8/8/8/rn2K3 w - - 0 1")).toBe(-8);
  });
});
