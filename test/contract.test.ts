// @vitest-environment happy-dom
// covers: apps.chess
// The DOM that Ghostly's end-to-end tests read (e2e/web/apps-chess.spec.ts, e2e/support/chessApp.ts), with each piece
// set: the squares' text and classes, and the .status and .side lines word for word as Chess 1.0.2 shows them.
import { afterEach, describe, expect, it } from "vitest";
import { PIECE_SETS } from "../src/pieces.ts";
import { MockBroker, chatPair } from "./mockBroker.ts";
import { agree, mount, open, play, settle, sq, startAlone, startChat } from "./sides.ts";

afterEach(() => document.body.replaceChildren());

const text = (root: HTMLElement, selector: string) => root.querySelector(selector)!.textContent;

describe.each(PIECE_SETS)("the end-to-end contract with the %s pieces", (set) => {
  it("after 1.e4: e2 is empty and last, e4 reads ♟ and is w and last", async () => {
    const { white, black } = await startChat();
    await white.prefs.set({ pieces: set });
    await black.prefs.set({ pieces: set });
    const roots = [mount(white), mount(black)];
    await play({ white, black }, "e2e4");
    for (const root of roots) {
      expect(sq(root, "e2").textContent).toBe("");
      expect(sq(root, "e2").classList.contains("last")).toBe(true);
      expect(sq(root, "e2").dataset.piece).toBe("");
      expect(sq(root, "e4").textContent).toMatch(/♟/);
      expect(sq(root, "e4").classList.contains("w")).toBe(true);
      expect(sq(root, "e4").classList.contains("last")).toBe(true);
      expect(sq(root, "e4").dataset.piece).toBe("wp");
      expect(sq(root, "e4").tagName).toBe("BUTTON");
      expect(sq(root, "e7").classList.contains("b")).toBe(true);
      expect(sq(root, "d8").textContent).toMatch(/♛/);
    }
  });

  it.each([
    ["with Chess 1.0.2 (version 1)", "1.0.2"],
    ["with protocol 2", "2.0.0"],
  ])("shows .status and .side exactly as 1.0.2 does, %s", async (_, version) => {
    // [state, .status, .side], as Chess 1.0.2 wrote them.
    const table: [string, string, string][] = [];
    const [a, b] = chatPair(version);
    const ana = await open(a);
    await ana.prefs.set({ pieces: set });
    const anaRoot = mount(ana);
    table.push(["waiting", text(anaRoot, ".status")!, text(anaRoot, ".side")!]);
    const bob = await open(b);
    await bob.prefs.set({ pieces: set });
    await settle(ana, bob);
    if (version !== "1.0.2") await agree(ana, bob);
    const white = ana.game.view().me === "w" ? ana : bob;
    const black = white === ana ? bob : ana;
    const whiteRoot = white === ana ? anaRoot : mount(bob);
    let blackRoot = black === ana ? anaRoot : mount(bob);
    table.push(["white to move, white", text(whiteRoot, ".status")!, text(whiteRoot, ".side")!]);
    table.push(["white to move, black", text(blackRoot, ".status")!, text(blackRoot, ".side")!]);
    await play({ white, black }, "e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6");
    black.broker.shutdown();
    await settle(white);
    // White may still move: .status keeps 1.0.2's words, and the hint is a line of its own.
    expect(white.game.view().canMove).toBe(true);
    table.push(["contact away", text(whiteRoot, ".status")!, text(whiteRoot, ".side")!]);
    expect(text(whiteRoot, ".standing-text")).toBe("You can still make your move. It goes when they are back.");
    expect(whiteRoot.querySelector<HTMLElement>(".standing")!.hidden).toBe(false);
    // The contact opens Chess again: a new page on the same storage.
    blackRoot.remove();
    const back = await open(black.broker);
    blackRoot = mount(back);
    await settle(white, back);
    await play({ white, black: back }, "h5f7");
    table.push(["mate, winner", text(whiteRoot, ".status")!, text(whiteRoot, ".side")!]);
    table.push(["mate, loser", text(blackRoot, ".status")!, text(blackRoot, ".side")!]);
    expect(table).toEqual([
      ["waiting", "Waiting for your contact to open Chess", ""],
      ["white to move, white", "Your move", "You play white"],
      ["white to move, black", "Their move", "You play black"],
      ["contact away", "Your contact closed Chess. The game waits here.", "You play white"],
      ["mate, winner", "You win: checkmate", "You play white"],
      ["mate, loser", "You lose: checkmate", "You play black"],
    ]);
    // .status and .side are lone text nodes.
    for (const root of [whiteRoot, blackRoot] as HTMLElement[]) {
      expect(root.querySelector(".status")!.children).toHaveLength(0);
      expect(root.querySelector(".side")!.children).toHaveLength(0);
      expect(root.querySelectorAll(".status")).toHaveLength(1);
    }
  });

  it("shows 'White to move' opened alone, and 'Your move. Check' in check", async () => {
    const solo = await startAlone();
    await solo.prefs.set({ pieces: set });
    const root = mount(solo);
    expect(text(root, ".status")).toBe("White to move");
    expect(text(root, ".side")).toBe("");
    await play({ white: solo }, "e2e4", "f7f6", "d1h5");
    expect(text(root, ".status")).toBe("Black to move. Check");
    const { white, black } = await startChat();
    const r = mount(black);
    await play({ white, black }, "e2e4", "f7f6", "d1h5");
    expect(text(r, ".status")).toBe("Your move. Check");
    void MockBroker;
  });
});
