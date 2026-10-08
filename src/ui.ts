/**
 * The page: the board (board.ts) between two player strips, and a panel with the status, the opening, the moves, the
 * review bar and the controls (panel.ts). Plain DOM, no framework.
 *
 * The board is drawn from the review cursor (review.ts): the live game, or a past position while reviewing. What
 * belongs to the game itself reads the live game: the status line, whose turn the strips show, the controls, the
 * announcements and the sounds. So the contact's move still lands in the list, is read aloud and heard while the board
 * stays where the review is. The pieces each side took and the opening follow the board.
 *
 * Layout: the board's side is the largest multiple of 8 px that fits, so its squares leave no sub-pixel seam. The
 * panel stands beside the board when that leaves the board at least as big (a wide window), and below it otherwise (a
 * phone, Desktop's 560x640 chat-app window), where the moves are one scrolling row and the controls a bar.
 *
 * Below the board, the board is sized from the panel's reserved height (NARROW_PANEL), never from what the panel holds
 * at the moment: a draw offer, a notice, the opening's name or the first move must not resize the board under a
 * finger. The reserve holds the status, the side, the opening, the move row, the review bar, one row of controls and
 * one notice line; the contact's draw offer floats over the move row and the controls instead of taking a row of its
 * own, and the game-over card sits on the board.
 *
 * Keys: Left/Right step the review and Home/End go to its ends when focus is outside the board (the board keeps the
 * arrows for its squares); PageUp/PageDown step it from anywhere. A dialog keeps its keys.
 *
 * Stable for Ghostly's end-to-end tests: the .status and .side texts, and the squares (see board.ts).
 */
import type { ChessController, Notice, View } from "./game.ts";
import { createAnnouncer } from "./announce.ts";
import { Board } from "./board.ts";
import type { GameHistory, LastMove } from "./history.ts";
import { MAX_PLY, openingOf, type Opening } from "./openings.ts";
import { createGameOver, createMoveList, createReviewBar, moveWords, openPgnDialog, renderOpening, takenNode } from "./panel.ts";
import { pgnOfGame } from "./pgn.ts";
import { PrefsStore } from "./prefs.ts";
import { Review } from "./review.ts";
import { openSettings } from "./settings.ts";
import { soundOf, Sounds, type Seen, type SoundOptions } from "./sound.ts";
import type { StringKey, Strings } from "./strings.ts";

const NOTICE_KEY: Record<Notice, StringKey> = {
  "invalid-move": "notice_invalidMove",
  "bad-message": "notice_badMessage",
  "too-big": "notice_tooBig",
  "newer-version": "notice_newerVersion",
  "bad-reveal": "notice_badReveal",
  "toss-restarted": "notice_tossRestarted",
  "out-of-step": "notice_outOfStep",
  "peer-new-game": "notice_peerNewGame",
  "send-failed": "notice_sendFailed",
};
/** Notices that report what happened rather than a fault: they are announced politely, not as alerts. */
const INFO_NOTICES = new Set<Notice>(["toss-restarted", "peer-new-game"]);

/** The panel's width beside the board, and the smallest board side (24 px squares, WCAG 2.2's target size). */
const PANEL_WIDTH = 240;
const MIN_SIDE = 192;
const PAGE_PAD = 16;
const GAP = 8;
/**
 * The panel's reserved height below the board, in CSS pixels: what style.css gives each of its lines in the narrow
 * layout (status 20, side 18, opening 16, move row 30, review bar 32, controls 36, notices 18) and the 6 px between
 * them.
 */
export const NARROW_PANEL = 20 + 18 + 16 + 30 + 32 + 36 + 18 + 7 * 6;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The board side and where the panel goes, for a window of width × height. */
export function fitBoard(width: number, height: number, strips: number, panelBelow: number): { side: number; wide: boolean } {
  const floor8 = (n: number) => Math.max(MIN_SIDE, Math.floor(n / 8) * 8);
  const narrow = Math.min(width - PAGE_PAD, height - PAGE_PAD - strips - GAP - panelBelow);
  const wide = Math.min(width - PAGE_PAD - GAP * 2 - PANEL_WIDTH, height - PAGE_PAD - strips);
  if (wide >= MIN_SIDE && wide >= narrow) return { side: floor8(wide), wide: true };
  return { side: floor8(Math.min(narrow, width - PAGE_PAD)), wide: false };
}

