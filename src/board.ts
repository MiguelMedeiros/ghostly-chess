/**
 * The board: squares, pieces, highlights, coordinates, orientation and input. Plain DOM, no framework.
 *
 * Squares are buttons (data-square, data-piece) in a grid. Each holds its piece twice: the glyph, in a visually hidden
 * span (the text Ghostly's end-to-end tests read, and what the Classic set shows), and the SVG drawing, aria-hidden.
 * An empty square holds nothing. The square's aria-label is what assistive tech reads, so nothing is read twice.
 *
 * A render compares each square with what it last wrote and touches only the squares that changed: a move rewrites
 * a handful of squares, never 64 drawings.
 *
 * Input: click a piece then its square, or drag it (pointer events, so mouse, pen and touch alike). Both go through
 * the controller's targets(). Keyboard: the board is one tab stop (a roving tabindex); arrows move between squares as
 * they are drawn, Home and End go to the ends of a row, Enter or Space picks a piece and then its square, Escape lets
 * go. The promotion picker opens over the promotion file, with focus on the queen.
 */
import type { Square } from "chess.js";
import type { ChessController, LastMove, View } from "./game.ts";
import { glyph, pieceSvg, type PieceSet } from "./pieces.ts";
import type { Prefs, PrefsStore } from "./prefs.ts";
import type { Strings } from "./strings.ts";

/** What the board reads and calls: the controller itself, or the review cursor over it (review.ts). */
export type BoardGame = Pick<ChessController, "view" | "board" | "targets" | "move">;

const FILES = "abcdefgh";
type Colour = "w" | "b";
type Promotion = "q" | "r" | "b" | "n";
const PROMOTIONS: Promotion[] = ["q", "r", "b", "n"];
/** How far a pointer moves before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** How long after a press its own click may still come (a touch's click is synthesized later than a mouse's). */
const CLICK_AFTER_PRESS_MS = 800;
const SLIDE_MS = 120;

/** What a square shows, as last written to it. */
interface Drawn {
  piece: string;
  set: PieceSet | "";
  className: string;
  label: string;
  selected: boolean;
  tabIndex: number;
}

interface Press {
  square: Square;
  pointerId: number;
  x: number;
  y: number;
  wasSelected: boolean;
  dragging: boolean;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

const isLight = (square: Square) => (FILES.indexOf(square[0]) + Number(square[1])) % 2 === 0;

/** Squares in drawing order, top row first, with `bottom` at the bottom. */
export function layout(bottom: Colour): Square[][] {
  const black = bottom === "b";
  return Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => `${FILES[black ? 7 - c : c]}${black ? r + 1 : 8 - r}` as Square));
}

