/**
 * The game panel's parts: the move list (a button per move that takes the review there, as on chess.com), the review
 * bar, the opening name, the pieces each side took, the game-over card over the board, and the PGN dialog. Plain DOM;
 * ui.ts puts them in the page and feeds them.
 *
 * The move list is a labelled list: each move's button shows its SAN and is read with words too ("1. e4, White: pawn
 * to e4"). It
 * is one tab stop (the current move's button); Left/Right, Home/End and PageUp/PageDown move the review (ui.ts).
 * SAN and the move numbers are left to right in every language, so the list is too.
 */
import type { View } from "./game.ts";
import { openDialog, type Dialog } from "./dialog.ts";
import type { GameHistory, LastMove, Ply, Taken } from "./history.ts";
import type { Opening } from "./openings.ts";
import { glyph, pieceSvg, type PieceSet } from "./pieces.ts";
import type { Review } from "./review.ts";
import type { Strings } from "./strings.ts";

type Colour = "w" | "b";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function iconButton(className: string, text: string, label: string, run: () => void): HTMLButtonElement {
  const b = el("button", `act icon ${className}`, text);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", run);
  return b;
}

/** A move in words: "knight takes on f6, check", after "{who}: ". */
export function moveWords(move: LastMove, who: string, t: Strings, check: boolean, mate: boolean): string {
  const piece = t[`piece_${move.piece}`];
  let text = move.castle === "k" ? t.say_castleK : move.castle === "q" ? t.say_castleQ : move.captured ? t.say_capture : t.say_move;
  text = text.replace("{who}", who).replace("{piece}", piece).replace("{square}", move.to);
  if (move.promotion) text += `, ${t.say_promote.replace("{piece}", t[`piece_${move.promotion}`])}`;
  if (mate) text += `, ${t.say_mate}`;
  else if (check) text += `, ${t.say_check}`;
  return text;
}

/**
 * A ply of the move list, read aloud: "1. e4, White: pawn to e4". The name starts with the SAN the button shows, so
 * voice control ("click Nf3") finds it (WCAG 2.5.3, Label in Name).
 */
export function plyLabel(ply: Ply, index: number, t: Strings): string {
  const who = ply.colour === "w" ? t.whiteName : t.blackName;
  return `${Math.floor(index / 2) + 1}. ${ply.san}, ${moveWords(ply, who, t, ply.check, ply.mate)}`;
}

// ---------- the move list ----------

export interface MoveList {
  readonly element: HTMLOListElement;
  /** Shows the game's moves with `ply` (1 is white's first) as the current one; 0 is the start, no move current. */
  render(record: GameHistory, ply: number): void;
}

