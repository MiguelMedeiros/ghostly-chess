// @vitest-environment happy-dom
// covers: apps.chess
// The board on screen: orientation, coordinates, highlights, click and drag input, promotion, flip, and renders that
// touch only what changed.
import { afterEach, describe, expect, it } from "vitest";
import type { MiniAppJson } from "../src/vendor/miniApp.ts";
import { ar } from "../src/languages.ts";
import { PREFS_KEY } from "../src/prefs.ts";
import { chatPair } from "./mockBroker.ts";
import { mount, open, play, pointer, settle, sq, startAlone, startChat, tick, type Side } from "./sides.ts";

afterEach(() => {
  document.documentElement.removeAttribute("dir");
  document.body.replaceChildren();
});

/** The click a browser sends after a pointer's press and release (detail 1; element.click() sends 0). */
const pointerClick = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The squares as drawn, top row first. */
const drawn = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".rank")].map((row) => [...row.querySelectorAll<HTMLElement>(".sq")].map((s) => s.dataset.square));
const moves = (side: Side) => side.broker.sent.filter((f) => (f as { k?: string }).k === "move") as { m: string; n: number }[];

describe("orientation", () => {
  it("draws a1 at the bottom left for white and the top right for black", async () => {
    const { white, black } = await startChat();
    const w = mount(white);
    const b = mount(black);
    expect(drawn(w)[7][0]).toBe("a1");
    expect(drawn(w)[0][7]).toBe("h8");
    expect(drawn(b)[0][7]).toBe("a1");
    expect(drawn(b)[7][0]).toBe("h8");
  });

  it("starts black's keyboard focus on e7 when the page was drawn before the toss gave the colours", async () => {
    // A 1.x contact: the toss starts by itself, after both pages are drawn.
    const [a, b] = chatPair("1.2.0");
    const ana = await open(a);
    const anaRoot = mount(ana);
    const bob = await open(b);
    const bobRoot = mount(bob);
    await settle(ana, bob);
    const blackRoot = ana.game.view().me === "b" ? anaRoot : bobRoot;
    const whiteRoot = blackRoot === anaRoot ? bobRoot : anaRoot;
    expect([...blackRoot.querySelectorAll<HTMLElement>('.sq[tabindex="0"]')].map((s) => s.dataset.square)).toEqual(["e7"]);
    expect([...whiteRoot.querySelectorAll<HTMLElement>('.sq[tabindex="0"]')].map((s) => s.dataset.square)).toEqual(["e2"]);
  });

  it("puts the coordinates on the bottom rank and the left file, in both orientations", async () => {
    const { white, black } = await startChat();
    for (const [side, files, ranks] of [[white, "abcdefgh", "87654321"], [black, "hgfedcba", "12345678"]] as const) {
      const root = mount(side);
      const coords = root.querySelector<HTMLElement>(".coords")!;
      expect(coords.getAttribute("aria-hidden")).toBe("true");
      const fileLabels = [...coords.querySelectorAll<HTMLElement>(".coord.file")];
      const rankLabels = [...coords.querySelectorAll<HTMLElement>(".coord.rank-label")];
      expect(fileLabels.map((l) => l.textContent).join("")).toBe(files);
      expect(rankLabels.map((l) => l.textContent).join("")).toBe(ranks);
      expect(fileLabels.every((l) => l.style.gridRow === "8")).toBe(true);
      expect(fileLabels.map((l) => l.style.gridColumn)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
      expect(rankLabels.every((l) => l.style.gridColumn === "1")).toBe(true);
      // In the colour of the other square: the bottom left square is dark in both orientations (a1, h8).
      const corner = "on-dark";
      expect(fileLabels[0].classList.contains(corner)).toBe(true);
      expect(rankLabels[7].classList.contains(corner)).toBe(true);
      // Never inside a square: a square's text is its piece's glyph alone.
      expect(sq(root, side === white ? "a1" : "h8").textContent).toMatch(/^[♜]︎$/);
    }
  });

  it("hides the coordinates when the setting is off", async () => {
    const solo = await startAlone();
    const root = mount(solo);
    await solo.prefs.set({ coords: false });
    expect(root.querySelector<HTMLElement>(".coords")!.hidden).toBe(true);
  });

  it("Flip turns the board, keeps it in this chat's prefs as `turned`, and stays left to right in Arabic", async () => {
    document.documentElement.dir = "rtl";
    const { white } = await startChat();
    const root = mount(white, ar);
    expect(drawn(root)[7][0]).toBe("a1");
    root.querySelector<HTMLButtonElement>(".flip")!.click();
    await tick();
    expect(drawn(root)[7][0]).toBe("h8");
    expect(drawn(root)[0][7]).toBe("a1");
    expect(JSON.parse(white.broker.stored.get(PREFS_KEY)!).turned).toBe(true);
    // The toss's key is untouched.
    expect(white.broker.stored.has("flip")).toBe(false);
    const board = root.querySelector<HTMLElement>(".board")!;
    expect(board.closest("[dir]")?.getAttribute("dir")).toBe("ltr");
    expect(root.querySelector(".coord.file")!.textContent).toBe("h");
    root.querySelector<HTMLButtonElement>(".flip")!.click();
    await tick();
    expect(drawn(root)[7][0]).toBe("a1");
    expect(JSON.parse(white.broker.stored.get(PREFS_KEY)!).turned).toBe(false);
  });
});

describe("highlights follow the view", () => {
  it("marks the last move, legal-move dots, capture rings and the king in check", async () => {
    const solo = await startAlone();
    const root = mount(solo);
    await play({ white: solo }, "e2e4", "d7d5");
    expect(sq(root, "d7").classList.contains("last")).toBe(true);
    expect(sq(root, "d5").classList.contains("last")).toBe(true);
    expect(sq(root, "e2").classList.contains("last")).toBe(false);
    sq(root, "e4").click();
    expect(sq(root, "e4").classList.contains("selected")).toBe(true);
    expect(sq(root, "e5").className).toMatch(/\btarget\b/);
    expect(sq(root, "e5").classList.contains("capture")).toBe(false);
    expect(sq(root, "d5").className).toMatch(/\btarget capture\b/);
    expect(sq(root, "e5").getAttribute("aria-label")).toContain("move here");
    // Without legal-move dots, the squares say so still, but show nothing.
    await solo.prefs.set({ legal: false });
    expect(sq(root, "e5").classList.contains("target")).toBe(false);
    expect(sq(root, "e5").getAttribute("aria-label")).toContain("move here");
    await solo.prefs.set({ legal: true });
    sq(root, "e4").click(); // lets go
    expect(sq(root, "e4").classList.contains("selected")).toBe(false);
    expect(root.querySelectorAll(".target")).toHaveLength(0);
    await play({ white: solo }, "d1h5", "a7a6", "h5f7");
    expect(sq(root, "e8").classList.contains("check")).toBe(true);
    expect(root.querySelectorAll(".check")).toHaveLength(1);
  });
});

describe("input", () => {
  it("plays e2e4 by click, click", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    sq(root, "e2").click();
    expect(sq(root, "e2").classList.contains("selected")).toBe(true);
    sq(root, "e4").click();
    await settle(white, black);
    expect(moves(white).map((m) => m.m)).toEqual(["e2e4"]);
    expect(black.game.view().lastMove?.to).toBe("e4");
  });

  it("plays e2e4 by a pointer drag, and a press then a click on the target plays too", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    pointer(sq(root, "e2"), "pointerdown", 100, 300);
    expect(sq(root, "e2").classList.contains("selected")).toBe(true);
    pointer(sq(root, "e3"), "pointermove", 100, 280);
    expect(root.querySelector(".ghost")).not.toBeNull();
    expect(sq(root, "e2").classList.contains("dragging")).toBe(true);
    // A touch's implicit capture on its square moves to the board: the square losing it does not end the drag.
    pointer(sq(root, "e2"), "lostpointercapture", 100, 280);
    expect(root.querySelector(".ghost")).not.toBeNull();
    pointer(sq(root, "e4"), "pointermove", 100, 220);
    expect(sq(root, "e4").classList.contains("hover")).toBe(true);
    pointer(sq(root, "e4"), "pointerup", 100, 220);
    pointerClick(root.querySelector(".board")!); // the click a browser sends after a drag, on the board: not a press
    await settle(white, black);
    expect(root.querySelector(".ghost")).toBeNull();
    expect(moves(white).map((m) => m.m)).toEqual(["e2e4"]);
    expect(sq(root, "e2").textContent).toBe("");
    expect(sq(root, "e2").className).not.toMatch(/dragging|hover|selected/);
  });

  it("snaps an illegal drop back and sends nothing", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    const before = white.broker.sent.length;
    pointer(sq(root, "e2"), "pointerdown", 100, 300);
    pointer(sq(root, "e5"), "pointermove", 100, 160);
    pointer(sq(root, "e5"), "pointerup", 100, 160);
    await tick();
    await settle(white, black);
    expect(white.broker.sent.length).toBe(before);
    expect(root.querySelector(".ghost")).toBeNull();
    expect(sq(root, "e2").textContent).toMatch(/♟/);
    expect(sq(root, "e2").classList.contains("selected")).toBe(true);
  });

  it("sends nothing when the pointer is cancelled mid-drag (the browser took the touch)", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    const before = white.broker.sent.length;
    pointer(sq(root, "e2"), "pointerdown", 100, 300);
    pointer(sq(root, "e4"), "pointermove", 100, 220);
    pointer(sq(root, "e4"), "pointercancel", 100, 220);
    // A pointerup that comes later belongs to no press.
    pointer(sq(root, "e4"), "pointerup", 100, 220);
    await tick();
    await settle(white, black);
    expect(white.broker.sent.length).toBe(before);
    expect(root.querySelector(".ghost")).toBeNull();
    expect(sq(root, "e4").textContent).toBe("");
  });

  it("ends a press released off the board, so the next press still works", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    pointer(sq(root, "e2"), "pointerdown", 100, 300);
    pointer(document.body, "pointerup", 100, 900);
    await tick();
    pointer(sq(root, "d2"), "pointerdown", 80, 300);
    expect(sq(root, "d2").classList.contains("selected")).toBe(true);
    pointer(sq(root, "d2"), "pointerup", 80, 300);
    await tick();
    sq(root, "d4").click();
    await settle(white, black);
    expect(moves(white).map((m) => m.m)).toEqual(["d2d4"]);
  });

  it("skips the click that follows a pointer's own press, even 100 ms later (a touch's click comes late)", async () => {
    const solo = await startAlone();
    const root = mount(solo);
    pointer(sq(root, "e2"), "pointerdown", 100, 300);
    pointer(sq(root, "e2"), "pointerup", 100, 300);
    await wait(100);
    pointerClick(sq(root, "e2"));
    // Had the click counted as a second press, it would have let go of the pawn.
    expect(sq(root, "e2").classList.contains("selected")).toBe(true);
  });

  it("after a pointer's click, click move, a click no pointer made (a screen reader's) still picks a piece", async () => {
    const solo = await startAlone();
    const root = mount(solo);
    for (const square of ["e2", "e4"]) {
      pointer(sq(root, square), "pointerdown", 100, 300);
      pointer(sq(root, square), "pointerup", 100, 300);
      pointerClick(sq(root, square));
      await tick(); // time passes between two presses
    }
    await settle(solo);
    expect(solo.game.history()).toEqual(["e4"]);
    sq(root, "e7").click();
    expect(sq(root, "e7").classList.contains("selected")).toBe(true);
  });

  it("a press on the contact's turn does not swallow the next click", async () => {
    const { white, black } = await startChat();
    const root = mount(black);
    pointer(sq(root, "e7"), "pointerdown", 0, 0);
    pointer(sq(root, "e7"), "pointerup", 0, 0);
    await play({ white, black }, "e2e4");
    sq(root, "e7").click();
    expect(sq(root, "e7").classList.contains("selected")).toBe(true);
  });

  it("selects nothing on the contact's turn", async () => {
    const { black } = await startChat();
    const root = mount(black);
    pointer(sq(root, "e7"), "pointerdown", 0, 0);
    expect(sq(root, "e7").classList.contains("selected")).toBe(false);
  });

  it("keeps the keyboard grid: arrows move, Enter picks and plays, Escape lets go", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    const board = root.querySelector<HTMLElement>(".board")!;
    const key = (k: string) => board.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    expect(sq(root, "e2").tabIndex).toBe(0);
    key("Enter");
    expect(sq(root, "e2").classList.contains("selected")).toBe(true);
    key("Escape");
    expect(sq(root, "e2").classList.contains("selected")).toBe(false);
    key("Enter");
    key("ArrowUp");
    key("ArrowUp");
    expect(sq(root, "e4").tabIndex).toBe(0);
    key(" ");
    await settle(white, black);
    expect(moves(white).map((m) => m.m)).toEqual(["e2e4"]);
  });
});

