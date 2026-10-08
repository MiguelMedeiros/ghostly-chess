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
 * one notice line; the contact's draw offer or takeback ask floats over the move row and the controls instead of
 * taking a row of its own, and the game-over card (with Rematch in a chat) sits on the board.
 *
 * The controls: ↶ (take back, an icon so they stay one row), Offer draw, and Resign, which asks in a dialog; before
 * ply 2, Abort replaces Resign. A control whose feature the contact's Chess lacks is off, its title saying why.
 *
 * Keys: Left/Right step the review and Home/End go to its ends when focus is outside the board (the board keeps the
 * arrows for its squares); PageUp/PageDown step it from anywhere. A dialog keeps its keys.
 *
 * Below the notices, one standing line (hidden while a notice shows): in a timed game, a pending claim or that the
 * contact's Chess isn't answering (its strip keeps its name, marked); that this side may still move while the contact's
 * Chess is closed, that an invitation waits for the contact, or, with Chess 1.0.2 (version 1), what the contact's
 * version lacks, with the details behind ⓘ. The new-game panel and the contact's invitation are cards on the board
 * (setup.ts), so the board keeps its size. While the contact's invitation shows, .status says it, and it is announced
 * when it comes; a card that hides under focus hands it to the invitation's button or the board.
 *
 * Clocks (a timed game): each strip ends with its side's clock, m:ss with tenths under 20 s, the running one marked.
 * The contact's is an estimate from this side's own send. The page calls the game's tick() a few times a second while
 * a timed game goes on, which flags, acks and notices silence; this side's clock turns red and the low-time sound
 * plays once at 20 s (10 s in bullet), and a screen reader hears 30 s and 10 s left.
 *
 * Names (2.3.0): each strip shows its player's name (this side's own from context(), the contact's from its hello)
 * beside a disc with the initials, or "You" / "Your contact" without one; the contact's moves are read aloud with its
 * name. Names are text only (textContent).
 *
 * Stable for Ghostly's end-to-end tests: the .status and .side texts, and the squares (see board.ts). .status keeps
 * 1.0.2's words, also while this side may still move with the contact away: the hint is a line of its own.
 */
import type { ChessController, Notice, View } from "./game.ts";
import { createAnnouncer } from "./announce.ts";
import { formatClock, lowTimeMs } from "./clock.ts";
import { Board } from "./board.ts";
import { openDialog } from "./dialog.ts";
import { OWN_FEATURES } from "./game.ts";
import type { GameHistory, LastMove } from "./history.ts";
import { initials } from "./names.ts";
import { MAX_PLY, openingOf, type Opening } from "./openings.ts";
import { createGameOver, createMoveList, createReviewBar, fill, moveWords, openPgnDialog, renderOpening, takenNode } from "./panel.ts";
import { pgnOfGame } from "./pgn.ts";
import { SVG_NS } from "./pieces.ts";
import { PrefsStore } from "./prefs.ts";
import { Premove } from "./premove.ts";
import { Review } from "./review.ts";
import { openSettings } from "./settings.ts";
import { createSetup, invitationWords } from "./setup.ts";
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
  declined: "notice_declined",
  "clock-off": "notice_clockOff",
  "taken-back": "takenBack",
  "takeback-declined": "notice_takebackDeclined",
};
/** Notices that report what happened rather than a fault: they are announced politely, not as alerts. */
const INFO_NOTICES = new Set<Notice>(["toss-restarted", "peer-new-game", "declined", "taken-back", "takeback-declined"]);

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

