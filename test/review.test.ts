// covers: apps.chess
// The review cursor: it moves over the live game, the board reads the position under it, no move is made while it
// is off the live position, and the contact's moves still arrive.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAY_STEP_MS, Review } from "../src/review.ts";
import { play, settle, startAlone, startChat } from "./sides.ts";

afterEach(() => vi.useRealTimers());

describe("the review cursor", () => {
  it("moves with first, prev, next, go and live, and reads the position under it", async () => {
    const sides = await startChat();
    await play(sides, "e2e4", "e7e5", "g1f3", "b8c6");
    const review = new Review(sides.white.game);
    expect(review.reviewing()).toBe(false);
    expect(review.view()).toEqual(sides.white.game.view());

    review.prev();
    expect(review.ply()).toBe(3);
    expect(review.reviewing()).toBe(true);
    const at3 = review.view();
    expect(at3).toMatchObject({ plies: 3, turn: "b", canMove: false, inCheck: false });
    expect(at3.lastMove).toMatchObject({ from: "g1", to: "f3", san: "Nf3", colour: "w", piece: "n" });
    expect(review.board()[5][5]).toMatchObject({ type: "n", color: "w" }); // f3
    expect(review.board()[2][2]).toBeNull(); // c6 is empty at ply 3

    review.first();
    expect(review.view()).toMatchObject({ plies: 0, turn: "w", lastMove: undefined });
    review.next();
    expect(review.ply()).toBe(1);
    review.go(2);
    expect(review.ply()).toBe(2);
    // The last ply is the live game.
    review.go(4);
    expect(review.reviewing()).toBe(false);
    review.go(1);
    review.live();
    expect(review.reviewing()).toBe(false);
    expect(review.view().plies).toBe(4);
    // Next at the live position stays there; go clamps.
    review.next();
    expect(review.reviewing()).toBe(false);
    review.go(-5);
    expect(review.ply()).toBe(0);
    review.stop();
  });

  it("makes no move and shows no targets while reviewing", async () => {
    const sides = await startChat();
    await play(sides, "e2e4", "e7e5");
    const review = new Review(sides.white.game);
    expect(review.targets("g1").length).toBeGreaterThan(0);
    review.prev();
    expect(review.view().canMove).toBe(false);
    expect(review.targets("g1")).toEqual([]);
    expect(await review.move("g1", "f3")).toBe(false);
    expect(sides.white.game.view().plies).toBe(2);
    // The game itself is still on and still this side's turn.
    expect(sides.white.game.view()).toMatchObject({ phase: "playing", canMove: true });
    review.live();
    expect(await review.move("g1", "f3")).toBe(true);
    review.stop();
  });

  it("keeps the board at the cursor while the contact's move lands in the game", async () => {
    const sides = await startChat();
    await play(sides, "e2e4", "e7e5", "g1f3");
    const review = new Review(sides.black.game);
    review.go(1);
    await play(sides, "b8c6");
    await settle(sides.white, sides.black);
    expect(sides.black.game.history()).toEqual(["e4", "e5", "Nf3", "Nc6"]);
    expect(review.ply()).toBe(1);
    expect(review.view().plies).toBe(1);
    review.live();
    expect(review.view().plies).toBe(4);
    review.stop();
  });

  it("goes live when a new game starts under the cursor", async () => {
    const solo = await startAlone();
    for (const uci of ["e2e4", "e7e5", "d2d4"]) await solo.game.move(uci.slice(0, 2) as never, uci.slice(2, 4) as never);
    const review = new Review(solo.game);
    review.go(1);
    await solo.game.newGame();
    expect(review.reviewing()).toBe(false);
    expect(review.view().plies).toBe(0);
    review.stop();
  });

  it("plays the game through a ply a second, from the start when live, and stops at the live position", async () => {
    const solo = await startAlone();
    for (const uci of ["e2e4", "e7e5", "d2d4"]) await solo.game.move(uci.slice(0, 2) as never, uci.slice(2, 4) as never);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const review = new Review(solo.game);
    review.play();
    expect(review.playing()).toBe(true);
    expect(review.ply()).toBe(0);
    vi.advanceTimersByTime(PLAY_STEP_MS);
    expect(review.ply()).toBe(1);
    // Play again pauses.
    review.play();
    expect(review.playing()).toBe(false);
    vi.advanceTimersByTime(5 * PLAY_STEP_MS);
    expect(review.ply()).toBe(1);
    review.play();
    vi.advanceTimersByTime(5 * PLAY_STEP_MS);
    expect(review.reviewing()).toBe(false);
    expect(review.playing()).toBe(false);
    // A manual step pauses it.
    review.play();
    review.next();
    expect(review.playing()).toBe(false);
    review.stop();
  });
});