/** A move in words, for the live region: "Your contact: knight to f6, check". */
export function sayMove(move: LastMove, who: string, view: View, t: Strings): string {
  return moveWords(move, who, t, view.inCheck, view.end?.why === "checkmate");
}

export interface MountOptions {
  /** For tests: the sound engine's parts (the context, the synthesizer, the page's visibility). */
  sound?: Partial<SoundOptions>;
}

export function mountChess(root: HTMLElement, game: ChessController, t: Strings, prefs: PrefsStore = new PrefsStore(null), options: MountOptions = {}): () => void {
  const app = el("main", "app");
  const play = el("div", "play");
  const top = el("div", "strip top");
  const bottom = el("div", "strip bottom");
  // Made before the page listens to the game: it checks its cursor against each change first.
  const review = new Review(game);
  const board = new Board(review, t, prefs);
  play.append(top, board.element, bottom);

  const panel = el("div", "panel");
  const status = el("p", "status");
  const side = el("p", "side");
  const opening = el("p", "opening");
  const moves = createMoveList(t, (ply) => review.go(ply));
  const reviewBar = createReviewBar(t, review);
  // The contact's draw offer: a card of its own in the controls. Below the board it floats up over the controls and the
  // move row instead of adding a row.
  const offerCard = el("div", "offer-card");
  offerCard.setAttribute("role", "group");
  offerCard.hidden = true;
  const navRow = el("div", "row navrow");
  const bar = el("div", "bar");
  const actions = el("div", "row actions");
  const tools = el("div", "tools");
  const tool = (className: string, text: string, label: string, run: () => void) => {
    const b = el("button", `act icon ${className}`, text);
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", run);
    return b;
  };
  const mute = tool("mute", "", t.sound, () => void prefs.set({ sound: !prefs.get().sound }));
  const flip = tool("flip", "⇅", t.flip, () => board.flip());
  const settings = tool("settings-btn", "⚙︎", t.settings, () => openSettings(app, prefs, t, settings));
  tools.append(mute, flip, settings);
  navRow.append(reviewBar.element, tools);
  bar.append(offerCard, actions);
  const notices = el("div", "notices");
  const notice = el("p", "notice");
  notice.setAttribute("role", "alert");
  const info = el("p", "notice info");
  notices.append(notice, info);
  panel.append(status, side, opening, moves.element, navRow, bar, notices);
  const announcer = createAnnouncer();
  app.append(play, panel, announcer.element);
  root.replaceChildren(app);

  const toMoves = () => {
    const target = moves.element.querySelector<HTMLButtonElement>('button[tabindex="0"]') ?? reviewBar.element.querySelector<HTMLButtonElement>("button:not([disabled])");
    target?.focus();
  };
  const copyPgn = (opener: HTMLElement) => openPgnDialog(app, pgnOfGame(game), t, opener);
  const gameOver = createGameOver(t, { newGame: () => void game.newGame(), copyPgn, review: toMoves });
  board.element.append(gameOver.element);

  const sounds = new Sounds({ enabled: () => prefs.get().sound, ...options.sound });

  let resignArmed = false;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPlies = -1;
  let lastEnd = "";
  let seen: Seen | null = null;
  let shownPly = -1;
  let openingFor: { record: GameHistory; at: number; opening: Opening | undefined } | null = null;

  function strip(node: HTMLElement, colour: "w" | "b", view: View, record: GameHistory, at: number): void {
    const name = view.phase === "alone" ? (colour === "w" ? t.whiteName : t.blackName) : view.me ? (colour === view.me ? t.you : t.contact) : node === bottom ? t.you : t.contact;
    const dot = el("span", `dot ${view.me || view.phase === "alone" ? colour : "unknown"}`);
    dot.setAttribute("aria-hidden", "true");
    const label = el("span", "name", name);
    const taken = record.taken(at)[colour];
    const material = record.material(at);
    const set = prefs.get().pieces;
    const key = `${name}|${dot.className}|${view.turn === colour && !view.end}|${taken.join("")}|${material}|${set}`;
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    node.classList.toggle("to-move", view.turn === colour && !view.end && view.phase !== "toss");
    node.replaceChildren(dot, label, takenNode(colour, taken, material, set, t));
  }

  function render(): void {
    const view = game.view();
    const shown = review.view();
    const record = game.record();
    const at = review.ply();
    const boardHadFocus = board.element.contains(document.activeElement);
    board.render(shown);
    board.element.classList.toggle("reviewing", review.reviewing());
    const down = board.orientation();
    strip(bottom, down, view, record, at);
    strip(top, down === "w" ? "b" : "w", view, record, at);
    status.textContent = statusText(view);
    side.textContent = view.me ? (view.me === "w" ? t.youAreWhite : t.youAreBlack) : "";
    if (openingFor?.record !== record || openingFor.at !== at) openingFor = { record, at, opening: openingOf(record.fens.slice(1, MAX_PLY + 1), at) };
    renderOpening(opening, openingFor.opening, t);
    moves.render(record, at);
    reviewBar.render(view.plies);
    renderActions(view);
    const sound = prefs.get().sound;
    mute.textContent = sound ? "\u{1F50A}" : "\u{1F507}";
    mute.setAttribute("aria-pressed", String(sound));
    const end = view.end;
    gameOver.render(view, end ? `${view.plies}|${end.why}|${end.result}|${record.fens[1] ?? ""}` : "", boardHadFocus);
    announce(view);
    // Sounds: a change of the live game; else a step forward of the review (no end sound for that).
    const live = soundOf(seen, view);
    if (live) sounds.play(live);
    else if (seen && view.plies === seen.plies && shown.plies === shownPly + 1) sounds.play(soundOf({ plies: shownPly, phase: shown.phase, ended: true }, shown));
    seen = { plies: view.plies, phase: view.phase, ended: Boolean(view.end) };
    shownPly = shown.plies;
  }

  function announce(view: View): void {
    if (lastPlies >= 0 && view.plies === lastPlies + 1 && view.lastMove) {
      const who = view.phase === "alone" ? (view.lastMove.colour === "w" ? t.whiteName : t.blackName) : view.lastMove.colour === view.me ? t.you : t.contact;
      announcer.say(sayMove(view.lastMove, who, view, t));
    }
    const end = view.end ? statusText(view) : "";
    if (lastPlies >= 0 && end && end !== lastEnd) announcer.say(end);
    lastEnd = end;
    lastPlies = view.plies;
  }

  function statusText(view: View): string {
    if (view.end) {
      const { result, why } = view.end;
      const head =
        result === "1/2-1/2" ? t.drawn : view.me ? ((result === "1-0") === (view.me === "w") ? t.won : t.lost) : result === "1-0" ? t.whiteWins : t.blackWins;
      return `${head}: ${t[`why_${why}`]}`;
    }
    const check = view.inCheck ? `. ${t.check}` : "";
    switch (view.phase) {
      case "loading":
        return t.loading;
      case "alone":
        return `${view.turn === "w" ? t.whiteToMove : t.blackToMove}${check}`;
      case "toss":
        return view.peerOpen ? t.tossing : t.waitingPeer;
      case "out-of-step":
        return t.outOfStep;
      default:
        if (!view.peerOpen) return t.away;
        return `${view.me === view.turn ? t.yourMove : t.theirMove}${check}`;
    }
  }

  const button = (label: string, run: (b: HTMLButtonElement) => void, className = "") => {
    const b = el("button", `act ${className}`.trim(), label);
    b.type = "button";
    b.addEventListener("click", () => run(b));
    return b;
  };

  function renderActions(view: View): void {
    const out: HTMLElement[] = [];
    const offered = view.phase === "playing" && view.drawOffer === "peer";
    const cardHadFocus = offerCard.contains(document.activeElement);
    if (offered !== !offerCard.hidden) {
      offerCard.replaceChildren(
        ...(offered
          ? [el("span", "offer", t.peerOffersDraw), button(t.accept, () => void game.answerDraw(true), "primary"), button(t.decline, () => void game.answerDraw(false))]
          : []),
      );
      offerCard.hidden = !offered;
    }
    const liveHadFocus = actions.querySelector(".live") === document.activeElement;
    if (review.reviewing()) out.push(button(t.backToLive, () => review.live(), "live"));
    if (view.phase === "alone" && view.plies > 0) out.push(button(t.newGame, () => void game.newGame()));
    if (view.phase === "playing") {
      const offer = button(view.drawOffer === "me" ? t.youOfferedDraw : t.offerDraw, () => void game.offerDraw());
      offer.disabled = view.drawOffer !== undefined || !view.peerOpen;
      out.push(offer);
      out.push(
        button(resignArmed ? t.resignSure : t.resign, () => {
          if (!resignArmed) {
            resignArmed = true;
            render();
            actions.querySelector<HTMLButtonElement>(".danger")?.focus();
            return;
          }
          resignArmed = false;
          void game.resign();
        }, "danger"),
      );
    } else resignArmed = false;
    if (view.phase === "over" || view.phase === "out-of-step") out.push(button(t.newGame, () => void game.newGame(), "primary"));
    if (view.end && view.phase !== "alone") out.push(button(t.copyPgn, (b) => copyPgn(b), "pgn-btn"));
    if (view.phase === "alone" && view.plies > 0) out.push(button(t.copyPgn, (b) => copyPgn(b), "pgn-btn"));
    const hadFocus = actions.contains(document.activeElement) || (cardHadFocus && offerCard.hidden);
    actions.replaceChildren(...out);
    if (liveHadFocus && !review.reviewing()) toMoves();
    else if (hadFocus) (actions.querySelector<HTMLButtonElement>(".danger") ?? actions.querySelector<HTMLButtonElement>("button"))?.focus();
  }

  // ---------- keys ----------

  function key(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".backdrop, .promo, input, textarea, select")) return;
    const page = event.key === "PageUp" || event.key === "PageDown";
    if (!page && target?.closest(".board")) return;
    const inList = moves.element.contains(document.activeElement);
    switch (event.key) {
      case "ArrowLeft":
      case "PageUp":
        review.prev();
        break;
      case "ArrowRight":
      case "PageDown":
        review.next();
        break;
      case "Home":
        review.first();
        break;
      case "End":
        review.live();
        break;
      default:
        return;
    }
    event.preventDefault();
    if (inList) toMoves();
  }
  document.addEventListener("keydown", key);

  // ---------- layout ----------

  function fit(): void {
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = window.innerHeight;
    if (!width || !height) return;
    const strips = (top.offsetHeight || 28) + (bottom.offsetHeight || 28) + GAP;
    const { side: px, wide } = fitBoard(width, height, strips, NARROW_PANEL);
    board.setSide(px);
    app.style.setProperty("--side", `${px}px`);
    const layout = wide ? "wide" : "narrow";
    if (app.dataset.layout !== layout) {
      app.dataset.layout = layout;
      moves.render(game.record(), review.ply());
    }
  }
  fit();
  window.addEventListener("resize", fit);

  const offChange = game.subscribe(render);
  const offReview = review.subscribe(render);
  const offPrefs = prefs.subscribe((p) => {
    board.setPrefs(p);
    render();
  });
  const offNotice = game.onNotice((n) => {
    const text = t[NOTICE_KEY[n]];
    const target = INFO_NOTICES.has(n) ? info : notice;
    target.textContent = text;
    if (target === info) announcer.say(text);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice.textContent = "";
      info.textContent = "";
    }, 6000);
  });
  render();
  return () => {
    offChange();
    offReview();
    offPrefs();
    offNotice();
    review.stop();
    sounds.stop();
    document.removeEventListener("keydown", key);
    window.removeEventListener("resize", fit);
    board.destroy();
    clearTimeout(noticeTimer);
  };
}