/** [row, column] where a square is drawn, row 0 at the top. */
export function position(square: Square, bottom: Colour): [number, number] {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  return bottom === "b" ? [rank - 1, 7 - file] : [8 - rank, file];
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export class Board {
  /** The board and its overlays; size it with setSide. */
  readonly element: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly coords: HTMLElement;
  private readonly rows: HTMLElement[] = [];
  private readonly squares = new Map<Square, HTMLButtonElement>();
  private readonly drawn = new Map<Square, Drawn>();
  private readonly fileLabels: HTMLSpanElement[] = [];
  private readonly rankLabels: HTMLSpanElement[] = [];
  private prefs: Prefs;
  private bottom: Colour | null = null;
  private view: View;
  private selected: Square | null = null;
  private focus: Square = "e2";
  private press: Press | null = null;
  private dragFrom: Square | null = null;
  private hover: Square | null = null;
  private ghost: HTMLElement | null = null;
  /**
   * The last press a pointer made: the click the browser sends after it, on the same square, is that press again and
   * is skipped. A click with no pointer press before it (assistive tech, switch access, element.click()) is not.
   */
  private suppressClick: { square: Square; until: number } | null = null;
  private promotion: { from: Square; to: Square; element: HTMLElement } | null = null;
  /** The ply count after a dropped move: that move does not slide. */
  private noSlide = -1;
  private plies = -1;
  private side = 0;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly game: BoardGame,
    private readonly t: Strings,
    private readonly store: PrefsStore,
  ) {
    this.prefs = store.get();
    this.view = game.view();
    this.element = el("div", "board-wrap");
    this.grid = el("div", "board");
    this.grid.setAttribute("role", "grid");
    this.grid.setAttribute("aria-label", t.board);
    // A chessboard is never mirrored: a1 stays at white's bottom left in a right-to-left language too (the page takes
    // the language's direction, and the board's grid would follow it).
    this.grid.dir = "ltr";
    this.element.dir = "ltr";
    this.coords = el("div", "coords");
    this.coords.setAttribute("aria-hidden", "true");
    this.element.append(this.grid, this.coords);
    for (let r = 0; r < 8; r++) {
      const row = el("div", "rank");
      row.setAttribute("role", "row");
      this.rows.push(row);
      this.grid.append(row);
    }
    for (let rank = 1; rank <= 8; rank++) {
      for (const file of FILES) {
        const square = `${file}${rank}` as Square;
        const button = el("button", `sq ${isLight(square) ? "light" : "dark"}`);
        button.type = "button";
        button.setAttribute("role", "gridcell");
        button.dataset.square = square;
        button.dataset.piece = "";
        button.tabIndex = -1;
        this.squares.set(square, button);
      }
    }
    for (let i = 0; i < 8; i++) {
      const file = el("span", "coord file");
      file.style.gridRow = "8";
      file.style.gridColumn = String(i + 1);
      const rank = el("span", "coord rank-label");
      rank.style.gridRow = String(i + 1);
      rank.style.gridColumn = "1";
      this.fileLabels.push(file);
      this.rankLabels.push(rank);
      this.coords.append(file, rank);
    }
    this.listen();
  }

  // ---------- what the page calls ----------

  /** The colour drawn at the bottom. */
  orientation(): Colour {
    const base: Colour = this.view.me === "b" ? "b" : "w";
    return this.prefs.turned ? (base === "w" ? "b" : "w") : base;
  }

  /** Turns the board; the orientation is kept in this chat's settings. */
  flip(): void {
    void this.store.set({ turned: !this.prefs.turned });
  }

  /** The board's side in CSS pixels (a multiple of 8, so the squares leave no seam). */
  setSide(px: number): void {
    if (px === this.side) return;
    this.side = px;
    this.element.style.setProperty("--side", `${px}px`);
  }

  setPrefs(prefs: Prefs): void {
    this.prefs = prefs;
    this.render(this.game.view());
  }

  render(view: View): void {
    const previous = this.plies;
    this.view = view;
    const bottom = this.orientation();
    let refocus = false;
    if (bottom !== this.bottom) {
      this.bottom = bottom;
      layout(bottom).forEach((row, r) => this.rows[r].replaceChildren(...row.map((s) => this.squares.get(s)!)));
      // The keyboard starts on this side's king pawn: e7 when black is at the bottom, whenever the board turns there.
      // A focused e2 (focus handed to the board before the colours were known) hands it on, so it stays on the square
      // that takes Tab.
      if (bottom === "b" && this.focus === "e2") {
        refocus = this.squares.get("e2") === document.activeElement;
        this.focus = "e7";
      }
      this.drawCoords();
    }
    this.element.classList.toggle("classic", this.prefs.pieces === "classic");
    this.element.dataset.theme = this.prefs.theme;
    this.coords.hidden = !this.prefs.coords;
    if (this.selected && !view.canMove) this.selected = null;
    if (this.promotion && !view.canMove) this.closePromotion(false);
    this.drawSquares();
    if (refocus) this.squares.get(this.focus)?.focus();
    this.grid.classList.toggle("locked", !view.canMove);
    this.plies = view.plies;
    if (previous >= 0 && view.plies === previous + 1 && view.lastMove && view.plies !== this.noSlide) this.slide(view.lastMove);
  }

  destroy(): void {
    for (const off of this.offs.splice(0)) off();
    this.endDrag();
  }

  // ---------- drawing ----------

  private drawCoords(): void {
    const bottom = this.bottom ?? "w";
    const order = layout(bottom);
    for (let i = 0; i < 8; i++) {
      const fileSquare = order[7][i];
      this.fileLabels[i].textContent = fileSquare[0];
      // In the colour of the other square colour, so it reads on the square it sits on.
      this.fileLabels[i].className = `coord file ${isLight(fileSquare) ? "on-light" : "on-dark"}`;
      const rankSquare = order[i][0];
      this.rankLabels[i].textContent = rankSquare[1];
      this.rankLabels[i].className = `coord rank-label ${isLight(rankSquare) ? "on-light" : "on-dark"}`;
    }
  }

  private drawSquares(): void {
    const view = this.view;
    const t = this.t;
    const targets = this.selected ? this.game.targets(this.selected) : [];
    const targetSet = new Set(targets.map((m) => m.to));
    const showTargets = this.prefs.legal;
    const grid = this.game.board();
    const set: PieceSet = this.prefs.pieces;
    for (const [square, button] of this.squares) {
      const piece = grid[8 - Number(square[1])][FILES.indexOf(square[0])];
      const key = piece ? `${piece.color}${piece.type}` : "";
      const last = Boolean(view.lastMove && (view.lastMove.from === square || view.lastMove.to === square));
      const target = targetSet.has(square);
      const classes = ["sq", isLight(square) ? "light" : "dark"];
      if (piece) classes.push(piece.color);
      if (square === this.selected) classes.push("selected");
      if (target && showTargets) classes.push(piece ? "target capture" : "target");
      if (last) classes.push("last");
      if (view.inCheck && piece?.type === "k" && piece.color === view.turn) classes.push("check");
      if (square === this.dragFrom) classes.push("dragging");
      if (square === this.hover) classes.push("hover"); // last: markHover relies on it
      const parts = [square, piece ? t.piece.replace("{colour}", piece.color === "w" ? t.white : t.black).replace("{piece}", t[`piece_${piece.type}`]) : t.empty];
      if (square === this.selected) parts.push(t.selected);
      if (target) parts.push(t.canMoveHere);
      if (last) parts.push(t.lastMove);
      const next: Drawn = {
        piece: key,
        set: key ? set : "",
        className: classes.join(" "),
        label: parts.join(", "),
        selected: square === this.selected,
        tabIndex: square === this.focus ? 0 : -1,
      };
      const before = this.drawn.get(square);
      if (!before || before.piece !== next.piece || before.set !== next.set) {
        button.dataset.piece = key;
        if (!piece) button.replaceChildren();
        else {
          const text = el("span", "glyph");
          text.textContent = glyph(piece.type);
          text.setAttribute("aria-hidden", "true");
          button.replaceChildren(...(set === "classic" ? [text] : [text, pieceSvg(key)]));
        }
      }
      if (before?.className !== next.className) button.className = next.className;
      if (before?.label !== next.label) button.setAttribute("aria-label", next.label);
      if (before?.selected !== next.selected) button.setAttribute("aria-selected", String(next.selected));
      if (before?.tabIndex !== next.tabIndex) button.tabIndex = next.tabIndex;
      this.drawn.set(square, next);
    }
  }

  /** The piece that just moved glides from its square (and the rook with a castling king). */
  private slide(move: LastMove): void {
    if (reducedMotion() || !this.side) return;
    const bottom = this.bottom ?? "w";
    const glide = (from: Square, to: Square) => {
      const node = this.squares.get(to)?.lastElementChild as HTMLElement | null;
      if (!node || typeof node.animate !== "function") return;
      const [r1, c1] = position(from, bottom);
      const [r2, c2] = position(to, bottom);
      const size = this.side / 8;
      node.animate([{ transform: `translate(${(c1 - c2) * size}px, ${(r1 - r2) * size}px)` }, { transform: "none" }], { duration: SLIDE_MS, easing: "ease-out" });
    };
    glide(move.from, move.to);
    if (move.castle) {
      const rank = move.to[1];
      glide(`${move.castle === "k" ? "h" : "a"}${rank}` as Square, `${move.castle === "k" ? "f" : "d"}${rank}` as Square);
    }
  }

  // ---------- input ----------

  private listen(): void {
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Document, type: K, handler: (event: HTMLElementEventMap[K]) => void) => {
      target.addEventListener(type, handler as EventListener);
      this.offs.push(() => target.removeEventListener(type, handler as EventListener));
    };
    on(this.grid, "pointerdown", (e) => this.pointerDown(e));
    on(this.grid, "pointermove", (e) => this.pointerMove(e));
    on(this.grid, "pointerup", (e) => this.pointerUp(e));
    on(this.grid, "pointercancel", (e) => this.pointerCancel(e));
    // Only the board's own capture: a touch is captured by its square at first (implicit capture), and moving that
    // capture to the board makes the square lose it, which is not the end of the drag.
    on(this.grid, "lostpointercapture", (e) => {
      if (e.target === this.grid) this.pointerCancel(e);
    });
    on(this.grid, "click", (e) => {
      const square = this.squareOf(e.target);
      const skip = this.suppressClick;
      this.suppressClick = null;
      // detail is 0 for a click no pointer made (element.click(), a screen reader's activation).
      if (skip && e.detail > 0 && e.timeStamp < skip.until && square === skip.square) return;
      if (square) this.activate(square);
    });
    // A press released off the board before it became a drag (nothing captured it yet), or a window that lost focus
    // mid-press: the press ends there, or the board would wait for a pointerup that never comes.
    const offBoard = (e: PointerEvent) => {
      if (this.press && e.pointerId === this.press.pointerId && !this.grid.contains(e.target as Node)) this.pointerCancel(e);
    };
    on(document, "pointerup", offBoard);
    on(document, "pointercancel", offBoard);
    const blur = () => {
      if (!this.press) return;
      this.press = null;
      this.endDrag();
      this.render(this.game.view());
    };
    window.addEventListener("blur", blur);
    this.offs.push(() => window.removeEventListener("blur", blur));
    on(this.grid, "keydown", (e) => this.key(e));
    on(this.grid, "contextmenu", (e) => {
      if (this.press) e.preventDefault();
    });
  }

  private squareOf(target: EventTarget | null): Square | null {
    return ((target as HTMLElement | null)?.closest?.<HTMLElement>(".sq")?.dataset.square as Square | undefined) ?? null;
  }

  /** The square under a point of the viewport, from the board's geometry (a captured pointer's target is its source). */
  private squareAt(event: PointerEvent): Square | null {
    const rect = this.grid.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const c = Math.floor(((event.clientX - rect.left) / rect.width) * 8);
      const r = Math.floor(((event.clientY - rect.top) / rect.height) * 8);
      if (r < 0 || r > 7 || c < 0 || c > 7) return null;
      return layout(this.bottom ?? "w")[r][c];
    }
    return this.squareOf(event.target);
  }

  private pointerDown(event: PointerEvent): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const square = this.squareOf(event.target);
    if (!square || this.press) return;
    // Set before any way out: whatever this press did, the click that follows it on this square is the same press.
    this.suppressClick = { square, until: event.timeStamp + CLICK_AFTER_PRESS_MS };
    if (this.promotion) return;
    this.focus = square;
    const view = this.game.view();
    if (!view.canMove) return this.render(view);
    if (this.selected && this.selected !== square && this.game.targets(this.selected).some((m) => m.to === square)) {
      this.play(this.selected, square, false);
      return;
    }
    if (this.game.targets(square).length) {
      const wasSelected = this.selected === square;
      this.selected = square;
      this.press = { square, pointerId: event.pointerId, x: event.clientX, y: event.clientY, wasSelected, dragging: false };
      this.render(view);
      return;
    }
    this.selected = null;
    this.render(view);
  }

  private pointerMove(event: PointerEvent): void {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    if (!press.dragging) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD_PX) return;
      this.startDrag(press, event);
    }
    this.moveGhost(event);
    const over = this.squareAt(event);
    if (over !== this.hover) {
      const was = this.hover;
      this.hover = over;
      // Only the two squares change, without a full draw: a long game makes each draw cost a replay of its moves.
      if (was) this.markHover(was, false);
      if (over) this.markHover(over, true);
    }
  }

  /** Sets one square's hover mark, and keeps what it last wrote in step ("hover" is always its last class). */
  private markHover(square: Square, on: boolean): void {
    const button = this.squares.get(square);
    const drawn = this.drawn.get(square);
    if (!button || !drawn) return;
    button.classList.toggle("hover", on);
    const base = drawn.className.replace(/ hover$/, "");
    drawn.className = on ? `${base} hover` : base;
  }

  private pointerUp(event: PointerEvent): void {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    this.press = null;
    // The click comes after the pointerup: a press held long still skips its own click.
    this.suppressClick = { square: press.square, until: event.timeStamp + CLICK_AFTER_PRESS_MS };
    if (!press.dragging) {
      // A press and release on the selected piece lets go of it, as a second click did.
      if (press.wasSelected) {
        this.selected = null;
        this.render(this.game.view());
      }
      return;
    }
    const to = this.squareAt(event);
    this.endDrag();
    if (to && to !== press.square && this.game.targets(press.square).some((m) => m.to === to)) this.play(press.square, to, true);
    else this.render(this.game.view()); // snaps back; the piece stays picked
  }

  private pointerCancel(event: PointerEvent): void {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    this.press = null;
    this.endDrag();
    this.render(this.game.view());
  }

  private startDrag(press: Press, event: PointerEvent): void {
    press.dragging = true;
    try {
      this.grid.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is gone already: the drag still follows it while it lasts.
    }
    const source = this.squares.get(press.square)!;
    const ghost = el("div", "ghost");
    const piece = source.dataset.piece ?? "";
    if (this.prefs.pieces === "classic") {
      const text = el("span", `glyph ${piece[0]}`);
      text.textContent = glyph(piece[1]);
      ghost.append(text);
    } else ghost.append(pieceSvg(piece));
    ghost.setAttribute("aria-hidden", "true");
    this.ghost = ghost;
    this.element.append(ghost);
    this.dragFrom = press.square;
    this.drawSquares();
  }

  private moveGhost(event: PointerEvent): void {
    if (!this.ghost) return;
    const rect = this.element.getBoundingClientRect();
    const half = this.side / 16;
    this.ghost.style.transform = `translate(${event.clientX - rect.left - half}px, ${event.clientY - rect.top - half}px)`;
  }

  private endDrag(): void {
    this.ghost?.remove();
    this.ghost = null;
    this.dragFrom = null;
    this.hover = null;
  }

  /** A click, or Enter/Space: pick a piece, then its square. */
  private activate(square: Square): void {
    this.focus = square;
    const view = this.game.view();
    if (!view.canMove || this.promotion) return this.render(view);
    if (this.selected && this.game.targets(this.selected).some((m) => m.to === square)) return this.play(this.selected, square, false);
    this.selected = this.selected !== square && this.game.targets(square).length ? square : null;
    this.render(view);
  }

  /** Plays from → to (a legal target), asking for the promotion piece when it promotes. */
  private play(from: Square, to: Square, dropped: boolean): void {
    const target = this.game.targets(from).find((m) => m.to === to);
    if (!target) return;
    this.focus = to;
    if (target.promotion && !this.prefs.autoQueen) {
      this.openPromotion(from, to);
      return;
    }
    this.selected = null;
    if (dropped) this.noSlide = this.view.plies + 1;
    void this.game.move(from, to, target.promotion ? "q" : undefined);
    this.render(this.game.view());
  }

  private key(event: KeyboardEvent): void {
    if (this.promotion) return;
    const bottom = this.bottom ?? "w";
    let [r, c] = position(this.focus, bottom);
    switch (event.key) {
      case "ArrowUp": r = Math.max(0, r - 1); break;
      case "ArrowDown": r = Math.min(7, r + 1); break;
      case "ArrowLeft": c = Math.max(0, c - 1); break;
      case "ArrowRight": c = Math.min(7, c + 1); break;
      case "Home": c = 0; break;
      case "End": c = 7; break;
      case "Enter":
      case " ":
        event.preventDefault();
        return this.activate(this.focus);
      case "Escape":
        this.selected = null;
        return this.render(this.game.view());
      default:
        return;
    }
    event.preventDefault();
    this.focus = layout(bottom)[r][c];
    this.render(this.game.view());
    this.squares.get(this.focus)?.focus();
  }

  // ---------- promotion ----------

  private openPromotion(from: Square, to: Square): void {
    this.closePromotion(false);
    const colour = this.view.turn;
    const bottom = this.bottom ?? "w";
    const [row, col] = position(to, bottom);
    const down = row === 0; // the picker grows from the edge into the board
    const overlay = el("div", "promo");
    overlay.setAttribute("role", "group");
    overlay.setAttribute("aria-label", this.t.promoteTo);
    const shade = el("div", "promo-shade");
    shade.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.closePromotion(true);
    });
    const column = el("div", `promo-col ${down ? "down" : "up"}`);
    column.style.left = `${col * 12.5}%`;
    if (down) column.style.top = "0";
    else column.style.bottom = "0";
    const buttons = PROMOTIONS.map((p) => {
      const b = el("button", `promo-choice ${colour}`);
      b.type = "button";
      b.dataset.promote = p;
      b.setAttribute("aria-label", this.t[`piece_${p}`]);
      if (this.prefs.pieces === "classic") {
        const text = el("span", "glyph");
        text.textContent = glyph(p);
        text.setAttribute("aria-hidden", "true");
        b.append(text);
      } else b.append(pieceSvg(`${colour}${p}`));
      b.addEventListener("click", () => this.choose(p));
      return b;
    });
    if (!down) buttons.reverse();
    const cancel = el("button", "promo-cancel");
    cancel.type = "button";
    cancel.textContent = "×";
    cancel.setAttribute("aria-label", this.t.cancel);
    cancel.addEventListener("click", () => this.closePromotion(true));
    if (down) column.append(...buttons, cancel);
    else column.append(cancel, ...buttons);
    overlay.append(shade, column);
    overlay.addEventListener("keydown", (e) => {
      const items = [...column.querySelectorAll<HTMLButtonElement>("button")];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closePromotion(true);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab") {
        e.preventDefault();
        const step = e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1;
        items[(at + step + items.length) % items.length]?.focus();
      }
    });
    this.promotion = { from, to, element: overlay };
    this.element.append(overlay);
    (column.querySelector<HTMLButtonElement>('[data-promote="q"]') ?? buttons[0]).focus();
  }

  private choose(piece: Promotion): void {
    const pending = this.promotion;
    if (!pending) return;
    this.closePromotion(false);
    this.selected = null;
    void this.game.move(pending.from, pending.to, piece);
    this.render(this.game.view());
    this.squares.get(this.focus)?.focus();
  }

  private closePromotion(refocus: boolean): void {
    const pending = this.promotion;
    if (!pending) return;
    this.promotion = null;
    pending.element.remove();
    if (refocus) {
      this.selected = null;
      this.focus = pending.from;
      this.render(this.game.view());
      this.squares.get(this.focus)?.focus();
    }
  }
}
