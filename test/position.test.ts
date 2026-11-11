// covers: apps.chess
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { replay } from "../src/game.ts";
import { open, play, settle, startChat, type Side } from "./sides.ts";
import { MockBroker } from "./mockBroker.ts";

/** A Ruy Lopez to move 6: castling on both sides' first moves, a capture, check and an en passant later on. */
const OPENING = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5c6", "d7c6", "e1g1", "f7f6", "d2d4", "e5d4", "f3d4", "c6c5", "d4e2", "d8d1", "f1d1", "c8d7"];

/** One side alone, opened on a saved game of these plies. */
async function aloneOn(moves: string[]): Promise<Side> {
  const broker = new MockBroker("solo", "2.0.0", false);
  broker.stored.set("local", JSON.stringify({ v: 1, m: moves }));
  return open(broker);
}

/** What chess.js says of the same plies, in full. */
const fullHistory = (moves: string[]) => replay(moves)!.history({ verbose: true });

afterEach(() => vi.restoreAllMocks());

describe("each move costs its own ply, not the whole game", () => {
  it("a move alone reads only the new ply: chess.js's history() (a replay of every ply) does not run again", async () => {
    const solo = await aloneOn(OPENING);
    solo.game.record();
    const history = vi.spyOn(Chess.prototype, "history");
    await play({ white: solo }, "c2c4");
    const record = solo.game.record();
    expect(history).not.toHaveBeenCalled();
    const want = fullHistory([...OPENING, "c2c4"]);
    expect(record.sans).toEqual(want.map((m) => m.san));
    expect(record.fens).toEqual([want[0].before, ...want.map((m) => m.after)]);
    expect(solo.game.view().lastMove).toMatchObject({ from: "c2", to: "c4", san: "c4", colour: "w", piece: "p" });
  });

  it("in a chat, neither side replays the game for the contact's move nor for its own", async () => {
    const sides = await startChat();
    await play(sides, ...OPENING.slice(0, 4));
    for (const s of [sides.white, sides.black]) s.game.record();
    // Each side reads its view at every change, as the page does.
    for (const s of [sides.white, sides.black]) s.game.subscribe(() => s.game.record());
    const history = vi.spyOn(Chess.prototype, "history");
    await play(sides, ...OPENING.slice(4));
    expect(history).not.toHaveBeenCalled();
    for (const s of [sides.white, sides.black]) {
      expect(s.game.history()).toEqual(fullHistory(OPENING).map((m) => m.san));
      expect(s.game.view().lastMove).toMatchObject({ from: "c8", to: "d7", san: "Bd7" });
    }
  });

  it("castling, en passant and promotion come out as chess.js names them in full", async () => {
    // White castles, then a pawn takes en passant and another promotes with check.
    const moves = ["e2e4", "a7a6", "e4e5", "d7d5", "e5d6", "g8f6", "d6c7", "b8c6", "c7d8q", "e8d8", "g1f3", "a6a5", "f1e2", "a5a4", "e1g1"];
    const solo = await aloneOn([]);
    solo.game.record();
    const history = vi.spyOn(Chess.prototype, "history");
    await play({ white: solo }, ...moves);
    expect(history).not.toHaveBeenCalled();
    const want = fullHistory(moves);
    const record = solo.game.record();
    expect(record.sans).toEqual(want.map((m) => m.san));
    expect(record.plies.map((p) => [p.captured, p.promotion, p.castle, p.check])).toEqual(
      want.map((m) => [m.captured, m.promotion, m.isKingsideCastle() ? "k" : m.isQueensideCastle() ? "q" : undefined, /[+#]$/.test(m.san)]),
    );
  });

  it("a takeback and a new game still read the game afresh", async () => {
    const sides = await startChat();
    await play(sides, "e2e4", "e7e5", "g1f3");
    await sides.white.game.takeback();
    await settle(sides.white, sides.black);
    await sides.black.game.answerTakeback(true);
    await settle(sides.white, sides.black);
    for (const s of [sides.white, sides.black]) expect(s.game.history()).toEqual(["e4", "e5"]);
    await play(sides, "d2d4");
    for (const s of [sides.white, sides.black]) expect(s.game.history()).toEqual(["e4", "e5", "d4"]);
  });
});
