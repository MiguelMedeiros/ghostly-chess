// @vitest-environment happy-dom
// covers: apps.chess
// The game panel on screen: the move list and the review (buttons, keys, a click on a move), the contact's moves
// during a review, the opening, the pieces taken, the game-over card in English and Arabic, sounds, and Copy PGN.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { View } from "../src/game.ts";
import { ar } from "../src/languages.ts";
import { overText } from "../src/panel.ts";
import { PREFS_KEY } from "../src/prefs.ts";
import { PLAY_STEP_MS } from "../src/review.ts";
import type { AudioContextLike, SoundName } from "../src/sound.ts";
import { en, type Strings } from "../src/strings.ts";
import { mountChess } from "../src/ui.ts";
import { agree, mount as mountSide, play, pointer, settle, sq, startAlone, startChat, tick, type Side } from "./sides.ts";

/** Every page mounted here, unmounted after each test: a page listens to the document's keys. */
const mounted: Side[] = [];
const mount = (side: Side, strings?: Strings) => {
  mounted.push(side);
  return mountSide(side, strings);
};

afterEach(() => {
  for (const side of mounted.splice(0)) side.unmount?.();
  vi.useRealTimers();
  document.documentElement.removeAttribute("dir");
  document.body.replaceChildren();
});

const pointerClick = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
const keyOn = (target: EventTarget, key: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const moveButtons = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>(".moves button[data-ply]")];
const current = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.moves [aria-current="step"]')?.dataset.ply ?? "live-start";
const reviewing = (root: HTMLElement) => root.querySelector(".board-wrap")!.classList.contains("reviewing");
const navButton = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`.nav-${name}`)!;
const sentMoves = (side: Side) => side.broker.sent.filter((f) => (f as { k?: string }).k === "move");

async function alone(...plies: string[]): Promise<{ solo: Side; root: HTMLElement }> {
  const solo = await startAlone();
  const root = mount(solo);
  if (plies.length) await play({ white: solo }, ...plies);
  return { solo, root };
}

