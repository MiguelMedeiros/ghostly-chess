// @vitest-environment happy-dom
// covers: apps.chess
// The board on screen: a chessboard is never mirrored, whatever the language's direction.
import { afterEach, describe, expect, it } from "vitest";
import { ChessController } from "../src/game.ts";
import { en } from "../src/strings.ts";
import { mountChess } from "../src/ui.ts";
import { MockBroker } from "./mockBroker.ts";
import { mount, play, settle, sq, startChat } from "./sides.ts";

afterEach(() => {
  document.documentElement.removeAttribute("dir");
  document.body.replaceChildren();
});

async function mounted(): Promise<HTMLElement> {
  const broker = new MockBroker("ana", "1.0.0", false);
  broker.launch();
  const game = new ChessController(broker);
  await game.start();
  const root = document.createElement("div");
  document.body.append(root);
  mountChess(root, game, en);
  return root;
}

describe("the board", () => {
  it("keeps a1 at white's bottom left in a right-to-left language (Arabic)", async () => {
    // main.ts sets the page's direction from the language, and a grid lays its columns out in that direction: the
    // board came out mirrored, a1 on the right.
    document.documentElement.dir = "rtl";
    const root = await mounted();
    const board = root.querySelector<HTMLElement>(".board")!;
    // The direction an element takes is its nearest `dir`: the board's own, not the page's.
    expect(board.closest("[dir]")?.getAttribute("dir")).toBe("ltr");
    // The first square drawn in the bottom row is a1, and it is a dark square.
    const bottom = board.querySelectorAll(".rank")[7]!.querySelectorAll<HTMLElement>(".sq");
    expect(bottom[0]!.dataset.square).toBe("a1");
    expect(bottom[0]!.classList.contains("dark")).toBe(true);
  });

  it("stays left to right in a left-to-right language", async () => {
    const root = await mounted();
    expect(root.querySelector<HTMLElement>(".board")!.closest("[dir]")?.getAttribute("dir")).toBe("ltr");
  });
});

// ---------- game flow: resign, abort, takeback, draw offers, rematch, premoves ----------

const key = (target: Element, k: string, shiftKey = false) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("resign", () => {
  it("asks in a dialog that traps focus, and Escape cancels it", async () => {
    const sides = await startChat();
    await play(sides, "e2e4", "e7e5");
    const root = mount(sides.white);
    const resign = root.querySelector<HTMLButtonElement>(".actions .resign-btn")!;
    expect(resign.textContent).toBe("Resign");
    resign.focus();
    resign.click();
    await flush();
    const dialog = document.querySelector<HTMLElement>(".resign-dialog")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("Resign this game?");
    const items = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    expect(items.map((b) => b.textContent)).toEqual(["×", "Cancel", "Resign"]);
    // Focus starts on Cancel, and Tab and Shift+Tab wrap inside the dialog.
    expect(document.activeElement).toBe(items[1]);
    items[2].focus();
    key(dialog, "Tab");
    expect(document.activeElement).toBe(items[0]);
    key(dialog, "Tab", true);
    expect(document.activeElement).toBe(items[2]);
    // Escape cancels: the game goes on, and focus is back on Resign.
    key(dialog, "Escape");
    expect(document.querySelector(".resign-dialog")).toBeNull();
    expect(document.activeElement).toBe(resign);
    await settle(sides.white, sides.black);
    expect(sides.white.game.view().phase).toBe("playing");
    // Confirmed, it resigns.
    resign.click();
    await flush();
    document.querySelector<HTMLButtonElement>(".resign-dialog .resign-confirm")!.click();
    await settle(sides.white, sides.black);
    expect(sides.black.game.view().end).toEqual({ result: "0-1", why: "resign" });
  });

  it("is Abort before ply 2, which ends the game with no result at once", async () => {
    const sides = await startChat();
    const root = mount(sides.black);
    expect(root.querySelector(".actions .resign-btn")).toBeNull();
    await play(sides, "e2e4");
    const abort = root.querySelector<HTMLButtonElement>(".actions .abort-btn")!;
    expect(abort.textContent).toBe("Abort");
    abort.click();
    await settle(sides.white, sides.black);
    expect(root.querySelector(".over-head")!.textContent).toBe("No result");
    expect(root.querySelector(".over-reason")!.textContent).toBe("Aborted");
  });

  it("stays Resign before ply 2 with Chess 1.0.2", async () => {
    const sides = await startChat("1.0.2");
    const root = mount(sides.white);
    expect(root.querySelector(".actions .abort-btn")).toBeNull();
    expect(root.querySelector(".actions .resign-btn")).not.toBeNull();
  });
});

