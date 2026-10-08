/**
 * The game, over the broker: state, rules and the message protocol (protocol.ts), with no DOM, so the tests drive it
 * with a mock broker.
 *
 * Which protocol it speaks with the contact is negotiated on each open (negotiate.ts):
 * - Version 1, with Chess 1.0.2 (and 1.1.x, 1.2.x): exactly 1.0.2's flow. A toss starts by itself when both are open,
 *   the game is untimed and dealt by the v1 deal, and every frame has exactly the keys 1.0.2 writes.
 * - Version 2: invitations replace the automatic toss. A seek carries terms and the other side sees an invitation
 *   with Accept and Decline; the terms are bound into the game id (deal2).
 * The mode never changes a game's deal: a game begun on 1.0.2 (dv:1) goes on untimed in either envelope, and a dv:2
 * game takes only v2 frames.
 *
 * A move may be made while the contact's Chess is closed: it is saved here, and travels in the next sync under the
 * "ours plus one ply" rule that 1.0.2 already has. Frames stay live-only, as WISP 1200 requires: the waiting move is
 * this side's own state. The game is saved in the app's storage (per chat) after every change, and both sides send
 * a `sync` whenever the other side opens the app, so a reload or a reconnect resumes it.
 *
 * Every move from the peer is checked: right game, right ply number, the peer's turn, legal in the position. A move
 * that fails is ignored and reported (a notice), and this side answers with its own `sync` (at most once a second) so
 * an honest peer that fell out of step can catch up. Every draw, takeback, ack, flag and dispute names the ply count
 * n it is about; one whose g or n differs from this side's game is ignored.
 *
 * A `sync` is taken only as far as it is provable: the same game (its id comes from both salts and, in version 2,
 * the terms, and the salts must include this side's own), a history that is ours plus at most one legal ply of the
 * sender's, and a non-board end this side could have reached (see acceptEnd). Anything else is shown as "out of
 * step" or ignored as a bad message, and New game starts afresh, giving up both games.
 */
import { Chess, type Move, type Square } from "chess.js";
import { historyOf, plyOf, type GameHistory, type LastMove } from "./history.ts";
import type { MiniAppApi, MiniAppJson, MiniAppPeerEvent } from "./vendor/miniApp.ts";
import { Negotiator, type Mode } from "./negotiate.ts";
import {
  encodeMessage,
  MAX_PLIES,
  parseMessage,
  sameTerms,
  UCI,
  V1_KINDS,
  VERSION,
  type Colour,
  type DrawOption,
  type Envelope,
  type Feature,
  type GameEnd,
  type Message,
  type TakebackOption,
  type TimeControl,
} from "./protocol.ts";
import { KEY_FLIP, KEY_GAME, KEY_PREV, readFlip, readGame, readPrev, type SavedFlip, type SavedGame, type SavedPrev } from "./record.ts";
import { commitment, cryptoRandom, deal, deal2, newSalt, type Random } from "./toss.ts";

export type { SavedFlip, SavedGame, SavedPrev };

/**
 * The features this build implements and names in its hello. The protocol knows five (FEATURE_NAMES); a build names
 * only what it does, so a later Chess never sends this one a clock or a takeback it cannot run.
 */
export const OWN_FEATURES: readonly Feature[] = [];

/**
 * A value as the broker takes it: strict JSON, made by a round trip through JSON. The broker refuses a value with an
 * `undefined` member (a JSON value has none), and a game record spread with `d: undefined` has one: its save and its
 * move were refused, so a move was never sent nor kept. JSON drops such a member, as it does here.
 */
function plain(value: unknown): MiniAppJson {
  return JSON.parse(JSON.stringify(value)) as MiniAppJson;
}

/** A game played alone on one device (both colours), under "local". */
export interface SavedLocal {
  v: 1;
  m: string[];
  /** The start date, "YYYY.MM.DD", set at the first move. */
  sd?: string;
}

const DATE = /^\d{4}\.\d\d\.\d\d$/;

