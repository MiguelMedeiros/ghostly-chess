/**
 * The page: the board (board.ts) between two player strips, and a panel with the status, the moves and the controls.
 * Plain DOM, no framework.
 *
 * Layout: the board's side is the largest multiple of 8 px that fits, so its squares leave no sub-pixel seam. The
 * panel stands beside the board when that leaves the board at least as big (a wide window), and below it otherwise (a
 * phone, Desktop's 560x640 chat-app window), where the moves are one scrolling row and the controls a bar.
 *
 * Stable for Ghostly's end-to-end tests: the .status and .side texts, and the squares (see board.ts).
 */
import type { ChessController, LastMove, Notice, View } from "./game.ts";
import { createAnnouncer } from "./announce.ts";
import { Board } from "./board.ts";
import { PrefsStore } from "./prefs.ts";
import { openSettings } from "./settings.ts";
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
  const piece = t[`piece_${move.piece}`];
  let text =
    move.castle === "k" ? t.say_castleK : move.castle === "q" ? t.say_castleQ : move.captured ? t.say_capture : t.say_move;
  text = text.replace("{who}", who).replace("{piece}", piece).replace("{square}", move.to);
  if (move.promotion) text += `, ${t.say_promote.replace("{piece}", t[`piece_${move.promotion}`])}`;
  if (view.end?.why === "checkmate") text += `, ${t.say_mate}`;
  else if (view.inCheck) text += `, ${t.say_check}`;
  return text;
}

export function mountChess(root: HTMLElement, game: ChessController, t: Strings, prefs: PrefsStore = new PrefsStore(null)): () => void {
  const app = el("main", "app");
  const play = el("div", "play");
  const top = el("div", "strip top");
  const bottom = el("div", "strip bottom");
  const board = new Board(game, t, prefs);
  play.append(top, board.element, bottom);

  const panel = el("div", "panel");
  const status = el("p", "status");
  const side = el("p", "side");
  const moves = el("ol", "moves");
  moves.setAttribute("aria-label", t.moves);
  moves.tabIndex = 0;
  const bar = el("div", "bar");
  const actions = el("div", "row actions");
  const tools = el("div", "row tools");
  const flip = el("button", "act icon flip");
  flip.type = "button";
  flip.textContent = "⇅";
  flip.title = t.flip;
  flip.setAttribute("aria-label", t.flip);
  const settings = el("button", "act icon settings-btn");
  settings.type = "button";
  settings.textContent = "⚙︎";
  settings.title = t.settings;
  settings.setAttribute("aria-label", t.settings);
  tools.append(flip, settings);
  bar.append(actions, tools);
  const notice = el("p", "notice");
  notice.setAttribute("role", "alert");
  const info = el("p", "notice info");
  panel.append(status, side, moves, bar, notice, info);
  const announcer = createAnnouncer();
  app.append(play, panel, announcer.element);
  root.replaceChildren(app);

  let resignArmed = false;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPlies = -1;
  let lastEnd = "";
  let movesShown = -1;

  flip.addEventListener("click", () => board.flip());
  settings.addEventListener("click", () => openSettings(app, prefs, t, settings));

  function strip(node: HTMLElement, colour: "w" | "b", view: View): void {
    const name = view.phase === "alone" ? (colour === "w" ? t.whiteName : t.blackName) : view.me ? (colour === view.me ? t.you : t.contact) : node === bottom ? t.you : t.contact;
    const dot = el("span", `dot ${view.me || view.phase === "alone" ? colour : "unknown"}`);
    dot.setAttribute("aria-hidden", "true");
    const label = el("span", "name", name);
    const key = `${name}|${dot.className}|${view.turn === colour && !view.end}`;
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    node.classList.toggle("to-move", view.turn === colour && !view.end && view.phase !== "toss");
    node.replaceChildren(dot, label);
  }

  function render(): void {
    const view = game.view();
    board.render(view);
    const down = board.orientation();
    strip(bottom, down, view);
    strip(top, down === "w" ? "b" : "w", view);
    status.textContent = statusText(view);
    side.textContent = view.me ? (view.me === "w" ? t.youAreWhite : t.youAreBlack) : "";
    renderMoves(view);
    renderActions(view);
    announce(view);
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

  function renderMoves(view: View): void {
    if (view.plies === movesShown) return;
    movesShown = view.plies;
    const sans = game.history();
    const items: HTMLElement[] = [];
    for (let i = 0; i < sans.length; i += 2) {
      const li = el("li", "move");
      li.append(el("span", "no", `${i / 2 + 1}.`), el("span", `san${i === sans.length - 1 ? " current" : ""}`, sans[i]));
      if (sans[i + 1]) li.append(el("span", `san${i + 1 === sans.length - 1 ? " current" : ""}`, sans[i + 1]));
      items.push(li);
    }
    moves.replaceChildren(...items);
    moves.hidden = sans.length === 0;
    showNewestMove();
  }

  /** The newest move in view, in either layout (the row scrolls sideways, the column down). */
  function showNewestMove(): void {
    moves.scrollTop = moves.scrollHeight;
    moves.scrollLeft = document.documentElement.dir === "rtl" ? -moves.scrollWidth : moves.scrollWidth;
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

  const button = (label: string, run: () => void, className = "") => {
    const b = el("button", `act ${className}`.trim(), label);
    b.type = "button";
    b.addEventListener("click", run);
    return b;
  };

  function renderActions(view: View): void {
    const out: HTMLElement[] = [];
    if (view.phase === "alone" && view.plies > 0) out.push(button(t.newGame, () => void game.newGame()));
    if (view.phase === "playing") {
      if (view.drawOffer === "peer") {
        out.push(el("span", "offer", t.peerOffersDraw));
        out.push(button(t.accept, () => void game.answerDraw(true), "primary"));
        out.push(button(t.decline, () => void game.answerDraw(false)));
      } else {
        const offer = button(view.drawOffer === "me" ? t.youOfferedDraw : t.offerDraw, () => void game.offerDraw());
        offer.disabled = view.drawOffer === "me" || !view.peerOpen;
        out.push(offer);
      }
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
    const hadFocus = actions.contains(document.activeElement);
    actions.replaceChildren(...out);
    if (hadFocus) (actions.querySelector<HTMLButtonElement>(".danger") ?? actions.querySelector<HTMLButtonElement>("button"))?.focus();
  }

  // ---------- layout ----------

  let measuredPanel = 150;
  function fit(): void {
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = window.innerHeight;
    if (!width || !height) return;
    const strips = (top.offsetHeight || 28) + (bottom.offsetHeight || 28) + GAP;
    if (app.dataset.layout === "narrow" && panel.offsetHeight) measuredPanel = panel.offsetHeight;
    const { side: px, wide } = fitBoard(width, height, strips, measuredPanel);
    board.setSide(px);
    app.style.setProperty("--side", `${px}px`);
    const layout = wide ? "wide" : "narrow";
    if (app.dataset.layout !== layout) {
      app.dataset.layout = layout;
      showNewestMove();
    }
  }
  fit();
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => fit()) : null;
  observer?.observe(panel);
  window.addEventListener("resize", fit);

  const offChange = game.subscribe(render);
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
    offPrefs();
    offNotice();
    observer?.disconnect();
    window.removeEventListener("resize", fit);
    board.destroy();
    clearTimeout(noticeTimer);
  };
}