export function createMoveList(t: Strings, pick: (ply: number) => void): MoveList {
  const list = el("ol", "moves");
  list.setAttribute("aria-label", t.moves);
  list.dir = "ltr";
  list.hidden = true;
  const buttons: HTMLButtonElement[] = [];
  let shownFen = "";
  let current: HTMLButtonElement | null = null;

  list.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>("button[data-ply]");
    if (button && list.contains(button)) pick(Number(button.dataset.ply));
  });

  /** Scrolls the list (never the page) so the button shows: sideways below the board, down beside it. */
  function reveal(button: HTMLElement): void {
    const pad = 4;
    if (button.offsetTop < list.scrollTop) list.scrollTop = Math.max(0, button.offsetTop - pad);
    else if (button.offsetTop + button.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = button.offsetTop + button.offsetHeight - list.clientHeight + pad;
    if (button.offsetLeft < list.scrollLeft) list.scrollLeft = Math.max(0, button.offsetLeft - pad);
    else if (button.offsetLeft + button.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = button.offsetLeft + button.offsetWidth - list.clientWidth + pad;
  }

  function add(record: GameHistory, i: number): void {
    const ply = record.plies[i];
    const button = el("button", "san", ply.san);
    button.type = "button";
    button.dataset.ply = String(i + 1);
    button.tabIndex = -1;
    button.setAttribute("aria-label", plyLabel(ply, i, t));
    buttons.push(button);
    if (i % 2 === 0) {
      const li = el("li", "move");
      const no = el("span", "no", `${i / 2 + 1}.`);
      no.setAttribute("aria-hidden", "true");
      li.append(no, button);
      list.append(li);
    } else (list.lastElementChild ?? list).append(button);
  }

  return {
    element: list,
    render(record, ply) {
      const shown = buttons.length;
      // The same game with more moves: only the new ones are added. Anything else (a new game) starts afresh.
      if (shown > record.plies.length || record.fens[shown] !== shownFen) {
        buttons.length = 0;
        list.replaceChildren();
        current = null;
        for (let i = 0; i < record.plies.length; i++) add(record, i);
      } else for (let i = shown; i < record.plies.length; i++) add(record, i);
      shownFen = record.fens[record.plies.length];
      list.hidden = buttons.length === 0;
      const next = ply > 0 ? (buttons[ply - 1] ?? null) : null;
      const hadFocus = list.contains(document.activeElement);
      if (next !== current) {
        if (current) {
          current.classList.remove("current");
          current.removeAttribute("aria-current");
          current.tabIndex = -1;
        }
        current = next;
        if (current) {
          current.classList.add("current");
          current.setAttribute("aria-current", "step");
        }
      }
      // One tab stop: the current move, or the first when the review is at the start.
      for (const b of buttons) b.tabIndex = -1;
      const stop = current ?? buttons[0];
      if (stop) stop.tabIndex = 0;
      if (hadFocus) stop?.focus();
      if (current) reveal(current);
      else if (buttons[0]) list.scrollTop = list.scrollLeft = 0;
    },
  };
}

// ---------- the review bar ----------

export interface ReviewBar {
  readonly element: HTMLElement;
  render(plies: number): void;
}

/** `toLive` takes focus when » or › brought the review back to the live game and so went disabled under it. */
export function createReviewBar(t: Strings, review: Review, toLive?: () => void): ReviewBar {
  const bar = el("div", "nav");
  // A group, not a toolbar: each button is its own tab stop, and the arrow keys step the review (ui.ts).
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", t.nav);
  // Media controls are not mirrored in a right-to-left language.
  bar.dir = "ltr";
  const first = iconButton("nav-first", "«", t.nav_first, () => review.first());
  const prev = iconButton("nav-prev", "‹", t.nav_prev, () => review.prev());
  const play = iconButton("nav-play", "▶︎", t.nav_play, () => review.play());
  const next = iconButton("nav-next", "›", t.nav_next, () => review.next());
  const last = iconButton("nav-last", "»", t.nav_last, () => review.live());
  bar.append(first, prev, play, next, last);
  return {
    element: bar,
    render(plies) {
      const at = review.ply();
      const reviewing = review.reviewing();
      first.disabled = prev.disabled = at === 0;
      next.disabled = last.disabled = !reviewing;
      // While reviewing, » is the way back to the live game: marked, and named so.
      last.classList.toggle("live", reviewing);
      const lastLabel = reviewing ? t.backToLive : t.nav_last;
      last.title = lastLabel;
      last.setAttribute("aria-label", lastLabel);
      play.disabled = plies === 0;
      const playing = review.playing();
      play.textContent = playing ? "❚❚" : "▶︎";
      const label = playing ? t.nav_pause : t.nav_play;
      play.title = label;
      play.setAttribute("aria-label", label);
      // A button disabled under focus would drop it to the page: it goes to the next one that works.
      const focused = document.activeElement;
      if (focused instanceof HTMLButtonElement && focused.disabled && bar.contains(focused)) {
        if (toLive && (focused === last || focused === next)) toLive();
        else [...bar.querySelectorAll<HTMLButtonElement>("button")].find((b) => !b.disabled)?.focus();
      }
    },
  };
}

// ---------- the opening ----------

/** The opening's line: its name in English (data, not the app's words) and its ECO code. */
export function renderOpening(node: HTMLElement, opening: Opening | undefined, t: Strings): void {
  const key = opening ? `${opening.eco} ${opening.name}` : "";
  if (node.dataset.key === key) return;
  node.dataset.key = key;
  if (!opening) {
    node.replaceChildren();
    node.removeAttribute("title");
    return;
  }
  const label = el("span", "sr-only", `${t.opening}: `);
  const name = el("span", "opening-name");
  name.lang = "en";
  name.dir = "ltr";
  name.append(el("span", "eco", opening.eco), ` ${opening.name}`);
  node.title = `${opening.eco} ${opening.name}`;
  node.replaceChildren(label, name);
}

// ---------- captured pieces ----------

/** The pieces `colour` took, and its lead in material when it is ahead, for its player strip. */
export function takenNode(colour: Colour, taken: Taken[], material: number, set: PieceSet, t: Strings): HTMLElement {
  const node = el("span", "taken");
  const lead = colour === "w" ? material : -material;
  if (!taken.length && lead <= 0) return node;
  const words = taken.map((p) => t[`piece_${p}`]).join(", ");
  const spoken = [taken.length ? t.taken.replace("{pieces}", words) : "", lead > 0 ? t.ahead.replace("{n}", String(lead)) : ""].filter(Boolean).join(". ");
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", spoken);
  const theirs: Colour = colour === "w" ? "b" : "w";
  let previous = "";
  for (const p of taken) {
    const piece = el("span", `cap ${p === previous ? "same" : ""}`.trim());
    previous = p;
    if (set === "classic") {
      const text = el("span", `cap-glyph ${theirs}`, glyph(p));
      piece.append(text);
    } else piece.append(pieceSvg(`${theirs}${p}`));
    node.append(piece);
  }
  if (lead > 0) node.append(el("span", "lead", `+${lead}`));
  return node;
}

// ---------- the end of the game ----------

const capital = (text: string) => (text ? text[0].toLocaleUpperCase() + text.slice(1) : text);

/** The game-over card's words: the result for this side ("You win") and how the game ended ("Checkmate"). */
export function overText(view: View, t: Strings): { head: string; reason: string } | null {
  if (!view.end) return null;
  const { result, why } = view.end;
  const head = result === "*" ? t.noResult : result === "1/2-1/2" ? t.drawn : view.me ? ((result === "1-0") === (view.me === "w") ? t.won : t.lost) : result === "1-0" ? t.whiteWins : t.blackWins;
  return { head, reason: capital(t[`why_${why}`]) };
}

export interface GameOver {
  readonly element: HTMLElement;
  /** Shows the card for this ending, once: after Review it stays closed until another ending. */
  render(view: View, key: string, focusIt: boolean): void;
  close(): void;
}

export function createGameOver(t: Strings, actions: { newGame: () => void; copyPgn: (opener: HTMLElement) => void; review: () => void }): GameOver {
  const card = el("section", "over");
  card.hidden = true;
  const head = el("h2", "over-head");
  head.tabIndex = -1;
  head.id = "over-head";
  card.setAttribute("aria-labelledby", head.id);
  const reason = el("p", "over-reason");
  const row = el("div", "over-actions");
  const button = (label: string, className: string, run: (b: HTMLButtonElement) => void) => {
    const b = el("button", `act ${className}`, label);
    b.type = "button";
    b.addEventListener("click", () => run(b));
    return b;
  };
  let closedFor = "";
  let shownFor = "";
  /** Closes the card for this ending; `review` (Review, or focus inside it) hands over to the move list. */
  const close = (review: boolean) => {
    if (card.hidden) return;
    const hadFocus = card.contains(document.activeElement);
    closedFor = shownFor;
    card.hidden = true;
    if (review || hadFocus) actions.review();
  };
  const reviewButton = button(t.review, "over-review", () => close(true));
  row.append(button(t.newGame, "primary over-new", () => actions.newGame()), button(t.copyPgn, "over-pgn", (b) => actions.copyPgn(b)), reviewButton);
  card.append(head, reason, row);
  card.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    close(false);
  });
  return {
    element: card,
    render(view, key, focusIt) {
      const text = overText(view, t);
      if (!text || key === closedFor) {
        card.hidden = true;
        if (!text) closedFor = "";
        return;
      }
      // The board is left to right in every language; the card's words follow the page's direction.
      card.dir = document.documentElement.dir || "ltr";
      head.textContent = text.head;
      reason.textContent = text.reason;
      // A game that ended before its first move (a resignation) has nothing to review.
      reviewButton.hidden = view.plies === 0;
      const fresh = shownFor !== key || card.hidden;
      shownFor = key;
      card.hidden = false;
      if (fresh && focusIt) head.focus();
    },
    close: () => close(false),
  };
}