// 1.e4 f5 2.exf5 Kf7 3.f6 Kg6 4.fxe7 Kg5: white's pawn on e7, e8 empty.
const TO_PROMOTION = ["e2e4", "f7f5", "e4f5", "e8f7", "f5f6", "f7g6", "f6e7", "g6g5"];

describe("promotion", () => {
  it("offers Q, R, B and N over the promotion file, focuses Q, and sends e7e8n when N is picked", async () => {
    const { white, black } = await startChat();
    await play({ white, black }, ...TO_PROMOTION);
    const root = mount(white);
    sq(root, "e7").click();
    sq(root, "e8").click();
    const overlay = root.querySelector<HTMLElement>(".promo")!;
    expect(overlay).not.toBeNull();
    const choices = [...overlay.querySelectorAll<HTMLButtonElement>(".promo-choice")];
    expect(choices.map((c) => c.dataset.promote)).toEqual(["q", "r", "b", "n"]);
    expect(choices.map((c) => c.getAttribute("aria-label"))).toEqual(["queen", "rook", "bishop", "knight"]);
    expect(choices.every((c) => c.classList.contains("w"))).toBe(true);
    expect(document.activeElement).toBe(choices[0]);
    // The column stands on the e-file.
    expect(overlay.querySelector<HTMLElement>(".promo-col")!.style.left).toBe("50%");
    // Arrows walk the column.
    overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    choices[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    choices[3].click();
    await settle(white, black);
    expect(root.querySelector(".promo")).toBeNull();
    expect(moves(white).at(-1)?.m).toBe("e7e8n");
    expect(black.game.view().lastMove?.promotion).toBe("n");
  });

  it("Escape cancels the picker and sends nothing", async () => {
    const { white, black } = await startChat();
    await play({ white, black }, ...TO_PROMOTION);
    const root = mount(white);
    const before = white.broker.sent.length;
    sq(root, "e7").click();
    sq(root, "e8").click();
    root.querySelector(".promo")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(white, black);
    expect(root.querySelector(".promo")).toBeNull();
    expect(white.broker.sent.length).toBe(before);
    expect(sq(root, "e7").textContent).toMatch(/♟/);
  });

  it("a press outside the picker cancels it", async () => {
    const { white, black } = await startChat();
    await play({ white, black }, ...TO_PROMOTION);
    const root = mount(white);
    const before = white.broker.sent.length;
    sq(root, "e7").click();
    sq(root, "e8").click();
    pointer(root.querySelector(".promo-shade")!, "pointerdown");
    await settle(white, black);
    expect(root.querySelector(".promo")).toBeNull();
    expect(white.broker.sent.length).toBe(before);
    expect(document.activeElement).toBe(sq(root, "e7"));
  });

  it("with auto-queen on, sends e7e8q and shows no picker", async () => {
    const { white, black } = await startChat();
    await play({ white, black }, ...TO_PROMOTION);
    await white.prefs.set({ autoQueen: true });
    const root = mount(white);
    sq(root, "e7").click();
    sq(root, "e8").click();
    expect(root.querySelector(".promo")).toBeNull();
    await settle(white, black);
    expect(moves(white).at(-1)?.m).toBe("e7e8q");
  });
});

describe("rendering", () => {
  it("after one move, touches only the squares that changed", async () => {
    const { white, black } = await startChat();
    await play({ white, black }, "e2e4");
    const root = mount(white);
    const touched = new Set<string>();
    const boardChanges: string[] = [];
    const board = root.querySelector(".board")!;
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        const square = (r.target instanceof Element ? r.target : r.target.parentElement)?.closest<HTMLElement>(".sq")?.dataset.square;
        if (square) touched.add(square);
        // The board itself or a row: only the board's class (its lock) may change; a row never re-takes its squares.
        else boardChanges.push(r.type === "attributes" && r.target === board ? `board ${r.attributeName}` : `${r.type} on ${(r.target as Element).className}`);
      }
    });
    observer.observe(root.querySelector(".board")!, { attributes: true, childList: true, subtree: true, characterData: true });
    await play({ white, black }, "e7e5");
    observer.takeRecords().forEach(() => {});
    await tick();
    observer.disconnect();
    // e7 and e5 (the move), e2 and e4 (no longer the last move); and the board's own lock, since it is white's turn.
    expect([...touched].sort()).toEqual(["e2", "e4", "e5", "e7"]);
    expect(boardChanges.every((c) => c === "board class"), boardChanges.join("; ")).toBe(true);
  });

  it("changes the piece set without changing what a square reads", async () => {
    const solo = await startAlone();
    const root = mount(solo);
    expect(sq(root, "d1").querySelector("svg.piece")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(sq(root, "d1").querySelector("svg.piece")?.getAttribute("aria-hidden")).toBe("true");
    await solo.prefs.set({ pieces: "classic" });
    expect(sq(root, "d1").querySelector("svg")).toBeNull();
    expect(sq(root, "d1").textContent).toBe("♛︎");
    expect(root.querySelector(".board-wrap")!.classList.contains("classic")).toBe(true);
    await solo.prefs.set({ theme: "blue" });
    expect(root.querySelector<HTMLElement>(".board-wrap")!.dataset.theme).toBe("blue");
  });
});

