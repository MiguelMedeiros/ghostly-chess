// @vitest-environment happy-dom
// covers: apps.chess
// The review and the board as a screen reader meets them: each step of the review is said, and its end; the board's
// name says it shows a past position; Enter on the reviewed board says why it takes no move; a king in check says so
// in its square's name, not only by its red glow.
import { afterEach, describe, expect, it } from "vitest";
import { mount as mountSide, play, settle, sq, startAlone, startChat, tick, type Side } from "./sides.ts";

const mounted: Side[] = [];
const mount = (side: Side) => {
  mounted.push(side);
  return mountSide(side);
};

afterEach(() => {
  for (const side of mounted.splice(0)) side.unmount?.();
  document.body.replaceChildren();
});

const keyOn = (target: EventTarget, key: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const live = (root: HTMLElement) => root.querySelector("[aria-live]")!.textContent!.trim();
const boardName = (root: HTMLElement) => root.querySelector(".board")!.getAttribute("aria-label");
const nav = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`.nav-${name}`)!;

async function alone(...plies: string[]): Promise<HTMLElement> {
  const solo = await startAlone();
  const root = mount(solo);
  await play({ white: solo }, ...plies);
  return root;
}

describe("a review step", () => {
  it("says the position it shows, once per step, and Back to the game when it ends", async () => {
    const root = await alone("e2e4", "e7e5", "g1f3", "b8c6");
    expect(live(root)).toBe("Black: knight to c6");
    nav(root, "prev").focus();
    nav(root, "prev").click();
    expect(live(root)).toBe("Reviewing move 3 of 4, White: knight to f3");
    await tick();
    nav(root, "prev").click();
    expect(live(root)).toBe("Reviewing move 2 of 4, Black: pawn to e5");
    await tick();
    // The document's arrow keys, from outside the board and the move list.
    keyOn(document.body, "ArrowLeft");
    expect(live(root)).toBe("Reviewing move 1 of 4, White: pawn to e4");
    await tick();
    nav(root, "first").click();
    expect(live(root)).toBe("Reviewing the starting position");
    await tick();
    keyOn(document.body, "PageDown");
    expect(live(root)).toBe("Reviewing move 1 of 4, White: pawn to e4");
    await tick();
    nav(root, "last").click();
    expect(live(root)).toBe("Back to the game");
  });

  it("is not said again when nothing moved, nor when focus is in the move list (the move focused there reads itself)", async () => {
    const root = await alone("e2e4", "e7e5", "g1f3");
    nav(root, "prev").click();
    expect(live(root)).toBe("Reviewing move 2 of 3, Black: pawn to e5");
    const region = root.querySelector("[aria-live]")!;
    region.textContent = "";
    // A redraw with the review where it was (a setting changed) says nothing.
    nav(root, "next").focus();
    root.querySelector<HTMLButtonElement>(".flip")!.click();
    expect(region.textContent).toBe("");
    const current = root.querySelector<HTMLButtonElement>('.moves [aria-current="step"]')!;
    current.focus();
    keyOn(current, "ArrowLeft");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("1. e4, White: pawn to e4");
    expect(region.textContent).toBe("");
  });
});

describe("the board while reviewing", () => {
  it("is named by the position it shows, and Chessboard again when live", async () => {
    const root = await alone("e2e4", "e7e5", "g1f3", "b8c6");
    expect(boardName(root)).toBe("Chessboard");
    nav(root, "prev").click();
    expect(boardName(root)).toBe("Chessboard, reviewing move 3 of 4");
    nav(root, "first").click();
    expect(boardName(root)).toBe("Chessboard, reviewing the starting position");
    nav(root, "last").click();
    expect(boardName(root)).toBe("Chessboard");
  });

  it("counts the contact's moves that land during the review", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    await play({ white, black }, "e2e4", "e7e5");
    nav(root, "prev").click();
    expect(boardName(root)).toBe("Chessboard, reviewing move 1 of 2");
    await play({ white, black }, "g1f3", "b8c6");
    expect(boardName(root)).toBe("Chessboard, reviewing move 1 of 4");
  });

  it("says why Enter on a square takes no move, and stays where the review is", async () => {
    const root = await alone("e2e4", "e7e5", "g1f3", "b8c6");
    nav(root, "prev").click();
    nav(root, "prev").click();
    await tick();
    const g1 = sq(root, "g1");
    g1.focus();
    keyOn(g1, "Enter");
    expect(live(root)).toBe("Reviewing move 2 of 4: no move here. Press Back to live to play");
    expect(root.querySelector(".selected")).toBeNull();
    expect(root.querySelector(".board-wrap")!.classList.contains("reviewing")).toBe(true);
    expect(g1.getAttribute("aria-label")).toBe("g1, white knight");
  });

  it("says nothing on Enter when it is simply the contact's turn (no review)", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    await white.prefs.set({ premove: false });
    await play({ white, black }, "e2e4");
    const region = root.querySelector("[aria-live]")!;
    region.textContent = "";
    keyOn(sq(root, "d2"), "Enter");
    await settle(white, black);
    expect(region.textContent).toBe("");
  });
});

describe("a king in check", () => {
  it("has 'in check' in its square's name, live and in review, and loses it when the check is gone", async () => {
    const root = await alone("e2e4", "f7f6", "d1h5");
    expect(sq(root, "e8").getAttribute("aria-label")).toBe("e8, black king, in check");
    expect(sq(root, "e1").getAttribute("aria-label")).toBe("e1, white king");
    const solo = mounted[0];
    await play({ white: solo }, "g7g6");
    expect(sq(root, "e8").getAttribute("aria-label")).toBe("e8, black king");
    nav(root, "prev").click();
    expect(sq(root, "e8").getAttribute("aria-label")).toBe("e8, black king, in check");
  });
});