/** The standing line's words for a view, if any: see the module comment. */
export function standingText(view: View, t: Strings): { text: string; details: boolean } | null {
  if (view.pendingClaim) return { text: t.pendingClaim, details: false };
  if (view.peerSilent) return { text: t.peerSilent, details: false };
  if (view.phase === "playing" && !view.peerOpen && view.canMove) return { text: t.canStillMove, details: false };
  if (view.phase === "invited" && !view.peerOpen) return { text: t.invitedAway, details: false };
  if (view.peerOpen && view.mode === "v1" && view.phase !== "alone" && view.phase !== "loading") {
    return { text: view.peerVersion ? fill(t.compatBanner, { version: view.peerVersion }) : t.compatBannerOld, details: true };
  }
  return null;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * The mute button's speaker, on or crossed out: inline SVG in currentColor (built with createElementNS, as the pieces
 * are), so it shows without an emoji font and follows forced colours. The button carries the name and pressed state.
 */
export function speakerIcon(on: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("speaker", on ? "on" : "off");
  const path = (d: string, stroke: boolean) => {
    const node = document.createElementNS(SVG_NS, "path");
    node.setAttribute("d", d);
    if (stroke) {
      node.setAttribute("fill", "none");
      node.setAttribute("stroke", "currentColor");
      node.setAttribute("stroke-width", "2");
      node.setAttribute("stroke-linecap", "round");
    } else node.setAttribute("fill", "currentColor");
    svg.append(node);
  };
  path("M3 9h4l5-4v14l-5-4H3z", false);
  if (on) {
    path("M15.5 9a4.5 4.5 0 0 1 0 6", true);
    path("M18 6.5a8 8 0 0 1 0 11", true);
  } else path("M15.5 9.5l5 5M20.5 9.5l-5 5", true);
  return svg;
}

/** The board side and where the panel goes, for a window of width × height. */
export function fitBoard(width: number, height: number, strips: number, panelBelow: number): { side: number; wide: boolean } {
  const floor8 = (n: number) => Math.max(MIN_SIDE, Math.floor(n / 8) * 8);
  const narrow = Math.min(width - PAGE_PAD, height - PAGE_PAD - strips - GAP - panelBelow);
  const wide = Math.min(width - PAGE_PAD - GAP * 2 - PANEL_WIDTH, height - PAGE_PAD - strips);
  if (wide >= MIN_SIDE && wide >= narrow) return { side: floor8(wide), wide: true };
  return { side: floor8(Math.min(narrow, width - PAGE_PAD)), wide: false };
}

/**
 * Why a control that needs a feature is off, or undefined when both sides named it: "Your contact needs to update
 * Chess (they have 2.1.0)".
 */
export function featureHint(view: View, feature: string, t: Strings): string | undefined {
  if (view.features.includes(feature)) return undefined;
  return view.peerVersion ? fill(t.needsUpdate, { version: view.peerVersion }) : t.needsUpdateOld;
}