describe("the move list", () => {
  it("is a labelled list whose moves are buttons read as words, one tab stop, the current move marked", async () => {
    const { root } = await alone("e2e4", "e7e5", "g1f3", "b8c6", "f1b5");
    const list = root.querySelector<HTMLElement>(".moves")!;
    expect(list.tagName).toBe("OL");
    expect(list.getAttribute("aria-label")).toBe("Moves");
    expect(list.dir).toBe("ltr");
    const buttons = moveButtons(root);
    expect(buttons.map((b) => b.textContent)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    expect(buttons[0].getAttribute("aria-label")).toBe("1. e4, White: pawn to e4");
    expect(buttons[3].getAttribute("aria-label")).toBe("2. Nc6, Black: knight to c6");
    // Each name holds the label on screen (WCAG 2.5.3).
    for (const b of buttons) expect(b.getAttribute("aria-label")).toContain(b.textContent!);
    expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([buttons[4]]);
    expect(current(root)).toBe("5");
    // The move numbers are not read on their own: each button says its number.
    expect(root.querySelector(".moves .no")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("a click on a move shows that position, and » (Back to live while reviewing) returns to the game", async () => {
    const { solo, root } = await alone("e2e4", "e7e5", "g1f3");
    moveButtons(root)[0].click();
    expect(current(root)).toBe("1");
    expect(reviewing(root)).toBe(true);
    // After 1.e4: black's pawn is still on e7, white's knight on g1.
    expect(sq(root, "e7").dataset.piece).toBe("bp");
    expect(sq(root, "e5").dataset.piece).toBe("");
    expect(sq(root, "g1").dataset.piece).toBe("wn");
    expect(sq(root, "e4").classList.contains("last")).toBe(true);
    // The game itself did not move: its status is the live one.
    expect(root.querySelector(".status")!.textContent).toBe("Black to move");
    expect(solo.game.view().plies).toBe(3);
    // No Back to live in the controls (a row of its own below the board): » is the way back, marked and named so.
    expect(root.querySelector(".actions .live")).toBeNull();
    const live = navButton(root, "last");
    expect(live.classList.contains("live")).toBe(true);
    expect(live.getAttribute("aria-label")).toBe("Back to live");
    expect(live.title).toBe("Back to live");
    live.focus();
    live.click();
    expect(reviewing(root)).toBe(false);
    expect(sq(root, "f3").dataset.piece).toBe("wn");
    expect(live.classList.contains("live")).toBe(false);
    expect(live.getAttribute("aria-label")).toBe("Last move");
    // Focus does not fall to the page: it goes to the move list.
    expect(document.activeElement).toBe(moveButtons(root)[2]);
  });

  it("the review bar's buttons move the cursor, and Play steps a move a second", async () => {
    const { root } = await alone("e2e4", "e7e5", "g1f3", "b8c6");
    expect(navButton(root, "next").disabled).toBe(true);
    expect(navButton(root, "last").disabled).toBe(true);
    navButton(root, "first").click();
    expect(current(root)).toBe("live-start");
    expect(reviewing(root)).toBe(true);
    expect(sq(root, "e2").dataset.piece).toBe("wp");
    expect(navButton(root, "first").disabled).toBe(true);
    navButton(root, "next").click();
    navButton(root, "next").click();
    expect(current(root)).toBe("2");
    navButton(root, "prev").click();
    expect(current(root)).toBe("1");
    navButton(root, "last").click();
    expect(reviewing(root)).toBe(false);
    expect(current(root)).toBe("4");

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const playButton = navButton(root, "play");
    expect(playButton.getAttribute("aria-label")).toBe("Play the moves");
    playButton.click();
    expect(playButton.getAttribute("aria-label")).toBe("Pause");
    expect(current(root)).toBe("live-start");
    vi.advanceTimersByTime(PLAY_STEP_MS * 2);
    expect(current(root)).toBe("2");
    vi.advanceTimersByTime(PLAY_STEP_MS * 5);
    expect(reviewing(root)).toBe(false);
    expect(playButton.getAttribute("aria-label")).toBe("Play the moves");
  });

  it("Left/Right/Home/End review outside the board, the board keeps its arrows, PageUp/PageDown work anywhere", async () => {
    const { root } = await alone("e2e4", "e7e5", "g1f3", "b8c6");
    keyOn(document.body, "ArrowLeft");
    expect(current(root)).toBe("3");
    keyOn(document.body, "ArrowLeft");
    expect(current(root)).toBe("2");
    keyOn(document.body, "ArrowRight");
    expect(current(root)).toBe("3");
    keyOn(document.body, "Home");
    expect(current(root)).toBe("live-start");
    keyOn(document.body, "End");
    expect(reviewing(root)).toBe(false);
    // On the board, the arrows move between squares and leave the review alone.
    const square = sq(root, "e2");
    square.focus();
    keyOn(square, "ArrowLeft");
    expect(reviewing(root)).toBe(false);
    expect(sq(root, "d2").tabIndex).toBe(0);
    // PageUp and PageDown step the review from anywhere, the board included.
    keyOn(sq(root, "d2"), "PageUp");
    expect(current(root)).toBe("3");
    keyOn(sq(root, "d2"), "PageDown");
    expect(reviewing(root)).toBe(false);
    // In a move button, the keys step the review and focus follows the current move.
    moveButtons(root)[3].focus();
    keyOn(moveButtons(root)[3], "ArrowLeft");
    expect(document.activeElement).toBe(moveButtons(root)[2]);
    // A modifier, or a dialog, keeps its keys.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, altKey: true }));
    expect(current(root)).toBe("3");
  });

  it("makes no move while reviewing: the board is locked and a click, click sends nothing", async () => {
    const { white, black } = await startChat();
    await play({ white, black }, "e2e4", "e7e5");
    const root = mount(white);
    navButton(root, "prev").click();
    expect(root.querySelector(".board")!.classList.contains("locked")).toBe(true);
    pointerClick(sq(root, "g1"));
    pointerClick(sq(root, "f3"));
    pointer(sq(root, "d2"), "pointerdown");
    pointer(sq(root, "d2"), "pointerup");
    await tick();
    await settle(white, black);
    expect(sentMoves(white)).toHaveLength(1);
    expect(sq(root, "g1").classList.contains("selected")).toBe(false);
    // Live again, the same clicks play.
    navButton(root, "last").click();
    pointerClick(sq(root, "g1"));
    pointerClick(sq(root, "f3"));
    await settle(white, black);
    expect(sentMoves(white)).toHaveLength(2);
  });

  it("the contact's move during a review lands in the list, read aloud, while the board stays at the cursor", async () => {
    const { white, black } = await startChat();
    await play({ white, black }, "e2e4", "e7e5", "g1f3");
    const root = mount(black);
    moveButtons(root)[0].click();
    await play({ white, black }, "b8c6", "f1b5");
    expect(moveButtons(root).map((b) => b.textContent)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    expect(current(root)).toBe("1");
    expect(sq(root, "b5").dataset.piece).toBe("");
    expect(sq(root, "e5").dataset.piece).toBe("");
    expect(root.querySelector("[aria-live]")!.textContent).toBe("Your contact: bishop to b5");
    expect(root.querySelector(".status")!.textContent).toBe("Your move");
    navButton(root, "last").click();
    expect(sq(root, "b5").dataset.piece).toBe("wb");
    expect(current(root)).toBe("5");
  });
});

describe("the opening and the pieces taken", () => {
  it("names the opening in English with its ECO code, lang=en, whatever the UI language", async () => {
    const solo = await startAlone();
    document.documentElement.dir = "rtl";
    const root = mount(solo, { ...en, ...ar } as Strings);
    expect(root.querySelector(".opening")!.textContent).toBe("");
    await play({ white: solo }, "e2e4", "c7c5");
    const name = root.querySelector<HTMLElement>(".opening-name")!;
    expect(name.lang).toBe("en");
    expect(name.dir).toBe("ltr");
    expect(name.textContent).toBe("B20 Sicilian Defense");
    expect(root.querySelector(".opening .sr-only")!.textContent).toBe(`${ar.opening}: `);
    // The review shows the opening of the position under the cursor.
    navButton(root, "prev").click();
    expect(root.querySelector(".opening-name")!.textContent).toBe("B00 King's Pawn Game");
    expect(root.querySelector(".opening")!.getAttribute("title")).toBe("B00 King's Pawn Game");
    // At the start, no opening: no line, and no tooltip left over.
    navButton(root, "first").click();
    expect(root.querySelector(".opening")!.textContent).toBe("");
    expect(root.querySelector(".opening")!.hasAttribute("title")).toBe(false);
  });

  it("shows the pieces each side took and the lead of the side ahead, in its strip, at the reviewed ply", async () => {
    const { root } = await alone("e2e4", "d7d5", "e4d5");
    const bottom = root.querySelector<HTMLElement>(".strip.bottom .taken")!; // white at the bottom
    expect(bottom.querySelectorAll(".cap")).toHaveLength(1);
    expect(bottom.querySelector(".lead")!.textContent).toBe("+1");
    expect(bottom.getAttribute("aria-label")).toBe("Taken: pawn. 1 ahead");
    expect(root.querySelector(".strip.top .taken")!.childElementCount).toBe(0);
    navButton(root, "prev").click();
    expect(root.querySelector(".strip.bottom .taken")!.childElementCount).toBe(0);
  });
});

describe("the game-over card", () => {
  const REASONS = ["checkmate", "resign", "stalemate", "repetition", "fifty", "material", "agreed", "limit"] as const;
  const view = (end: View["end"], me?: "w" | "b"): View => ({ phase: me ? "over" : "alone", me, peerOpen: true, fen: "", turn: "w", plies: 10, inCheck: false, canMove: false, end, mode: "v2", features: [] });

  it("says the result and how the game ended, for every reason, in English and Arabic", () => {
    const expected: Record<string, [string, string]> = {
      checkmate: ["Checkmate", ar.why_checkmate],
      resign: ["Resignation", ar.why_resign],
      stalemate: ["Stalemate", ar.why_stalemate],
      repetition: ["Threefold repetition", ar.why_repetition],
      fifty: ["50-move rule", ar.why_fifty],
      material: ["Not enough material", ar.why_material],
      agreed: ["Agreed", ar.why_agreed],
      limit: ["Move limit", ar.why_limit],
    };
    const arabic = { ...en, ...ar } as Strings;
    for (const why of REASONS) {
      const draw = !["checkmate", "resign"].includes(why);
      const end = { result: draw ? "1/2-1/2" : "1-0", why } as NonNullable<View["end"]>;
      expect(overText(view(end, "w"), en), why).toEqual({ head: draw ? "Draw" : "You win", reason: expected[why][0] });
      expect(overText(view(end, "w"), arabic), why).toEqual({ head: draw ? ar.drawn : ar.won, reason: expected[why][1] });
      if (!draw) {
        expect(overText(view(end, "b"), en)!.head).toBe("You lose");
        expect(overText(view(end, "b"), arabic)!.head).toBe(ar.lost);
        expect(overText(view(end), en)!.head).toBe("White wins");
      }
    }
    expect(overText(view(undefined, "w"), en)).toBeNull();
  });

  it("shows on the board, not modal; Review closes it for this ending, and focus moves to it only from the board", async () => {
    const { solo, root } = await alone("f2f3", "e7e5", "g2g4");
    sq(root, "d8").focus();
    await play({ white: solo }, "d8h4");
    const card = root.querySelector<HTMLElement>(".board-wrap .over")!;
    expect(card.hidden).toBe(false);
    expect(card.hasAttribute("aria-modal")).toBe(false);
    expect(card.querySelector(".over-head")!.textContent).toBe("Black wins");
    expect(card.querySelector(".over-reason")!.textContent).toBe("Checkmate");
    expect(document.activeElement).toBe(card.querySelector(".over-head"));
    // Alone, no Rematch.
    expect([...card.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent)).toEqual(["New game", "Copy PGN", "Review"]);
    // The status line keeps its words.
    expect(root.querySelector(".status")!.textContent).toBe("Black wins: checkmate");
    card.querySelector<HTMLButtonElement>(".over-review")!.click();
    expect(card.hidden).toBe(true);
    expect(root.querySelector(".moves")!.contains(document.activeElement)).toBe(true);
    // It stays closed while the game is reviewed.
    navButton(root, "first").click();
    navButton(root, "last").click();
    expect(card.hidden).toBe(true);
    // New game (from the controls now): the card's game is gone.
    root.querySelector<HTMLButtonElement>(".actions button")!.click();
    await settle(solo);
    expect(solo.game.view().plies).toBe(0);
    expect(card.hidden).toBe(true);
  });

  it("has no Review for a game that ended before its first move", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    // Before ply 2, Abort is the danger button: no result, nothing to review.
    root.querySelector<HTMLButtonElement>(".actions .danger")!.click();
    await settle(white, black);
    expect(root.querySelector(".over-head")!.textContent).toBe("No result");
    const card = root.querySelector<HTMLElement>(".over")!;
    expect(card.hidden).toBe(false);
    expect(card.querySelector<HTMLButtonElement>(".over-review")!.hidden).toBe(true);
    // Escape closes it, and focus lands on a control, not the page.
    card.querySelector<HTMLButtonElement>(".over-new")!.focus();
    keyOn(card.querySelector(".over-new")!, "Escape");
    expect(card.hidden).toBe(true);
    expect(root.querySelector(".actions")!.contains(document.activeElement)).toBe(true);
  });

  it("leaves focus where it was when it was not on the board", async () => {
    const { white, black } = await startChat();
    const root = mount(black);
    await play({ white, black }, "e2e4", "e7e5", "g1f3");
    const resign = root.querySelector<HTMLButtonElement>(".actions .danger")!;
    resign.click();
    document.querySelector<HTMLButtonElement>(".resign-dialog .resign-confirm")!.click();
    await settle(white, black);
    const card = root.querySelector<HTMLElement>(".over")!;
    expect(card.hidden).toBe(false);
    expect(card.querySelector(".over-head")!.textContent).toBe("You lose");
    expect(card.querySelector(".over-reason")!.textContent).toBe("Resignation");
    expect(card.contains(document.activeElement)).toBe(false);
    // New game on the card opens the new-game panel; an invitation accepted starts the game.
    card.querySelector<HTMLButtonElement>(".over-new")!.click();
    await settle(white, black);
    expect(black.game.view().phase).toBe("setup");
    expect(card.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>(".setup")!.hidden).toBe(false);
    root.querySelector<HTMLButtonElement>(".setup .invite-btn")!.click();
    await settle(white, black);
    await white.game.acceptInvitation();
    await settle(white, black);
    expect(black.game.view().phase).toBe("playing");
    expect(black.game.view().plies).toBe(0);
    expect(root.querySelector<HTMLElement>(".setup")!.hidden).toBe(true);
  });
});

describe("Copy PGN", () => {
  async function openPgn(): Promise<{ root: HTMLElement; text: HTMLTextAreaElement; copy: HTMLButtonElement; status: HTMLElement }> {
    const { root } = await alone("e2e4", "e7e5");
    root.querySelector<HTMLButtonElement>(".actions .pgn-btn")!.click();
    await tick();
    const dialog = root.querySelector<HTMLElement>(".dialog.pgn")!;
    return { root, text: dialog.querySelector("textarea")!, copy: dialog.querySelector(".pgn-copy")!, status: dialog.querySelector(".pgn-status")! };
  }

  it("shows the PGN read-only and selected", async () => {
    const { text } = await openPgn();
    expect(text.readOnly).toBe(true);
    expect(text.value).toContain('[Event "Ghostly chess"]');
    expect(text.value.trimEnd().endsWith("1. e4 e5 *")).toBe(true);
    expect(document.activeElement).toBe(text);
    expect([text.selectionStart, text.selectionEnd]).toEqual([0, text.value.length]);
  });

  it("selects the text again with the field briefly writable when a read-only field takes no selection (iOS)", async () => {
    const proto = HTMLTextAreaElement.prototype;
    const original = proto.setSelectionRange;
    const select = proto.select;
    // As iOS Safari may do: a read-only field ignores a scripted selection.
    proto.select = function (this: HTMLTextAreaElement) {
      if (!this.readOnly) select.call(this);
    };
    proto.setSelectionRange = function (this: HTMLTextAreaElement, ...args: Parameters<typeof original>) {
      if (!this.readOnly) original.apply(this, args);
    };
    try {
      const { text, copy } = await openPgn();
      expect([text.selectionStart, text.selectionEnd]).toEqual([0, text.value.length]);
      expect(text.readOnly).toBe(true);
      text.setSelectionRange(0, 0);
      text.readOnly = false;
      text.setSelectionRange(0, 0);
      text.readOnly = true;
      copy.click();
      expect([text.selectionStart, text.selectionEnd]).toEqual([0, text.value.length]);
      expect(text.readOnly).toBe(true);
    } finally {
      proto.setSelectionRange = original;
      proto.select = select;
    }
  });

  it("says Copied when execCommand copies, inside the click", async () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    const { copy, status } = await openPgn();
    copy.click();
    expect(exec).toHaveBeenCalledWith("copy");
    expect(status.textContent).toBe("Copied");
    delete (document as { execCommand?: unknown }).execCommand;
  });

  it("falls back to the async clipboard, and when both refuse, leaves the text selected and says to copy it", async () => {
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { text, copy, status } = await openPgn();
    copy.click();
    expect(writeText).toHaveBeenCalledOnce();
    await tick();
    expect(status.textContent).toBe(en.copyByHand);
    expect(document.activeElement).toBe(text);
    expect([text.selectionStart, text.selectionEnd]).toEqual([0, text.value.length]);
    // And when the clipboard takes it, Copied.
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve() }, configurable: true });
    copy.click();
    await tick();
    expect(status.textContent).toBe("Copied");
    delete (document as { execCommand?: unknown }).execCommand;
  });
});