describe("the page", () => {
  it("shows a player strip above and below: the contact on top, you at the bottom", async () => {
    const { white, black } = await startChat();
    const root = mount(black);
    expect(root.querySelector(".strip.top")!.textContent).toBe("Your contact");
    expect(root.querySelector(".strip.top .dot")!.classList.contains("w")).toBe(true);
    expect(root.querySelector(".strip.bottom")!.textContent).toBe("You");
    expect(root.querySelector(".strip.bottom .dot")!.classList.contains("b")).toBe(true);
    expect(root.querySelector(".strip.top")!.classList.contains("to-move")).toBe(true);
    await play({ white, black }, "e2e4");
    expect(root.querySelector(".strip.bottom")!.classList.contains("to-move")).toBe(true);
  });

  it("announces each move in words, once, in the one live region; .status has no role", async () => {
    const { white, black } = await startChat();
    const root = mount(black);
    const live = root.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(root.querySelector(".status")!.hasAttribute("role")).toBe(false);
    expect(root.querySelector(".notice:not(.info)")!.getAttribute("role")).toBe("alert");
    await play({ white, black }, "e2e4");
    expect(live[0].textContent).toBe("Your contact: pawn to e4");
    await play({ white, black }, "g8f6");
    expect(live[0].textContent).toBe("You: knight to f6");
    await play({ white, black }, "d1h5", "f6h5");
    expect(live[0].textContent).toBe("You: knight takes on h5");
  });

  it("announces check, castling and the game's end", async () => {
    const solo = await startAlone();
    const root = mount(solo);
    const live = root.querySelector("[aria-live]")!;
    await play({ white: solo }, "e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1");
    expect(live.textContent).toBe("White: castles kingside");
    await play({ white: solo }, "f6e4", "c4f7");
    expect(live.textContent).toBe("White: bishop takes on f7, check");
    const fool = await startAlone();
    document.body.replaceChildren();
    const r2 = mount(fool);
    await play({ white: fool }, "f2f3", "e7e5", "g2g4");
    await play({ white: fool }, "d8h4");
    expect(r2.querySelector("[aria-live]")!.textContent).toBe("Black wins: checkmate");
  });

  it("lists the moves, numbered in pairs", async () => {
    const solo = await startAlone();
    const root = mount(solo);
    expect(root.querySelector<HTMLElement>(".moves")!.hidden).toBe(true);
    await play({ white: solo }, "e2e4", "e7e5", "g1f3");
    const list = root.querySelector<HTMLElement>(".moves")!;
    expect(list.hidden).toBe(false);
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["1.e4e5", "2.Nf3"]);
    expect(list.querySelector(".current")!.textContent).toBe("Nf3");
  });

  it("opens settings in a focus-trapped dialog, saves a change, and closes on Escape", async () => {
    const solo = await startAlone();
    const root = mount(solo);
    const opener = root.querySelector<HTMLButtonElement>(".settings-btn")!;
    opener.click();
    const dialog = root.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await tick();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const brown = dialog.querySelector<HTMLInputElement>('input[value="brown"]')!;
    brown.checked = true;
    brown.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(JSON.parse(solo.broker.stored.get(PREFS_KEY)!).theme).toBe("brown");
    expect(root.querySelector<HTMLElement>(".board-wrap")!.dataset.theme).toBe("brown");
    const coords = dialog.querySelector<HTMLInputElement>('input[data-pref="coords"]')!;
    coords.checked = false;
    coords.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(root.querySelector<HTMLElement>(".coords")!.hidden).toBe(true);
    // Tab from the last control wraps to the first.
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button, input")];
    focusable.at(-1)!.focus();
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(focusable[0]);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("writes the settings only when one changes", async () => {
    const solo = await startAlone();
    let writes = 0;
    const set = solo.broker.storage.set;
    solo.broker.storage.set = async (key: string, value: MiniAppJson) => {
      if (key === PREFS_KEY) writes++;
      return set(key, value);
    };
    await solo.prefs.set({ theme: "green", coords: true });
    expect(writes).toBe(0);
    await solo.prefs.set({ theme: "blue" });
    await solo.prefs.set({ theme: "blue" });
    expect(writes).toBe(1);
  });
});