describe("takeback on the page", () => {
  it("asks with the ↶ button, the contact answers on a card, and both boards go back", async () => {
    const sides = await startChat();
    const w = mount(sides.white);
    const b = mount(sides.black);
    const back = w.querySelector<HTMLButtonElement>(".actions .takeback-btn")!;
    expect(back.disabled).toBe(true); // nothing to take back yet
    await play(sides, "e2e4");
    const again = w.querySelector<HTMLButtonElement>(".actions .takeback-btn")!;
    expect(again.disabled).toBe(false);
    expect(again.getAttribute("aria-label")).toBe("Take back");
    again.click();
    await settle(sides.white, sides.black);
    const asked = w.querySelector<HTMLButtonElement>(".actions .takeback-btn")!;
    expect(asked.disabled).toBe(true);
    expect(asked.getAttribute("aria-label")).toBe("Takeback asked");
    // While the ask waits, the asker's status says so, and Abort waits too (it could cross the accept).
    expect(w.querySelector(".status")!.textContent).toBe("Takeback asked");
    expect(w.querySelector<HTMLButtonElement>(".actions .abort-btn")!.disabled).toBe(true);
    const card = b.querySelector<HTMLElement>(".offer-card")!;
    expect(card.hidden).toBe(false);
    expect(card.querySelector(".offer")!.textContent).toBe("Your contact asks to take back a move");
    // The card's group is named by what it answers, and the ask is read aloud.
    expect(card.getAttribute("aria-label")).toBe("Your contact asks to take back a move");
    expect(b.querySelector(".announce")!.textContent!.trim()).toBe("Your contact asks to take back a move");
    card.querySelector<HTMLButtonElement>(".primary")!.click();
    await settle(sides.white, sides.black);
    expect(card.hidden).toBe(true);
    for (const root of [w, b]) {
      expect(sq(root, "e2").dataset.piece).toBe("wp");
      expect(sq(root, "e4").dataset.piece).toBe("");
      expect(root.querySelector(".notice.info")!.textContent).toBe("Move taken back");
    }
  });

  it("is off with the update hint for a contact on Chess 1.0.2", async () => {
    const sides = await startChat("1.0.2");
    await play(sides, "e2e4");
    const root = mount(sides.white);
    const back = root.querySelector<HTMLButtonElement>(".actions .takeback-btn")!;
    expect(back.disabled).toBe(true);
    expect(back.title).toBe("Your contact needs to update Chess (they have 1.0.2)");
  });
});

describe("draw offers on the page", () => {
  it("show ½ after the offerer's move while the offer stands", async () => {
    const sides = await startChat();
    await play(sides, "e2e4", "e7e5");
    const w = mount(sides.white);
    const b = mount(sides.black);
    await sides.white.game.offerDraw();
    await settle(sides.white, sides.black);
    // White offered on its own turn: the ½ shows at its next move.
    expect(w.querySelector(".san.draw")).toBeNull();
    await play(sides, "g1f3");
    for (const root of [w, b]) expect([...root.querySelectorAll(".san.draw")].map((s) => s.textContent)).toEqual(["Nf3"]);
    expect(w.querySelector<HTMLButtonElement>(".actions .draw-btn")!.disabled).toBe(true);
    // Black moves instead of answering: the offer lapses, and the ½ goes.
    await play(sides, "b8c6");
    for (const root of [w, b]) expect(root.querySelector(".san.draw")).toBeNull();
  });
});

describe("rematch on the page", () => {
  it("is on the game-over card; the contact sees 'Rematch? (Unlimited)'", async () => {
    const sides = await startChat();
    await play(sides, "e2e4", "e7e5");
    const w = mount(sides.white);
    const b = mount(sides.black);
    await sides.white.game.resign();
    await settle(sides.white, sides.black);
    const button = w.querySelector<HTMLButtonElement>(".over .over-rematch")!;
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.classList.contains("primary")).toBe(true);
    expect(w.querySelector(".over .over-new")!.classList.contains("primary")).toBe(false);
    button.click();
    await settle(sides.white, sides.black);
    expect(b.querySelector(".invitation .invite-words")!.textContent).toBe("Rematch? (Unlimited)");
    b.querySelector<HTMLButtonElement>(".invitation .accept-invite")!.click();
    await settle(sides.white, sides.black);
    expect(sides.white.game.view().me).toBe("b");
    expect(w.querySelector(".side")!.textContent).toBe("You play black");
  });

  it("is off with the update hint for Chess 1.0.2", async () => {
    const sides = await startChat("1.0.2");
    const w = mount(sides.white);
    await play(sides, "e2e4");
    await sides.white.game.resign();
    await settle(sides.white, sides.black);
    const button = w.querySelector<HTMLButtonElement>(".over .over-rematch")!;
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Your contact needs to update Chess (they have 1.0.2)");
  });
});

describe("premoves on the board", () => {
  it("queue a move on the contact's turn, drawn apart, dropped by Escape or a right-click, and played on arrival", async () => {
    const sides = await startChat();
    const b = mount(sides.black);
    const board = b.querySelector<HTMLElement>(".board")!;
    sq(b, "e7").click();
    expect(sq(b, "e7").classList.contains("selected")).toBe(true);
    sq(b, "e5").click();
    expect(sq(b, "e7").classList.contains("premove")).toBe(true);
    expect(sq(b, "e5").classList.contains("premove")).toBe(true);
    expect(sq(b, "e5").getAttribute("aria-label")).toContain("premove");
    key(sq(b, "e5"), "Escape");
    expect(b.querySelector(".premove")).toBeNull();
    sq(b, "e7").click();
    sq(b, "e5").click();
    board.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(b.querySelector(".premove")).toBeNull();
    // A click on a square that is not a target drops it too.
    sq(b, "e7").click();
    sq(b, "e5").click();
    sq(b, "a4").click();
    expect(b.querySelector(".premove")).toBeNull();
    sq(b, "d7").click();
    sq(b, "d5").click();
    await play(sides, "e2e4");
    await settle(sides.white, sides.black);
    expect(sides.white.game.view().plies).toBe(2);
    expect(sq(b, "d5").dataset.piece).toBe("bp");
    expect(b.querySelector(".premove")).toBeNull();
  });

  it("are off with the setting, and while reviewing", async () => {
    const sides = await startChat();
    await play(sides, "e2e4", "e7e5", "g1f3");
    const w = mount(sides.white);
    w.querySelector<HTMLButtonElement>(".nav-prev")!.click();
    sq(w, "f1").click();
    sq(w, "c4").click();
    expect(w.querySelector(".premove")).toBeNull();
    w.querySelector<HTMLButtonElement>(".nav-last")!.click();
    await sides.white.prefs.set({ premove: false });
    sq(w, "f1").click();
    sq(w, "c4").click();
    expect(w.querySelector(".premove")).toBeNull();
    expect(w.querySelector(".selected")).toBeNull();
  });
});