describe("sounds on the page", () => {
  function withSounds(side: Side): { root: HTMLElement; played: SoundName[] } {
    const played: SoundName[] = [];
    const fake: Pick<AudioContextLike, "state" | "resume"> & { state: string } = {
      state: "suspended",
      resume() {
        fake.state = "running";
        return Promise.resolve();
      },
    };
    const root = document.createElement("div");
    document.body.append(root);
    mounted.push(side);
    side.unmount = mountChess(root, side.game, en, side.prefs, { sound: { create: () => fake as AudioContextLike, hidden: () => false, synth: (_c, name) => played.push(name) } });
    side.root = root;
    return { root, played };
  }

  it("plays one sound per event, by priority, only after a click in the frame, and none when muted", async () => {
    const solo = await startAlone();
    const { root, played } = withSounds(solo);
    await play({ white: solo }, "e2e4");
    expect(played, "before any activation").toEqual([]);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    await play({ white: solo }, "e7e5", "f1c4", "b8c6", "d1h5", "g8f6");
    expect(played).toEqual(["move", "move", "move", "move", "move"]);
    played.length = 0;
    // Mate with a capture: the game end alone.
    await play({ white: solo }, "h5f7");
    expect(played).toEqual(["end"]);
    // A step forward in the review plays that move's sound; a step back plays nothing.
    played.length = 0;
    navButton(root, "prev").click();
    expect(played).toEqual([]);
    navButton(root, "next").click();
    expect(played).toEqual(["check"]);

    // The mute button: pressed state, saved in this chat's prefs, and silence.
    const mute = root.querySelector<HTMLButtonElement>(".mute")!;
    // A drawn speaker, not an emoji: it shows without an emoji font, and follows forced colours.
    expect(mute.textContent).toBe("");
    expect(mute.querySelector("svg.speaker.on")!.getAttribute("aria-hidden")).toBe("true");
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    expect(mute.getAttribute("aria-label")).toBe("Sounds");
    mute.click();
    await tick();
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    expect(mute.querySelector("svg.speaker.off")).not.toBeNull();
    expect(JSON.parse(solo.broker.stored.get(PREFS_KEY)!).sound).toBe(false);
    played.length = 0;
    root.querySelector<HTMLButtonElement>(".actions button")!.click(); // New game
    await settle(solo);
    await play({ white: solo }, "e2e4", "d7d5", "e4d5");
    expect(played).toEqual([]);
  });

  it("plays capture, castle, promote and check, and the start when the toss gives a game", async () => {
    const { white, black } = await startChat();
    const { played } = withSounds(white);
    // A printable key is an activation.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    await tick();
    await play({ white, black }, "e2e4", "d7d5", "e4d5", "g8f6", "g1f3", "f6d5", "f1c4", "e7e6", "e1g1", "f8b4", "c2c3", "b4c3");
    expect(played).toEqual(["move", "move", "capture", "move", "move", "capture", "move", "move", "castle", "move", "move", "capture"]);
    played.length = 0;
    await play({ white, black }, "d1e2", "c3d2", "e2e6");
    expect(played).toEqual(["move", "capture", "check"]);
    // White resigns; then a new game: its start.
    played.length = 0;
    await white.game.resign();
    await settle(white, black);
    expect(played).toEqual(["end"]);
    await white.game.newGame();
    await settle(white, black);
    await agree(white, black);
    expect(played).toEqual(["end", "start"]);
  });

  it("Escape and Shift are not activations: silent until a later click", async () => {
    const solo = await startAlone();
    const { played } = withSounds(solo);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
    await tick();
    await play({ white: solo }, "e2e4");
    expect(played).toEqual([]);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    await play({ white: solo }, "e7e5");
    expect(played).toEqual(["move"]);
  });

  it("plays promote for a promotion", async () => {
    const solo = await startAlone();
    const { played } = withSounds(solo);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    await play({ white: solo }, "b2b4", "a7a5", "b4a5", "h7h6", "a5a6", "h6h5", "a6b7", "h5h4");
    played.length = 0;
    await play({ white: solo }, "b7a8q");
    expect(played).toEqual(["promote"]);
  });
});
