// covers: apps.chess
// Premoves (src/premove.ts): one move queued on the contact's turn, played through the controller as soon as the
// contact's move arrives, if it is legal then; otherwise dropped, with nothing sent.
import type { Square } from "chess.js";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { Premove, premoveTargets } from "../src/premove.ts";
import { play, settle, startChat, type Side } from "./sides.ts";
import { play as playTimed, record, timedGame } from "./link.ts";

const moves = (side: { broker: { sent: unknown[] } }) => side.broker.sent.filter((f) => (f as { k?: string }).k === "move") as { n: number; m: string; t?: number }[];
const targets = (fen: string, from: string) => premoveTargets(new Chess(fen).board(), from as Square).sort();

describe("premove targets", () => {
  it("are the piece's moves on an empty board, whatever stands there now", () => {
    const start = new Chess().fen();
    expect(targets(start, "g1")).toEqual(["e2", "f3", "h3"]);
    expect(targets(start, "e2")).toEqual(["d3", "e3", "e4", "f3"]);
    expect(targets(start, "e7")).toEqual(["d6", "e5", "e6", "f6"]);
    // The king's squares around it and its castling squares; the queen through its own pieces.
    expect(targets(start, "e1")).toEqual(["c1", "d1", "d2", "e2", "f1", "f2", "g1"]);
    expect(targets(start, "d1")).toHaveLength(21);
    expect(targets(start, "a1")).toHaveLength(14);
    expect(targets(start, "c1")).toEqual(["a3", "b2", "d2", "e3", "f4", "g5", "h6"]);
    expect(targets(start, "e4")).toEqual([]);
  });
});

/** A chat game with these plies, and a premove queue for each side (on unless `off` says otherwise). */
async function game(...plies: string[]): Promise<{ white: Side; black: Side; pw: Premove; pb: Premove; on: { value: boolean } }> {
  const sides = await startChat();
  await play(sides, ...plies);
  const on = { value: true };
  return { white: sides.white, black: sides.black, pw: new Premove(sides.white.game, () => on.value), pb: new Premove(sides.black.game, () => on.value), on };
}

describe("a premove", () => {
  it("is queued only on the contact's turn, for this side's own pieces", async () => {
    const { pw, pb } = await game("e2e4");
    // White just moved: on Black's turn White may premove its own pieces, and only them.
    expect(pw.targets("d2").sort()).toEqual(["c3", "d3", "d4", "e3"]);
    expect(pw.targets("d7")).toEqual([]);
    expect(pb.targets("d7")).toEqual([]); // Black's own turn: a move, not a premove
    expect(pw.set("e7", "e5")).toBe(false);
    expect(pw.set("g1", "f3")).toBe(true);
    expect(pw.get()).toEqual({ from: "g1", to: "f3" });
  });

  it("plays on arrival when legal", async () => {
    const { white, black, pw } = await game("e2e4");
    expect(pw.set("g1", "f3")).toBe(true);
    const before = moves(white).length;
    expect(await black.game.move("e7", "e5")).toBe(true);
    await settle(white, black);
    expect(moves(white).slice(before)).toEqual([expect.objectContaining({ n: 2, m: "g1f3" })]);
    expect(black.game.view().plies).toBe(3);
    expect(pw.get()).toBeNull();
  });

  it("is dropped with no frame sent when it is illegal on arrival", async () => {
    const { white, black, pw } = await game("e2e4", "e7e5", "g1f3");
    // The queen through its own knight on f3: a target on an empty board, never legal here.
    expect(pw.set("d1", "h5")).toBe(true);
    const before = white.broker.sent.length;
    expect(await black.game.move("b8", "c6")).toBe(true);
    await settle(white, black);
    expect(white.broker.sent.slice(before).filter((f) => (f as { k: string }).k !== "ack")).toEqual([]);
    expect(pw.get()).toBeNull();
    expect(white.game.view().canMove).toBe(true);
    expect(white.notices).toEqual([]);
  });

  it("to the last rank sends a queen promotion", async () => {
    const { white, black, pw } = await game("h2h4", "g7g5", "h4g5", "h7h6", "g5h6", "g8f6", "h6h7");
    expect(pw.set("h7", "g8")).toBe(true);
    expect(await black.game.move("f6", "g8")).toBe(true);
    await settle(white, black);
    expect(moves(white).at(-1)).toMatchObject({ n: 8, m: "h7g8q" });
    expect(black.game.view().fen.split(" ")[0]).toBe(white.game.view().fen.split(" ")[0]);
    expect(white.game.board()[0][6]).toMatchObject({ type: "q", color: "w" });
  });

  it("is dropped by a takeback, and not played with the setting off", async () => {
    const { white, black, pw, on } = await game("e2e4", "e7e5", "g1f3");
    expect(pw.set("f1", "c4")).toBe(true);
    await white.game.takeback();
    await settle(white, black);
    await black.game.answerTakeback(true);
    await settle(white, black);
    expect(pw.get()).toBeNull();
    expect(white.game.view().plies).toBe(2);
    await play({ white, black }, "g1f3");
    expect(pw.set("f1", "c4")).toBe(true);
    on.value = false;
    const before = moves(white).length;
    expect(await black.game.move("b8", "c6")).toBe(true);
    await settle(white, black);
    expect(moves(white).length).toBe(before);
    expect(pw.get()).toBeNull();
  });
});

describe("a premove in a timed game", () => {
  it("is charged normally: its t is the time before it plus the increment, less the moment it waited", async () => {
    const { link, white, black } = await timedGame([180, 2]);
    await playTimed(link, white, "e2e4");
    await playTimed(link, black, "e7e5");
    await link.advance(4_000);
    await playTimed(link, white, "g1f3");
    const pw = new Premove(white.game, () => true);
    expect(pw.set("f1", "c4")).toBe(true);
    await link.advance(6_000);
    await playTimed(link, black, "b8c6");
    const sent = white.broker.kinds("move").at(-1)!;
    expect(sent).toMatchObject({ n: 4, m: "f1c4" });
    const k = record(white).k!;
    // White's time before it was k[2]; it spent next to nothing, and got the increment.
    expect(sent.t).toBe(k[4]);
    expect(k[2] + 2_000 - (sent.t as number)).toBeGreaterThanOrEqual(0);
    expect(k[2] + 2_000 - (sent.t as number)).toBeLessThanOrEqual(20);
    expect(record(black).m.at(-1)).toBe("f1c4");
    expect(Math.abs(record(black).k![4] - k[4])).toBeLessThanOrEqual(20);
    expect(white.notices).toEqual([]);
    expect(black.notices).toEqual([]);
  });
});