/** The ply index the standing draw offer's ½ shows at: the offerer's move it stands through, once that is made. */
export function drawChip(view: View): number | undefined {
  if (view.drawAt === undefined || !view.me) return undefined;
  const offerer = view.drawOffer === "me" ? view.me : view.me === "w" ? "b" : "w";
  const before = view.drawAt - 1;
  return before >= 0 && (before % 2 === 0) === (offerer === "w") ? before : view.drawAt;
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
  // Each strip's clock: kept across the strip's redraws, its text set on every tick.
  const clockOf = new Map<HTMLElement, HTMLElement>();
  for (const node of [top, bottom]) {
    const clock = el("span", "clock");
    clock.setAttribute("role", "timer");
    clock.dir = "ltr";
    clock.hidden = true;
    clockOf.set(node, clock);
  }
  // Made before the page listens to the game: it checks its cursor against each change first.
  const review = new Review(game);
  const premove = new Premove(game, () => prefs.get().premove);
  const board = new Board(review, t, prefs, premove);
  play.append(top, board.element, bottom);

  const panel = el("div", "panel");
  const status = el("p", "status");
  const side = el("p", "side");
  const opening = el("p", "opening");
  const moves = createMoveList(t, (ply) => review.go(ply));
  const reviewBar = createReviewBar(t, review, () => toMoves());
  // The contact's draw offer or takeback ask: a card of its own in the controls. Below the board it floats up over the
  // controls and the move row instead of adding a row.
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
  const standing = el("p", "standing");
  const standingWords = el("span", "standing-text");
  const details = el("button", "info-btn", "ⓘ");
  details.type = "button";
  details.title = t.compatInfo;
  details.setAttribute("aria-label", t.compatInfo);
  details.addEventListener("click", () => {
    const dialog = openDialog(app, { title: t.compatInfo, closeLabel: t.close, opener: details });
    dialog.body.append(el("p", "dialog-text", t.compatDetails));
  });
  standing.append(standingWords, details);
  standing.hidden = true;
  notices.append(notice, info, standing);
  panel.append(status, side, opening, moves.element, navRow, bar, notices);
  const announcer = createAnnouncer();
  app.append(play, panel, announcer.element);
  root.replaceChildren(app);

  const toMoves = () => {
    const target =
      moves.element.querySelector<HTMLButtonElement>('button[tabindex="0"]') ??
      reviewBar.element.querySelector<HTMLButtonElement>("button:not([disabled])") ??
      actions.querySelector<HTMLButtonElement>("button");
    target?.focus();
  };
  const copyPgn = (opener: HTMLElement) => openPgnDialog(app, pgnOfGame(game), t, opener);
  const gameOver = createGameOver(t, { newGame: () => void game.newGame(), rematch: () => void game.rematch(), copyPgn, review: toMoves });
  board.element.append(gameOver.element);
  const cards = createSetup(t, OWN_FEATURES, {
    invite: (tc) => void game.invite(tc),
    accept: () => void game.acceptInvitation(),
    decline: () => void game.declineInvitation(),
  });
  board.element.append(cards.setup, cards.invitation);

  const sounds = new Sounds({ enabled: () => prefs.get().sound, ...options.sound });

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPlies = -1;
  let lastEnd = "";
  let lastInvitation = "";
  let lastAsk = "";
  let seen: Seen | null = null;
  let shownPly = -1;
  let openingFor: { record: GameHistory; at: number; opening: Opening | undefined } | null = null;

  function strip(node: HTMLElement, colour: "w" | "b", view: View, record: GameHistory, at: number): void {
    const mine = view.me ? colour === view.me : node === bottom;
    // The person's own name, or the contact's from its hello; the words when there is none (no `name` permission).
    const known = view.phase === "alone" ? undefined : mine ? view.ownName : view.peerName;
    const name = view.phase === "alone" ? (colour === "w" ? t.whiteName : t.blackName) : known ?? (mine ? t.you : t.contact);
    // The colour disc, with the initials when the name is known: there is no avatar API.
    const dot = el("span", `dot ${view.me || view.phase === "alone" ? colour : "unknown"}`, known && initials(known));
    dot.setAttribute("aria-hidden", "true");
    // A timed game, the contact silent on its turn: its clock turns muted, and the standing line says why.
    const silent = Boolean(view.peerSilent && view.me && colour !== view.me);
    const label = el("span", "name", name);
    label.dir = "auto";
    // With a name shown, a screen reader still hears whose strip it is ("You", "Your contact"): two players can share a name.
    const whose = known ? el("span", "sr-only", mine ? t.you : t.contact) : "";
    const taken = record.taken(at)[colour];
    const material = record.material(at);
    const set = prefs.get().pieces;
    const key = `${name}|${dot.className}|${view.turn === colour && !view.end}|${taken.join("")}|${material}|${set}|${silent}`;
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    node.classList.toggle("to-move", view.turn === colour && !view.end && view.phase !== "toss");
    node.classList.toggle("silent", silent);
    node.replaceChildren(dot, whose, label, takenNode(colour, taken, material, set, t), clockOf.get(node)!);
  }

  // ---------- clocks ----------

  let ticker: ReturnType<typeof setInterval> | undefined;
  let lowPlayed = false;
  let said = new Set<number>();
  let clockPlies = -1;

  /** Both clocks' text, and this side's low-time warning, from the game's clocks now. */
  function renderClocks(): void {
    const view = game.view();
    const clocks = game.clocks();
    // A new game (fewer plies than before) warns again.
    if (view.plies < clockPlies) {
      lowPlayed = false;
      said = new Set();
    }
    clockPlies = view.plies;
    const down = board.orientation();
    for (const [node, colour] of [
      [bottom, down],
      [top, down === "w" ? "b" : "w"],
    ] as const) {
      const clock = clockOf.get(node)!;
      clock.hidden = !clocks;
      if (!clocks || !view.tc) continue;
      const text = formatClock(clocks[colour]);
      if (clock.textContent !== text) clock.textContent = text;
      clock.classList.toggle("running", clocks.running === colour);
      clock.classList.toggle("low", clocks[colour] < lowTimeMs(view.tc));
    }
    if (!clocks || !view.tc || !view.me || clocks.running !== view.me) return;
    const left = clocks[view.me];
    if (left < lowTimeMs(view.tc) && !lowPlayed) {
      lowPlayed = true;
      sounds.play("lowTime");
    }
    for (const at of [30_000, 10_000]) {
      if (left > at) said.delete(at);
      else if (left > 0 && !said.has(at)) {
        said.add(at);
        announcer.say(fill(t.say_secondsLeft, { n: String(at / 1000) }));
      }
    }
  }

  /** The ticker runs while a timed game goes on: the clocks' text, and the game's own clock work (tick). */
  function runTicker(view: View): void {
    const on = Boolean(view.tc && view.phase === "playing" && !view.end);
    if (on && !ticker) {
      ticker = setInterval(() => {
        void game.tick();
        renderClocks();
      }, 100);
    } else if (!on && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  function render(): void {
    const view = game.view();
    const shown = review.view();
    const record = game.record();
    const at = review.ply();
    const boardHadFocus = board.element.contains(document.activeElement);
    // No premove while reviewing, nor with the setting off.
    if (review.reviewing() || !prefs.get().premove) premove.clear();
    board.render(shown);
    board.element.classList.toggle("reviewing", review.reviewing());
    const down = board.orientation();
    strip(bottom, down, view, record, at);
    strip(top, down === "w" ? "b" : "w", view, record, at);
    status.textContent = statusText(view);
    side.textContent = view.me ? (view.me === "w" ? t.youAreWhite : t.youAreBlack) : "";
    if (openingFor?.record !== record || openingFor.at !== at) openingFor = { record, at, opening: openingOf(record.fens.slice(1, MAX_PLY + 1), at) };
    renderOpening(opening, openingFor.opening, t);
    moves.render(record, at, game.spent(), drawChip(view));
    reviewBar.render(view.plies);
    renderClocks();
    runTicker(view);
    renderActions(view);
    const sound = prefs.get().sound;
    if (mute.dataset.on !== String(sound)) {
      mute.dataset.on = String(sound);
      mute.replaceChildren(speakerIcon(sound));
    }
    mute.setAttribute("aria-pressed", String(sound));
    // The contact's invitation takes the board's card place from the game-over card.
    const end = view.invitation ? undefined : view.end;
    const rematch = view.canRematch ? { reason: featureHint(view, "rematch", t) } : undefined;
    gameOver.render(end ? view : { ...view, end: undefined }, end ? `${view.plies}|${end.why}|${end.result}|${record.fens[1] ?? ""}` : "", boardHadFocus, rematch);
    const cardHadFocus = cards.setup.contains(document.activeElement) || cards.invitation.contains(document.activeElement);
    cards.render(view);
    // A card that hid under focus (Invite, Accept, Decline, or the contact's invitation replacing the panel) would drop
    // it to the page: it goes to the invitation's first working button, else to the board.
    const focused = document.activeElement;
    if (cardHadFocus && (!(focused instanceof HTMLElement) || focused === document.body || focused.closest("[hidden]") || (focused as HTMLButtonElement).disabled)) {
      const next = cards.invitation.hidden ? null : cards.invitation.querySelector<HTMLButtonElement>("button:not([disabled])");
      (next ?? board.element.querySelector<HTMLElement>('[tabindex="0"]'))?.focus();
    }
    const line = standingText(view, t);
    standing.hidden = !line;
    standingWords.textContent = line?.text ?? "";
    details.hidden = !line?.details;
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
      const who = view.phase === "alone" ? (view.lastMove.colour === "w" ? t.whiteName : t.blackName) : view.lastMove.colour === view.me ? t.you : (view.peerName ?? t.contact);
      announcer.say(sayMove(view.lastMove, who, view, t));
    }
    const end = view.end ? endText(view.end, view) : "";
    if (lastPlies >= 0 && end && end !== lastEnd) announcer.say(end);
    lastEnd = end;
    lastPlies = view.plies;
    // The contact's invitation, when it comes or changes: the card alone would go unheard.
    const invitation = view.invitation ? invitationWords(view.invitation, t) : "";
    if (invitation && invitation !== lastInvitation) announcer.say(invitation);
    lastInvitation = invitation;
    // The contact's takeback ask or draw offer, when it comes: the card alone would go unheard too.
    const ask = view.phase === "playing" ? (view.takeback === "peer" ? t.peerAsksTakeback : view.drawOffer === "peer" ? t.peerOffersDraw : "") : "";
    if (ask && ask !== lastAsk) announcer.say(ask);
    lastAsk = ask;
  }

  /** How the game ended, from this side: "You won: checkmate". */
  function endText(end: NonNullable<View["end"]>, view: View): string {
    const { result, why } = end;
    const head =
      result === "*" ? t.noResult : result === "1/2-1/2" ? t.drawn : view.me ? ((result === "1-0") === (view.me === "w") ? t.won : t.lost) : result === "1-0" ? t.whiteWins : t.blackWins;
    return `${head}: ${t[`why_${why}`]}`;
  }

  function statusText(view: View): string {
    // The contact's invitation is what the board shows (its card takes the game-over card's place): the status says it.
    if (view.invitation) return invitationWords(view.invitation, t);
    if (view.end) return endText(view.end, view);
    const check = view.inCheck ? `. ${t.check}` : "";
    switch (view.phase) {
      case "loading":
        return t.loading;
      case "alone":
        return `${view.turn === "w" ? t.whiteToMove : t.blackToMove}${check}`;
      case "toss":
        return view.peerOpen ? t.tossing : t.waitingPeer;
      case "setup":
        return view.peerOpen ? t.setupStatus : t.waitingPeer;
      case "invited":
        return view.peerOpen ? t.invitedStatus : t.waitingPeer;
      case "out-of-step":
        return t.outOfStep;
      default:
        if (!view.peerOpen) return t.away;
        // Our takeback ask waits: no move until it is answered, and the status says why.
        if (view.takeback === "me") return `${t.takebackAsked}${check}`;
        return `${view.me === view.turn ? t.yourMove : t.theirMove}${check}`;
    }
  }

  const button = (label: string, run: (b: HTMLButtonElement) => void, className = "") => {
    const b = el("button", `act ${className}`.trim(), label);
    b.type = "button";
    b.addEventListener("click", () => run(b));
    return b;
  };

  /** Resign asks first, in a dialog that keeps focus (Cancel has it, and Escape closes it). */
  function askResign(opener: HTMLElement): void {
    const dialog = openDialog(app, { title: t.resignAsk, closeLabel: t.close, opener });
    dialog.element.classList.add("resign-dialog");
    const row = el("div", "dialog-actions");
    const confirm = button(t.resign, () => {
      dialog.close();
      void game.resign();
    }, "danger resign-confirm");
    row.append(button(t.cancel, () => dialog.close(), "resign-cancel"), confirm);
    dialog.body.append(row);
  }

  function renderActions(view: View): void {
    const out: HTMLElement[] = [];
    const playing = view.phase === "playing";
    // The contact's takeback ask, else its draw offer: a card of its own, answered with Accept or Decline.
    const kind = playing && view.takeback === "peer" ? "takeback" : playing && view.drawOffer === "peer" ? "draw" : "";
    const cardHadFocus = offerCard.contains(document.activeElement);
    if ((offerCard.dataset.kind ?? "") !== kind) {
      offerCard.dataset.kind = kind;
      const answer = (yes: boolean) => void (kind === "takeback" ? game.answerTakeback(yes) : game.answerDraw(yes));
      const words = kind === "takeback" ? t.peerAsksTakeback : t.peerOffersDraw;
      offerCard.replaceChildren(...(kind ? [el("span", "offer", words), button(t.accept, () => answer(true), "primary"), button(t.decline, () => answer(false))] : []));
      // The group is named by what it answers, so Accept and Decline are never heard alone.
      if (kind) offerCard.setAttribute("aria-label", words);
      else offerCard.removeAttribute("aria-label");
      offerCard.hidden = !kind;
    }
    if (view.phase === "alone" && view.plies > 0) out.push(button(t.newGame, () => void game.newGame()));
    if (playing) {
      // Take back: an icon, so the controls stay one row; off with the reason when the contact's Chess has none.
      const label = view.takeback === "me" ? t.takebackAsked : t.takeback;
      const back = button("↶", () => void game.takeback(), "icon takeback-btn");
      back.setAttribute("aria-label", label);
      back.title = featureHint(view, "takeback", t) ?? label;
      back.disabled = !view.canTakeback;
      out.push(back);
      const offer = button(view.drawOffer === "me" ? t.youOfferedDraw : t.offerDraw, () => void game.offerDraw(), "draw-btn");
      offer.disabled = !view.canDraw;
      out.push(offer);
      // Before ply 2, Abort (no result) replaces Resign; Resign asks first. Our claim waiting: no resign (C7). Our
      // takeback ask waiting: neither, nor an answer to a draw offer, which could cross the accept.
      const waiting = Boolean(view.claiming) || view.takeback === "me";
      if (view.canAbort) {
        const abort = button(t.abort, () => void game.abort(), "danger abort-btn");
        // At 320 px the label may end in an ellipsis: the title (and the accessible name) keep it whole.
        abort.title = t.abort;
        abort.disabled = waiting;
        out.push(abort);
      } else {
        const resign = button(t.resign, (b) => askResign(b), "danger resign-btn");
        resign.disabled = waiting;
        out.push(resign);
      }
    }
    for (const b of offerCard.querySelectorAll("button")) b.disabled = Boolean(view.claiming) || (offerCard.dataset.kind === "draw" && view.takeback === "me");
    if (view.phase === "over" || view.phase === "out-of-step") out.push(button(t.newGame, () => void game.newGame(), "primary"));
    if (view.end && view.phase !== "alone") out.push(button(t.copyPgn, (b) => copyPgn(b), "pgn-btn"));
    if (view.phase === "alone" && view.plies > 0) out.push(button(t.copyPgn, (b) => copyPgn(b), "pgn-btn"));
    const focused = actions.contains(document.activeElement) ? (document.activeElement as HTMLElement).className : cardHadFocus && offerCard.hidden ? "?" : "";
    actions.replaceChildren(...out);
    if (!focused) return;
    // Focus stays on the same control when it is still there and on, else the first one that is.
    const live = [...actions.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
    (live.find((b) => b.className === focused) ?? live[0])?.focus();
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
      case "Escape":
        board.dropPremove();
        return;
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
      moves.render(game.record(), review.ply(), game.spent());
    }
  }
  fit();
  window.addEventListener("resize", fit);

  const offChange = game.subscribe(render);
  const offPremove = premove.subscribe(render);
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
    offPremove();
    premove.stop();
    offReview();
    offPrefs();
    offNotice();
    review.stop();
    sounds.stop();
    document.removeEventListener("keydown", key);
    window.removeEventListener("resize", fit);
    board.destroy();
    clearTimeout(noticeTimer);
    clearInterval(ticker);
  };
}