/** A time as a PGN date, "YYYY.MM.DD", in local time. */
export function dateStamp(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).padStart(4, "0")}.${two(d.getMonth() + 1)}.${two(d.getDate())}`;
}

export type EndReason =
  | "checkmate"
  | "stalemate"
  | "repetition"
  | "fifty"
  | "material"
  | "limit"
  | "resign"
  | "agreed"
  | "time"
  | "aborted"
  | "disputed";
export interface Ending {
  /** "*": no result (an aborted game, or clocks that disagree). */
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
  why: EndReason;
}

/**
 * "toss": the automatic toss of version 1. "setup": no game, the new-game panel (version 2, or the contact away).
 * "invited": this side's invitation waits for the contact.
 */
export type Phase = "loading" | "alone" | "toss" | "setup" | "invited" | "playing" | "over" | "out-of-step";

export type Notice =
  | "invalid-move"
  | "bad-message"
  | "too-big"
  | "newer-version"
  | "bad-reveal"
  | "toss-restarted"
  | "out-of-step"
  | "peer-new-game"
  | "send-failed"
  | "declined";

/** An invitation's terms, as the UI shows them. */
export interface Terms {
  /** [base s, increment s]; absent means unlimited. */
  tc?: TimeControl;
  /** A rematch of the last game. */
  rematch: boolean;
}

export interface View {
  phase: Phase;
  /** This side's colour in a chat game; undefined alone or before the toss. */
  me?: Colour;
  peerOpen: boolean;
  fen: string;
  turn: Colour;
  plies: number;
  lastMove?: LastMove;
  inCheck: boolean;
  end?: Ending;
  drawOffer?: "me" | "peer";
  /** This side may move now. */
  canMove: boolean;
  /** The protocol spoken with the contact (version 1 is Chess 1.0.2's). */
  mode: Mode;
  /** The contact's Chess version, from its client, while known. */
  peerVersion?: string;
  /** The features both sides named. */
  features: string[];
  /** The contact's latest invitation, waiting for Accept or Decline. */
  invitation?: Terms;
  /** This side's invitation, waiting for the contact. */
  proposal?: Terms;
  /** The game's time control; absent means unlimited. */
  tc?: TimeControl;
}

export type { LastMove };

export interface ControllerOptions {
  random?: Random;
  now?: () => number;
}

const KEY_LOCAL = "local";
const RESYNC_GAP_MS = 1000;

const other = (c: Colour): Colour => (c === "w" ? "b" : "w");

/** Plays one UCI ply on `chess`, or throws. The promotion piece must be given exactly when the move promotes. */
export function playUci(chess: Chess, uci: string): void {
  if (!UCI.test(uci)) throw new Error(`not a move: ${uci}`);
  const promotion = uci.length === 5 ? uci[4] : undefined;
  const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion });
  if ((move.promotion ?? undefined) !== promotion) {
    chess.undo();
    throw new Error(`promotion piece wrong in ${uci}`);
  }
}

/** A position from a list of plies, or null when one is illegal. */
export function replay(moves: string[]): Chess | null {
  const chess = new Chess();
  try {
    for (const m of moves) playUci(chess, m);
  } catch {
    return null;
  }
  return chess;
}

/** How the board ended the game, if it did. */
export function boardEnding(chess: Chess, plies: number): Ending | undefined {
  if (chess.isCheckmate()) return { result: chess.turn() === "w" ? "0-1" : "1-0", why: "checkmate" };
  if (chess.isStalemate()) return { result: "1/2-1/2", why: "stalemate" };
  if (chess.isInsufficientMaterial()) return { result: "1/2-1/2", why: "material" };
  // Draws by repetition and by the 50-move rule end the game at once, without a claim: simpler for a chat game.
  if (chess.isThreefoldRepetition()) return { result: "1/2-1/2", why: "repetition" };
  if (chess.isDrawByFiftyMoves()) return { result: "1/2-1/2", why: "fifty" };
  if (plies >= MAX_PLIES) return { result: "1/2-1/2", why: "limit" };
  return undefined;
}

/** True when a colour has only a king, a king and a bishop, or a king and a knight: it cannot mate (chess.com's rule). */
export function cannotMate(chess: Chess, colour: Colour): boolean {
  const pieces = chess.board().flat().filter((sq) => sq && sq.color === colour).map((sq) => sq!.type);
  return pieces.length === 1 || (pieces.length === 2 && (pieces.includes("b") || pieces.includes("n")));
}

function endingOf(chess: Chess, plies: number, x: GameEnd | undefined): Ending | undefined {
  if (x?.why === "resign") return { result: x.by === "w" ? "0-1" : "1-0", why: "resign" };
  if (x?.why === "agreed") return { result: "1/2-1/2", why: "agreed" };
  if (x?.why === "time") return { result: cannotMate(chess, other(x.by)) ? "1/2-1/2" : x.by === "w" ? "0-1" : "1-0", why: "time" };
  if (x?.why === "aborted") return { result: "*", why: "aborted" };
  if (x?.why === "disputed") return { result: "*", why: "disputed" };
  return boardEnding(chess, plies);
}

function lastMoveOf(move: Move): LastMove {
  const { from, to, san, colour, piece, captured, promotion, castle } = plyOf(move);
  const out: LastMove = { from, to, san, colour, piece };
  if (captured) out.captured = captured;
  if (promotion) out.promotion = promotion;
  if (castle) out.castle = castle;
  return out;
}

const isPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((m, i) => b[i] === m);

/** A game record with no draw offer standing. */
function noOffer(game: SavedGame): SavedGame {
  const next = { ...game };
  delete next.d;
  delete next.dn;
  return next;
}

/** The terms of a flip or a game. */
const termsOf = (t: { tc?: TimeControl; r?: string }): { tc?: TimeControl; r?: string } => {
  const out: { tc?: TimeControl; r?: string } = {};
  if (t.tc) out.tc = t.tc;
  if (t.r) out.r = t.r;
  return out;
};

/** The contact's invitation, as it came. */
interface Invitation {
  c: string;
  a: string[];
  tc?: TimeControl;
  r?: string;
}

export class ChessController {
  private readonly api: MiniAppApi;
  private readonly random: Random;
  private readonly now: () => number;
  private readonly negotiator = new Negotiator(OWN_FEATURES);
  private inChat = false;
  private peerOpen = false;
  private phaseLoaded = false;
  private game: SavedGame | null = null;
  private flip: SavedFlip | null = null;
  private prev: SavedPrev | null = null;
  private local: SavedLocal | null = null;
  /** The contact's latest invitation (version 2): only the latest is kept, so a flood replaces a card. */
  private invitation: Invitation | null = null;
  /** New game was pressed with a finished game here: the new-game panel shows, the old game stays until a new one. */
  private choosing = false;
  /** The peer's game id when the two sides hold different games. */
  private stepPeerGame: string | null = null;
  private chess = new Chess();
  /** Every task in order; held until `start` has read the saved game, so what arrives meanwhile waits for it. */
  private queue: Promise<void>;
  private loaded!: () => void;
  private lastResync = -Infinity;
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(notice: Notice) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  /**
   * What the board alone says, read once per position: chess.js replays the whole game for its history and for
   * repetition, and the board asks for the view and the targets on every press. Keyed by the Chess object and its FEN
   * (the move counters make every ply's FEN new), so a move, a load or a new game all start afresh without being
   * cleared by hand. What else the view reads (the phase, the peer, the offer) is read fresh every time.
   */
  private boardCache: {
    chess: Chess;
    fen: string;
    plies: number;
    moves: Move[];
    record?: GameHistory;
    last?: LastMove;
    ending?: Ending;
    inCheck: boolean;
    targets: Map<Square, { to: Square; promotion: boolean }[]>;
  } | null = null;

  constructor(api: MiniAppApi, options: ControllerOptions = {}) {
    this.api = api;
    this.random = options.random ?? cryptoRandom;
    this.now = options.now ?? (() => Date.now());
    this.queue = new Promise<void>((resolve) => (this.loaded = resolve));
    // Listening from the first moment: the broker hands over an event once, as it comes, and one that came while the
    // app was still loading (the contact opening Chess, their first seek) would be lost, leaving this side waiting.
    this.unsubscribe.push(api.chat.on("message", (data) => void this.enqueue(() => this.receive(data))));
    this.unsubscribe.push(api.chat.on("peer", (peer) => void this.enqueue(() => this.peerChanged(peer))));
  }

  // ---------- life ----------

  /** Reads the context and the saved game, listens to the peer, and opens the conversation if the peer is open. */
  async start(): Promise<void> {
    const context = await this.api.context();
    this.inChat = context.inChat;
    this.peerOpen = context.peer !== null;
    if (this.inChat) {
      this.game = readGame(await this.api.storage.get(KEY_GAME));
      this.flip = readFlip(await this.api.storage.get(KEY_FLIP));
      this.prev = readPrev(await this.api.storage.get(KEY_PREV));
      const chess = this.game && replay(this.game.m);
      if (!chess) this.game = null;
      this.chess = chess ?? new Chess();
    } else {
      const stored = await this.api.storage.get(KEY_LOCAL);
      const moves = this.readMoves(stored);
      const chess = replay(moves);
      this.chess = chess ?? new Chess();
      this.local = { v: 1, m: chess ? moves : [] };
      const sd = (stored as Partial<SavedLocal> | undefined)?.sd;
      if (chess && moves.length && typeof sd === "string" && DATE.test(sd)) this.local.sd = sd;
    }
    this.phaseLoaded = true;
    // The contact's Chess is open: this side opens the conversation before it reads what came meanwhile, so a hello
    // that arrived while loading is read in the mode this open sets.
    if (this.inChat && context.peer) await this.opened(context.peer.version);
    this.loaded();
    this.changed();
  }

  /** Stops listening. */
  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /** Waits for every message received so far to be handled (for tests and for the UI after an action). */
  settled(): Promise<void> {
    return this.queue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onNotice(listener: (notice: Notice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  // ---------- what the UI reads ----------

  private position(): NonNullable<ChessController["boardCache"]> {
    const chess = this.chess;
    const fen = chess.fen();
    const cached = this.boardCache;
    if (cached && cached.chess === chess && cached.fen === fen) return cached;
    const history = chess.history({ verbose: true });
    const last = history[history.length - 1];
    const plies = history.length;
    const fresh = { chess, fen, plies, moves: history, last: last ? lastMoveOf(last) : undefined, ending: boardEnding(chess, plies), inCheck: chess.inCheck(), targets: new Map() };
    this.boardCache = fresh;
    return fresh;
  }

  private ended(): boolean {
    return Boolean(this.game && endingOf(this.chess, this.game.m.length, this.game.x));
  }

  view(): View {
    const position = this.position();
    const plies = position.plies;
    const x = this.game?.x;
    const gameEnd: Ending | undefined = x ? endingOf(this.chess, plies, x) : position.ending;
    const end = this.inChat ? (this.game ? gameEnd : undefined) : position.ending;
    const mode = this.negotiator.mode;
    let phase: Phase;
    if (!this.phaseLoaded) phase = "loading";
    else if (!this.inChat) phase = "alone";
    else if (this.stepPeerGame) phase = "out-of-step";
    else if (!this.game || this.flip || this.choosing) {
      if (mode === "v1" && this.peerOpen) phase = "toss";
      else phase = this.flip ? "invited" : "setup";
    } else if (!end && mode === "v1" && this.peerOpen && this.game.dv === 2) phase = "out-of-step";
    else phase = end ? "over" : "playing";
    // As in 1.0.2, the colour of the game held here, even while a new toss or invitation is going.
    const me = this.inChat ? this.game?.me : undefined;
    const turn = this.chess.turn();
    const canMove = !end && (phase === "alone" || (phase === "playing" && me === turn));
    // The new-game panel is about the next game: the last one's end is not this side's news any more.
    const shownEnd = phase === "setup" || phase === "invited" ? undefined : end;
    const view: View = {
      phase,
      me,
      peerOpen: this.peerOpen,
      fen: position.fen,
      turn,
      plies,
      lastMove: position.last,
      inCheck: position.inCheck,
      end: shownEnd,
      drawOffer: this.inChat && !end && phase === "playing" ? this.game?.d : undefined,
      canMove,
      mode,
      features: this.negotiator.features,
    };
    if (this.negotiator.peerVersion) view.peerVersion = this.negotiator.peerVersion;
    if (this.invitation && this.peerOpen) view.invitation = { ...termsOf(this.invitation), rematch: Boolean(this.invitation.r) };
    if (this.flip && phase === "invited") view.proposal = { ...termsOf(this.flip), rematch: Boolean(this.flip.r) };
    if (this.game?.tc && (phase === "playing" || phase === "over")) view.tc = this.game.tc;
    return view;
  }

  /** Every ply so far, in SAN ("e4", "Nf3", "O-O"). */
  history(): string[] {
    return [...this.record().sans];
  }

  /** The game's moves, positions and captures (history.ts), made once per position. */
  record(): GameHistory {
    const position = this.position();
    position.record ??= historyOf(position.moves);
    return position.record;
  }

  /** The day the game started ("YYYY.MM.DD"), when known: a game from Chess 1.0.2 has none. */
  startDate(): string | undefined {
    const sd = this.inChat ? this.game?.sd : this.local?.sd;
    return sd && DATE.test(sd) ? sd : undefined;
  }

  /** The board as chess.js gives it, rank 8 first. */
  board(): ReturnType<Chess["board"]> {
    return this.chess.board();
  }

  /** Where the piece on `square` may go now, if this side may move it. */
  targets(square: Square): { to: Square; promotion: boolean }[] {
    if (!this.view().canMove) return [];
    const cache = this.position().targets;
    const known = cache.get(square);
    if (known) return known;
    const seen = new Map<Square, boolean>();
    for (const m of this.chess.moves({ square, verbose: true })) seen.set(m.to, seen.get(m.to) || Boolean(m.promotion));
    const targets = [...seen].map(([to, promotion]) => ({ to, promotion }));
    cache.set(square, targets);
    return targets;
  }

  // ---------- this side's actions ----------

  /**
   * Plays a move of this side's. False when it is not this side's turn or not legal. The contact's Chess may be
   * closed: the move is saved and goes in the sync when it opens.
   */
  move(from: Square, to: Square, promotion?: "q" | "r" | "b" | "n"): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.view().canMove) return false;
      const uci = `${from}${to}${promotion ?? ""}`;
      try {
        playUci(this.chess, uci);
      } catch {
        return false;
      }
      if (!this.inChat) {
        this.local = { v: 1, m: [...(this.local?.m ?? []), uci], sd: this.local?.m.length ? this.local.sd : dateStamp(this.now()) };
        await this.api.storage.set(KEY_LOCAL, plain(this.local));
        this.changed();
        return true;
      }
      const game = this.game!;
      const n = game.m.length;
      this.game = { ...noOffer(game), m: [...game.m, uci] };
      await this.saveGame();
      this.changed();
      await this.send({ k: "move", g: game.g, n, m: uci });
      return true;
    });
  }

  /** Resigns the game in this chat. */
  resign(): Promise<void> {
    return this.enqueue(async () => {
      const view = this.view();
      if (view.phase !== "playing" || !this.game) return;
      this.game = { ...noOffer(this.game), x: { why: "resign", by: this.game.me } };
      await this.saveGame();
      this.changed();
      await this.send({ k: "resign", g: this.game.g });
    });
  }

  /** Offers a draw, or accepts the peer's standing offer. */
  offerDraw(): Promise<void> {
    return this.enqueue(async () => {
      if (this.view().phase !== "playing" || !this.peerOpen || !this.game || this.game.d === "me") return;
      if (this.game.d === "peer") return this.answerDrawNow(true);
      const n = this.game.m.length;
      this.game = { ...this.game, d: "me", dn: n };
      await this.saveGame();
      this.changed();
      await this.send({ k: "draw", g: this.game.g, o: "offer", n });
    });
  }

  /** Accepts or declines the peer's draw offer. */
  answerDraw(accept: boolean): Promise<void> {
    return this.enqueue(() => this.answerDrawNow(accept));
  }

  /**
   * Starts a new game. Alone, at once. In a chat with Chess 1.0.2 (version 1), a new toss at once, as 1.0.2 does. In
   * version 2, or while the contact is away, the new-game panel: the game starts when an invitation is accepted.
   */
  newGame(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.inChat) {
        this.chess = new Chess();
        this.local = { v: 1, m: [] };
        await this.api.storage.set(KEY_LOCAL, plain(this.local));
        this.changed();
        return;
      }
      const view = this.view();
      if (view.phase === "playing") return; // resign first
      if (this.negotiator.mode === "v1" && this.peerOpen) return this.startToss(this.giveUp());
      this.choosing = true;
      this.stepPeerGame = null;
      this.changed();
    });
  }

  /**
   * Invites the contact to a game with these terms (version 2, or while the contact is away). Kept under "flip", so
   * it goes when the contact opens Chess, and survives a reload with the same terms. Unlimited (no tc) only for now.
   */
  invite(tc?: TimeControl): Promise<void> {
    return this.enqueue(async () => {
      if (!this.inChat || tc) return; // timed games come with the clocks
      const phase = this.view().phase;
      if (phase !== "setup" && phase !== "invited") return;
      if (this.negotiator.mode === "v1" && this.peerOpen) return;
      if (this.flip && !this.flip.peer && sameTerms(this.flip, {})) return; // already invited with these terms
      await this.startToss(this.giveUp(), {});
    });
  }

  /** Accepts the contact's invitation: our seek with the same terms, then the reveal. */
  acceptInvitation(): Promise<void> {
    return this.enqueue(async () => {
      const invitation = this.invitation;
      if (!invitation || !this.peerOpen || this.negotiator.mode !== "v2") return;
      if (this.game && !this.ended() && !this.choosing && !invitation.a.includes(this.game.g)) return;
      this.invitation = null;
      this.flip = { v: 2, salt: newSalt(this.random), a: this.giveUp(), peer: invitation.c, ...termsOf(invitation) };
      await this.api.storage.set(KEY_FLIP, plain(this.flip));
      this.changed();
      await this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a, ...termsOf(this.flip) });
      await this.send({ k: "reveal", s: this.flip.salt, c: invitation.c });
    });
  }

  /** Declines the contact's invitation: both sides go back to the new-game panel. */
  declineInvitation(): Promise<void> {
    return this.enqueue(async () => {
      const invitation = this.invitation;
      if (!invitation) return;
      this.invitation = null;
      this.changed();
      await this.send({ k: "decline", c: invitation.c });
    });
  }

  // ---------- protocol ----------

  /** The contact's Chess opened: decide the protocol, and open the conversation. */
  private async opened(version: string | undefined): Promise<void> {
    const { sendHello, sendOpening } = this.negotiator.open(version);
    this.changed();
    if (sendHello) await this.send({ k: "hello", pv: VERSION, f: [...OWN_FEATURES] });
    if (sendOpening) await this.openV2();
    else if (!sendHello) await this.openV1();
  }

  /**
   * What Chess 1.0.2 tells a peer that just opened, exactly: the toss it has going, or its game, or a new toss. An
   * invitation with terms 1.0.2 cannot play is dropped first.
   */
  private async openV1(): Promise<void> {
    this.invitation = null;
    if (this.flip && (this.flip.tc || this.flip.r)) {
      this.flip = null;
      await this.api.storage.delete(KEY_FLIP);
    }
    if (this.flip) return this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a });
    if (this.game && !this.choosing) return this.sendSync();
    await this.startToss(this.giveUp());
  }

  /** Version 2's opening, once both hellos are out: the game (so the contact catches up), and the invitation. */
  private async openV2(): Promise<void> {
    if (this.game) await this.sendSync();
    if (this.flip) await this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a, ...termsOf(this.flip) });
  }

  private async peerChanged(peer: MiniAppPeerEvent): Promise<void> {
    this.peerOpen = peer.open;
    if (!peer.open) {
      this.invitation = null; // it comes again with the contact's next open
      this.negotiator.close();
    }
    this.changed();
    if (peer.open) await this.opened(peer.version);
  }

  private async receive(data: MiniAppJson): Promise<void> {
    const parsed = parseMessage(data);
    if (!parsed.ok) {
      this.notice(parsed.reason === "too-big" ? "too-big" : parsed.reason === "newer-version" ? "newer-version" : "bad-message");
      return;
    }
    const { message, v } = parsed;
    const decision = this.negotiator.receive(v, message.k, message.k === "hello" ? message : undefined);
    if (decision.changed) this.changed();
    if (decision.sendHello) await this.send({ k: "hello", pv: VERSION, f: [...OWN_FEATURES] });
    if (decision.sendOpening) await (this.negotiator.mode === "v1" ? this.openV1() : this.openV2());
    if (!decision.handle) return;
    // A version 1 frame about a dv:2 game cannot be: the two sides disagree on the protocol.
    if (v === 1 && "g" in message && this.game?.dv === 2 && message.g === this.game.g) return this.outOfStep(message.g);
    switch (message.k) {
      case "hello":
        return;
      case "seek":
        if (v === 1) return this.negotiator.mode === "v1" ? this.onSeekV1(message.c, message.a) : undefined;
        return this.onSeekV2(message);
      case "decline":
        return this.onDecline(message.c);
      case "reveal":
        return this.onReveal(v, message.s, message.c);
      case "move":
        return this.onMove(message.g, message.n, message.m);
      case "sync":
        return this.onSync(v, message);
      case "resign":
        return this.onResign(message.g);
      case "draw":
        return this.onDraw(message.g, message.o, v === 2 ? message.n : undefined);
      case "ack":
        return this.onAck(message.g, message.n);
      case "flag":
        return this.onFlag(message.g, message.n);
      case "dispute":
        return this.onDispute(message.g, message.n);
      case "takeback":
        return this.onTakeback(message.g, message.n, message.o);
    }
  }

  /** Chess 1.0.2's toss, unchanged: a seek answered at once with our own seek and the reveal. */
  private async onSeekV1(peerCommit: string, abandons: string[]): Promise<void> {
    const game = this.game;
    const over = game ? this.ended() : true;
    // A game still on stays on unless the peer gives it up: the peer probably lost it, and our sync brings it back.
    if (game && !over && !this.flip && !abandons.includes(game.g)) return this.sendSync();
    if (this.flip && commitment(this.flip.salt) === peerCommit) return this.notice("bad-message");
    // A seek already answered, again (the peer reloaded, or both started at once): the reveal again, nothing new.
    if (this.flip && this.flip.peer === peerCommit) return this.send({ k: "reveal", s: this.flip.salt, c: peerCommit });
    if (!this.flip || this.flip.peer) {
      // No toss yet, or the peer tossed again after it saw our salt: a fresh salt, since a known one would let it choose.
      if (this.flip) this.notice("toss-restarted");
      else if (game && !over) this.notice("peer-new-game");
      const give = this.flip?.a ?? (game && !over ? [game.g] : []);
      this.flip = { v: 2, salt: newSalt(this.random), a: give, peer: peerCommit };
    } else {
      this.flip = { ...this.flip, peer: peerCommit };
    }
    await this.api.storage.set(KEY_FLIP, plain(this.flip));
    this.changed();
    // Our seek again before the reveal: the peer can check a reveal only against a commitment it has.
    await this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a });
    await this.send({ k: "reveal", s: this.flip.salt, c: peerCommit });
  }

  /**
   * Version 2: a seek is an invitation. With the same terms as our own open invitation it is the contact accepting
   * it, and the toss goes on as in version 1; otherwise it is shown, and only the latest one.
   */
  private async onSeekV2(seek: Extract<Message, { k: "seek" }>): Promise<void> {
    const game = this.game;
    const over = game ? this.ended() : true;
    if (game && !over && !this.flip && !this.choosing && !seek.a.includes(game.g)) return this.sendSync();
    if (this.flip && commitment(this.flip.salt) === seek.c) return this.notice("bad-message");
    // A rematch of a game this side does not hold as its last one: nothing to deal colours from.
    if (seek.r && this.prev?.g !== seek.r) return this.notice("bad-message");
    const flip = this.flip;
    if (flip && flip.peer === seek.c) return this.send({ k: "reveal", s: flip.salt, c: seek.c });
    if (flip && sameTerms(flip, seek)) {
      if (flip.peer) {
        // The contact tossed again after it saw our salt: a fresh salt, since a known one would let it choose.
        this.notice("toss-restarted");
        this.flip = { ...flip, salt: newSalt(this.random), peer: seek.c };
      } else this.flip = { ...flip, peer: seek.c };
      this.invitation = null;
      await this.api.storage.set(KEY_FLIP, plain(this.flip));
      this.changed();
      await this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a, ...termsOf(this.flip) });
      await this.send({ k: "reveal", s: this.flip.salt, c: seek.c });
      return;
    }
    if (flip?.peer) {
      // We had revealed against another seek of the contact's: that salt is known now, so it is never used again.
      this.flip = null;
      await this.api.storage.delete(KEY_FLIP);
    }
    if (game && !over && !this.choosing) this.notice("peer-new-game");
    const invitation: Invitation = { c: seek.c, a: [...seek.a], ...termsOf(seek) };
    this.invitation = invitation;
    this.changed();
  }

  private async onDecline(c: string): Promise<void> {
    if (!this.flip || commitment(this.flip.salt) !== c) return;
    this.flip = null;
    await this.api.storage.delete(KEY_FLIP);
    this.choosing = Boolean(this.game);
    this.notice("declined");
    this.changed();
  }

  private async onReveal(v: Envelope, peerSalt: string, answering: string): Promise<void> {
    // A reveal for an older toss of ours, or with no toss going: stale, nothing to do.
    if (!this.flip || answering !== commitment(this.flip.salt) || !this.flip.peer) return;
    if (v !== this.negotiator.envelope) return;
    if (commitment(peerSalt) !== this.flip.peer) return this.notice("bad-reveal");
    if (v === 1) {
      if (this.flip.tc || this.flip.r) return;
      const { g, me } = deal(this.flip.salt, peerSalt);
      return this.begin({ v: 2, g, me, s: [this.flip.salt, peerSalt], dv: 1, m: [], sd: dateStamp(this.now()) });
    }
    const terms = termsOf(this.flip);
    if (terms.r && this.prev?.g !== terms.r) return this.notice("bad-message");
    const { g, me } = deal2(this.flip.salt, peerSalt, terms, terms.r ? this.prev!.me : undefined);
    await this.begin({ v: 2, g, me, s: [this.flip.salt, peerSalt], dv: 2, m: [], sd: dateStamp(this.now()), ...terms });
  }

  private async onMove(g: string, n: number, uci: string): Promise<void> {
    if (!this.game || this.game.g !== g || this.flip) return this.resync();
    const game = this.game;
    if (n < game.m.length && game.m[n] === uci) return; // a repeat
    const end = this.ended();
    if (end || n !== game.m.length || this.chess.turn() !== other(game.me)) {
      this.notice("invalid-move");
      return this.resync();
    }
    try {
      playUci(this.chess, uci);
    } catch {
      this.notice("invalid-move");
      return this.resync();
    }
    this.game = { ...noOffer(game), m: [...game.m, uci] };
    await this.saveGame();
    this.changed();
  }

  /** The id a sync's salts and terms make, by the deal it claims; null when it matches neither deal. */
  private dealOf(v: Envelope, sync: Extract<Message, { k: "sync" }>): { g: string; me: Colour; dv: 1 | 2 } | null {
    const [theirSalt, mySalt] = sync.s;
    try {
      const v1 = deal(mySalt, theirSalt);
      if (v1.g === sync.g && !sync.tc && !sync.r) return { ...v1, dv: 1 };
      if (v === 1) return null;
      const terms = termsOf(sync);
      // A rematch's id does not depend on the colours: the colours come from the game before, when adopted.
      const prevColour = terms.r ? (this.prev?.g === terms.r ? this.prev.me : "w") : undefined;
      const v2 = deal2(mySalt, theirSalt, terms, prevColour);
      return v2.g === sync.g ? { ...v2, dv: 2 } : null;
    } catch {
      return null;
    }
  }

  private async onSync(v: Envelope, sync: Extract<Message, { k: "sync" }>): Promise<void> {
    const { g, m: moves, x } = sync;
    const [theirSalt, mySalt] = sync.s;
    const dealt = this.dealOf(v, sync);
    if (!dealt) return this.notice("bad-message");
    const same = this.game && this.game.g === g && this.game.s[0] === mySalt && this.game.s[1] === theirSalt;
    if (!same) {
      // Adopt only a game this side's own salt made: the toss it had going, with its terms, so the colours are the
      // ones it agreed to.
      const flip = this.flip;
      if (flip && flip.salt === mySalt && flip.peer === commitment(theirSalt) && dealt.dv === v && sameTerms(flip, sync)) {
        if (dealt.dv === 2 && flip.r && this.prev?.g !== flip.r) return this.notice("bad-message");
        await this.begin({ v: 2, g, me: dealt.me, s: [mySalt, theirSalt], dv: dealt.dv, m: [], sd: dateStamp(this.now()), ...termsOf(flip) });
        return this.onSync(v, sync);
      }
      if (this.game && this.game.g === g) return this.notice("bad-message");
      return this.outOfStep(g);
    }
    const game = this.game!;
    // A takeback this side never asked for: the two histories differ.
    if ((sync.tb ?? 0) > (game.tb ?? 0)) return this.outOfStep(g);
    this.stepPeerGame = null;
    let next = game;
    if (moves.length > game.m.length) {
      // Ours plus one ply, the sender's: a move of theirs we missed. Anything longer is not provable.
      const extra = moves[game.m.length];
      const ok = moves.length === game.m.length + 1 && isPrefix(game.m, moves) && this.chess.turn() === other(game.me) && !this.ended();
      const chess = ok ? replay(moves) : null;
      if (!chess) return this.outOfStep(g);
      this.chess = chess;
      next = { ...noOffer(next), m: [...game.m, extra] };
    } else if (!isPrefix(moves, game.m)) {
      return this.outOfStep(g);
    }
    if (x && !next.x) {
      if (this.acceptEnd(next, x, moves.length)) next = { ...noOffer(next), x };
      else this.notice("bad-message");
    }
    // The sender's standing draw offer, at this very ply (version 2 only).
    if (!next.x && !next.d && sync.d && sync.d[0] === other(next.me) && sync.d[1] === next.m.length && moves.length === next.m.length) {
      next = { ...next, d: "peer", dn: sync.d[1] };
    }
    if (next !== game) {
      this.game = next;
      await this.saveGame();
    }
    this.changed();
    // The peer is behind (fewer plies, or no end it should know): it catches up from ours.
    if (moves.length < next.m.length || (next.x && !x)) await this.sendSync();
  }

  /**
   * Whether a sync's end is one this side could have reached, with `plies` on the sender's board:
   * - resign by the sender;
   * - agreed when this side's own offer stood at that ply;
   * - time with the sender out of time, in a timed game (this side out of time only through a claim it accepted,
   *   which ended the game here already);
   * - aborted only before ply 2;
   * - disputed only when this side sent or received a claim at that ply.
   * Anything else is a bad message and changes nothing: a peer cannot end a game by claiming any end.
   */
  private acceptEnd(game: SavedGame, x: GameEnd, plies: number): boolean {
    const sender = other(game.me);
    switch (x.why) {
      case "resign":
        return x.by === sender;
      case "agreed":
        return game.d === "me" && (game.dn ?? game.m.length) === game.m.length && plies === game.m.length;
      case "time":
        return Boolean(game.tc) && x.by === sender;
      case "aborted":
        return game.m.length < 2 && plies < 2;
      case "disputed":
        return game.fl !== undefined && game.fl === plies;
    }
  }

  private async onResign(g: string): Promise<void> {
    if (!this.game || this.game.g !== g || this.flip) return;
    if (this.ended()) return;
    this.game = { ...noOffer(this.game), x: { why: "resign", by: other(this.game.me) } };
    await this.saveGame();
    this.changed();
  }

  /** A draw frame. In version 2 it names the ply count n: one about another position is stale, and ignored. */
  private async onDraw(g: string, option: DrawOption, n: number | undefined): Promise<void> {
    if (!this.game || this.game.g !== g || this.flip) return;
    if (this.ended()) return;
    const plies = this.game.m.length;
    if (n !== undefined && n !== plies) return;
    const d = this.game.d;
    if (option === "offer") {
      // Both offered: that is a draw.
      this.game = d === "me" ? { ...noOffer(this.game), x: { why: "agreed" } } : { ...this.game, d: "peer", dn: plies };
    } else if (d !== "me") {
      return this.notice("bad-message");
    } else if (n !== undefined && n !== (this.game.dn ?? plies)) {
      return;
    } else {
      this.game = option === "accept" ? { ...noOffer(this.game), x: { why: "agreed" } } : noOffer(this.game);
    }
    await this.saveGame();
    this.changed();
  }

  /** "I hold n plies": what the clocks will time by. An ack about another ply, or in an untimed game, changes nothing. */
  private async onAck(g: string, n: number): Promise<void> {
    if (!this.game || this.game.g !== g || n !== this.game.m.length) return;
    // Untimed: nothing to time. The clocks (C3, C4) read it.
  }

  /** A clock claim or a self-report. One about another ply is stale; in an untimed game there is no clock to run out. */
  private async onFlag(g: string, n: number): Promise<void> {
    if (!this.game || this.game.g !== g || n !== this.game.m.length || this.ended()) return;
    if (!this.game.tc) return this.notice("bad-message");
  }

  /** The claimed side disputes a claim: both end "clocks disagree", but only about a claim made at that ply. */
  private async onDispute(g: string, n: number): Promise<void> {
    if (!this.game || this.game.g !== g || n !== this.game.m.length || this.ended()) return;
    if (this.game.fl !== n) return this.notice("bad-message");
    this.game = { ...noOffer(this.game), x: { why: "disputed" } };
    await this.saveGame();
    this.changed();
  }

  /**
   * A takeback. This build names no "takeback" feature, so a contact does not ask; an answer counts only for an ask
   * of ours (q) at that ply count, and this side never asks. Either way, nothing changes.
   */
  private async onTakeback(g: string, n: number, option: TakebackOption): Promise<void> {
    if (!this.game || this.game.g !== g || this.ended()) return;
    if (option !== "ask" && this.game.q !== n) return;
  }

  private async answerDrawNow(accept: boolean): Promise<void> {
    if (!this.game || this.game.d !== "peer" || this.view().phase !== "playing") return;
    const n = this.game.dn ?? this.game.m.length;
    this.game = accept ? { ...noOffer(this.game), x: { why: "agreed" } } : noOffer(this.game);
    await this.saveGame();
    this.changed();
    await this.send({ k: "draw", g: this.game.g, o: accept ? "accept" : "decline", n });
  }

  // ---------- helpers ----------

  /** The games a new toss gives up: ours, and the peer's when they differ. */
  private giveUp(): string[] {
    return [this.game?.g, this.stepPeerGame].filter((g): g is string => Boolean(g)).slice(0, 2);
  }

  /** A new toss with a fresh salt, giving up these games, with these terms (none in version 1). */
  private async startToss(abandons: string[], terms: { tc?: TimeControl; r?: string } = {}): Promise<void> {
    this.flip = { v: 2, salt: newSalt(this.random), a: abandons.slice(0, 2), ...termsOf(terms) };
    await this.api.storage.set(KEY_FLIP, plain(this.flip));
    this.changed();
    await this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a, ...termsOf(this.flip) });
  }

  /** The toss is done: this is the game now. */
  private async begin(game: SavedGame): Promise<void> {
    this.game = game;
    this.flip = null;
    this.invitation = null;
    this.choosing = false;
    this.stepPeerGame = null;
    this.chess = new Chess();
    await this.saveGame();
    await this.api.storage.delete(KEY_FLIP);
    this.changed();
  }

  private outOfStep(g: string): void {
    this.stepPeerGame = g;
    this.notice("out-of-step");
    this.changed();
  }

  private async sendSync(): Promise<void> {
    const game = this.game;
    if (!game) return;
    const v1 = this.negotiator.envelope === 1;
    // A dv:2 game has no version 1 form: its id binds terms 1.0.2 cannot check.
    if (v1 && game.dv === 2) return;
    const message: Extract<Message, { k: "sync" }> = { k: "sync", g: game.g, s: [game.s[0], game.s[1]], m: game.m };
    if (game.x && (!v1 || game.x.why === "resign" || game.x.why === "agreed")) message.x = game.x;
    if (!v1) {
      Object.assign(message, termsOf(game));
      if (game.tb) message.tb = game.tb;
      if (game.d === "me" && !game.x) message.d = [game.me, game.dn ?? game.m.length];
    }
    await this.send(message);
  }

  /** Our state for a peer that sent something we could not place, at most once a second. */
  private async resync(): Promise<void> {
    if (this.now() - this.lastResync < RESYNC_GAP_MS) return;
    this.lastResync = this.now();
    if (this.negotiator.mode === "v1") await this.openV1();
    else await this.openV2();
  }

  /**
   * Sends a frame in the envelope now in force. Nothing goes while the contact's Chess is closed (frames are
   * live-only), nothing but our hello while its hello is awaited, and no kind 1.0.2 does not know in version 1.
   */
  private async send(message: Message): Promise<void> {
    if (!this.peerOpen) return;
    if (this.negotiator.holding && message.k !== "hello") return;
    const envelope = this.negotiator.envelope;
    if (envelope === 1 && !(V1_KINDS as readonly string[]).includes(message.k)) return;
    try {
      await this.api.chat.send(plain(encodeMessage(message, envelope)));
    } catch {
      // The peer closed or the chat dropped: the sync on its next open carries this.
      this.notice("send-failed");
    }
  }

  private async saveGame(): Promise<void> {
    if (!this.game) return;
    await this.api.storage.set(KEY_GAME, plain(this.game));
    // The last finished game, for a rematch's colours.
    if (this.ended() && this.prev?.g !== this.game.g) {
      this.prev = { g: this.game.g, me: this.game.me, ...(this.game.tc ? { tc: this.game.tc } : {}) };
      await this.api.storage.set(KEY_PREV, plain(this.prev));
    }
  }

  private readMoves(value: MiniAppJson | undefined): string[] {
    const v = value as Partial<SavedLocal> | undefined;
    return v && v.v === 1 && Array.isArray(v.m) && v.m.every((m) => typeof m === "string") ? v.m : [];
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private notice(notice: Notice): void {
    for (const listener of this.noticeListeners) listener(notice);
  }
}