// ---------- the PGN dialog ----------

/**
 * The game's PGN in a read-only text box, already selected. Copy tries document.execCommand("copy") inside the click
 * (which keeps the user's activation), then the async clipboard; it says Copied only when one says it worked. A
 * sandboxed frame may refuse both (an opaque origin, no clipboard-write permission): the selected text is the way
 * that always works, and the dialog says so. iOS Safari may not select a read-only field from a script: when the
 * selection did not take, it is made again with the field briefly writable.
 */
export function openPgnDialog(host: HTMLElement, pgn: string, t: Strings, opener?: HTMLElement | null): Dialog {
  const dialog = openDialog(host, { title: t.pgnTitle, closeLabel: t.close, opener });
  dialog.element.classList.add("pgn");
  const text = el("textarea", "pgn-text");
  text.readOnly = true;
  text.value = pgn;
  text.rows = 10;
  text.spellcheck = false;
  text.dir = "ltr";
  text.setAttribute("aria-label", t.pgnTitle);
  const status = el("p", "hint pgn-status");
  status.setAttribute("role", "status");
  const copy = el("button", "act primary pgn-copy", t.copy);
  copy.type = "button";
  const selected = () => text.selectionStart === 0 && text.selectionEnd === text.value.length;
  const selectAll = () => {
    text.focus();
    text.select();
    text.setSelectionRange(0, text.value.length);
    if (selected()) return;
    text.readOnly = false;
    try {
      text.setSelectionRange(0, text.value.length);
    } finally {
      text.readOnly = true;
    }
  };
  copy.addEventListener("click", () => {
    selectAll();
    let done = false;
    try {
      done = typeof document.execCommand === "function" && document.execCommand("copy");
    } catch {
      done = false;
    }
    const say = (ok: boolean) => (status.textContent = ok ? t.copied : t.copyByHand);
    if (done) return say(true);
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== "function") return say(false);
    try {
      clipboard.writeText(pgn).then(
        () => say(true),
        () => {
          say(false);
          selectAll();
        },
      );
    } catch {
      say(false);
    }
  });
  dialog.body.append(text, copy, status);
  // Selected from the start, its headers in view.
  queueMicrotask(() => {
    selectAll();
    text.scrollTop = 0;
  });
  return dialog;
}
