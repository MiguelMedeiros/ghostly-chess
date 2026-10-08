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
 * Timed games (the "clock" feature, rules C1-C9 in docs/protocol.md, arithmetic in clock.ts): each side times its own
 * turn and reports t with its move; the side to move acks; the observer bounds what the mover reports by what it saw
 * from its own send (ts) to the mover's latest proof, claims only with a proof, and holds a move that crosses its
 * claim until the claimed side answers. The page calls tick() a few times a second for the periodic part. What is kept
 * (k, tw, ts, pc, fl, ko) is written at turn boundaries, never on a tick.
 *
 * A `sync` is taken only as far as it is provable: the same game (its id comes from both salts and, in version 2,
 * the terms, and the salts must include this side's own), a history that is ours plus at most one legal ply of the
 * sender's, and a non-board end this side could have reached (see acceptEnd). Anything else is shown as "out of
 * step" or ignored as a bad message, and New game starts afresh, giving up both games. A toss is placed only by the
 * deal its flip is for (SavedFlip.dv), never by the envelope of the frame that completes it.
 */
import { Chess, type Move, type Square } from "chess.js";
import {
  ACK_EVERY_MS,
  addSample,
  baseMs,
  cannotMatePieces,
  checkReported,
  clocksAfter,
  grace,
  GRACE_MIN_MS,
  graceMax,
  incrementAt,
  mayClaim,
  SILENT_MS,
  spentOn,
  startFromWall,
  timeBefore,
  timedPly,
} from "./clock.ts";
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
export const OWN_FEATURES: readonly Feature[] = ["clock"];

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
  | "timeMaterial"
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
  | "declined"
  | "clock-off";

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
  /**
   * The contact's latest invitation, waiting for Accept or Decline. `playable` is false when its terms need a feature
   * both sides did not name (a clock, a rematch): Accept is then off.
   */
  invitation?: Terms & { playable: boolean };
  /** This side's invitation, waiting for the contact. */
  proposal?: Terms;
  /** The game's time control; absent means unlimited. */
  tc?: TimeControl;
  /** A timed game, the contact to move: no frame from its Chess for 10 s. */
  peerSilent?: boolean;
  /** The contact's time ran out while its Chess was away or silent: the claim goes when it is back (C8). */
  pendingClaim?: boolean;
  /** Our claim on the contact's time waits for its answer: no resign, no draw meanwhile (C7). */
  claiming?: boolean;
}

/** The clocks as the strips show them, in ms. The contact's running clock is an estimate (P - (now - ts)). */
export interface Clocks {
  w: number;
  b: number;
  /** The clock running now. */
  running?: Colour;
}

export type { LastMove };

export interface ControllerOptions {
  random?: Random;
  now?: () => number;
  /** How often our hello goes again while the contact's is awaited with the contact open; 0 never. */
  helloRetryMs?: number;
  /** A monotonic clock in ms (performance.now): what the clocks time by within a run. `now` is the wall clock. */
  mono?: () => number;
  /** The features this side names (tests make a Chess 2.0.0 with none). */
  features?: readonly Feature[];
}

const KEY_LOCAL = "local";
const RESYNC_GAP_MS = 1000;
/** At most one hello in answer a second, so a flood of hellos is not echoed. */
const HELLO_ANSWER_GAP_MS = 1000;
const HELLO_RETRY_MS = 3000;

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
  return cannotMatePieces(chess.board().flat().filter((sq) => sq && sq.color === colour).map((sq) => sq!.type));
}

function endingOf(chess: Chess, plies: number, x: GameEnd | undefined): Ending | undefined {
  if (x?.why === "resign") return { result: x.by === "w" ? "0-1" : "1-0", why: "resign" };
  if (x?.why === "agreed") return { result: "1/2-1/2", why: "agreed" };
  if (x?.why === "time") return cannotMate(chess, other(x.by)) ? { result: "1/2-1/2", why: "timeMaterial" } : { result: x.by === "w" ? "0-1" : "1-0", why: "time" };
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

/** Two ends say the same. */
const sameEnd = (a: GameEnd, b: GameEnd) => a.why === b.why && ("by" in a ? a.by : undefined) === ("by" in b ? b.by : undefined);

/** A game record with no draw offer standing. */
function noOffer(game: SavedGame): SavedGame {
  const next = { ...game };
  delete next.d;
  delete next.dn;
  return next;
}

/** A timed game's k, one entry per ply (a ply with none counts as no time spent). */
function alignedK(game: SavedGame): number[] {
  const tc = game.tc!;
  const k = (game.k ?? []).slice(0, game.m.length);
  while (k.length < game.m.length) k.push(timeBefore(tc, k, k.length) + incrementAt(tc, k.length));
  return k;
}

/** A game record with this k and clamp offset (none when 0). */
function withClock(game: SavedGame, clock: Pick<SavedGame, "k" | "ko">): SavedGame {
  const next = { ...game, k: clock.k };
  if (clock.ko) next.ko = clock.ko;
  else delete next.ko;
  return next;
}

/** A game record without these keys. */
function without(game: SavedGame, ...keys: (keyof SavedGame)[]): SavedGame {
  const next = { ...game };
  for (const key of keys) delete next[key];
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
  private readonly mono: () => number;
  private readonly own: readonly Feature[];
  private readonly negotiator: Negotiator;
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
  private lastHelloAnswer = -Infinity;
  private readonly helloRetryMs: number;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  /** An answer held back by the one-a-second limit: it goes when the second is up (one, however many came). */
  private answerTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(notice: Notice) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  // ---- the clocks, in memory (what is kept is in the game record: k, tw, ts, pc, fl) ----
  /** The mono start of this side's timed turn (C2): set as it applies the contact's ply, or from tw after a reload. */
  private turnStart: number | undefined;
  /** ts in mono: when this side's last ply first went out (C4). */
  private tsMono: number | undefined;
  /** ts was set by a send in this run (not read back from wall time), so a round trip can be timed from it. */
  private tsLive = false;
  /** The round trip of this ply has been timed. */
  private sampled = false;
  /** Round trips, for the grace (C3). */
  private samples: number[] = [];
  /** The contact's latest ack: the ply count it holds, and when it came (mono). */
  private lastAck: { n: number; at: number } | null = null;
  /** When a frame about this game last came from the contact, or it opened (mono): for "isn't answering". */
  private heard = 0;
  private wasSilent = false;
  /** When this side last sent its state again for a silent contact (mono). */
  private lastSilentResync = -Infinity;
  /** When our claim last went (mono): it goes again while the contact acks without answering it. */
  private lastFlagSent = -Infinity;
  /** A move, flag, dispute or sync failed to go with the contact open: tick() sends our state again. */
  private retry = false;
  /** Sends from tick()'s resync: a refusal shows no notice (the first one did). */
  private quiet = false;
  private lastAckSent = -Infinity;
  /** The game the "clock looks off" notice was shown for: once per game. */
  private clockNoticed: string | null = null;
  /** A move that crossed our claim at its ply: held, never applied, until the claimed side answers (C7). */
  private pending: { n: number; m: string } | null = null;
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
    this.mono = options.mono ?? (() => performance.now());
    this.own = options.features ?? OWN_FEATURES;
    this.negotiator = new Negotiator(this.own);
    this.helloRetryMs = options.helloRetryMs ?? HELLO_RETRY_MS;
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
      await this.restoreClocks();
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
    this.clearHelloTimers();
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
    // Out of step until a new game begins; New game opens the panel meanwhile, and the next seek gives up both games.
    else if (this.stepPeerGame && !this.choosing) phase = "out-of-step";
    else if (!this.game || this.flip || this.choosing) {
      if (mode === "v1" && this.peerOpen) phase = "toss";
      else phase = this.flip ? "invited" : "setup";
    } else if (!end && mode === "v1" && this.peerOpen && this.game.dv === 2) phase = "out-of-step";
    else phase = end ? "over" : "playing";
    // As in 1.0.2, the colour of the game held here, even while a new toss or invitation is going.
    const me = this.inChat ? this.game?.me : undefined;
    const turn = this.chess.turn();
    // Out of time on its own turn: the board is locked, and the flag goes (C6).
    const canMove = !end && (phase === "alone" || (phase === "playing" && me === turn && (this.ownLeft() ?? 1) > 0));
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
    if (this.invitation && this.peerOpen) view.invitation = { ...termsOf(this.invitation), rematch: Boolean(this.invitation.r), playable: this.playable(this.invitation) };
    if (this.flip && phase === "invited") view.proposal = { ...termsOf(this.flip), rematch: Boolean(this.flip.r) };
    if (this.game?.tc && (phase === "playing" || phase === "over")) view.tc = this.game.tc;
    if (phase === "playing" && this.peerSilent()) view.peerSilent = true;
    if (phase === "playing" && this.game?.pc !== undefined && this.game.fl === undefined) view.pendingClaim = true;
    if (phase === "playing" && this.claiming()) view.claiming = true;
    return view;
  }

  /** Both clocks now, in a timed game in this chat; undefined otherwise. Read as often as the page likes. */
  clocks(): Clocks | undefined {
    const game = this.game;
    if (!this.inChat || !game?.tc || this.flip || this.choosing) return undefined;
    const [w, b] = clocksAfter(game.tc, alignedK(game));
    const out: Clocks = { w, b };
    if (this.ended()) {
      if (game.x?.why === "time") out[game.x.by] = 0;
      return out;
    }
    const n = game.m.length;
    if (!timedPly(n)) return out;
    const turn = this.chess.turn();
    if (turn === game.me) {
      out[turn] = Math.max(0, this.ownLeft() ?? out[turn]);
      out.running = turn;
    } else if (this.tsMono !== undefined) {
      // The contact's clock as this side can know it: its time before the move, less the time since our ply went.
      out[turn] = Math.max(0, out[turn] - (this.mono() - this.tsMono));
      out.running = turn;
    }
    return out;
  }

  /** The time each ply took, in ms (undefined for the untimed plies 0 and 1, and in an untimed game). */
  spent(): (number | undefined)[] {
    const game = this.game;
    if (!this.inChat || !game?.tc) return [];
    const k = alignedK(game);
    return game.m.map((_, i) => spentOn(game.tc!, k, i));
  }

  /** The game's time control and each ply's remaining time, for the PGN; undefined in an untimed game. */
  clockRecord(): { tc: TimeControl; k: number[] } | undefined {
    const game = this.game;
    return this.inChat && game?.tc ? { tc: game.tc, k: alignedK(game) } : undefined;
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
      // Out of time: no move, the flag (C6).
      if (this.ownOut()) {
        await this.selfFlag();
        return false;
      }
      if (!this.view().canMove) return false;
      const left = this.ownLeft();
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
      let next: SavedGame = { ...noOffer(game), m: [...game.m, uci] };
      let t: number | undefined;
      if (game.tc) {
        // This side's own measure (C2): its time before the move less the time its turn took, plus the increment.
        const k = alignedK(game);
        t = timedPly(n) ? Math.min(2 ** 31 - 1, Math.max(0, Math.round((left ?? 0) + incrementAt(game.tc, n)))) : undefined;
        k[n] = t ?? baseMs(game.tc);
        next = { ...without(next, "tw", "ts", "pc"), k };
        this.turnStart = undefined;
        this.tsMono = undefined;
      }
      this.game = next;
      await this.saveGame();
      this.changed();
      const sent = await this.send({ k: "move", g: game.g, n, m: uci, ...(t === undefined ? {} : { t }) });
      if (sent) await this.plySent(false);
      return true;
    });
  }

  /** Resigns the game in this chat. */
  resign(): Promise<void> {
    return this.enqueue(async () => {
      const view = this.view();
      if (view.phase !== "playing" || !this.game || this.claiming()) return;
      this.game = { ...noOffer(this.game), x: { why: "resign", by: this.game.me } };
      await this.saveGame();
      this.changed();
      await this.send({ k: "resign", g: this.game.g });
    });
  }

  /** Offers a draw, or accepts the peer's standing offer. */
  offerDraw(): Promise<void> {
    return this.enqueue(async () => {
      if (this.view().phase !== "playing" || !this.peerOpen || !this.game || this.game.d === "me" || this.claiming()) return;
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
      // The contact's game, when the two differ, stays known until a new game begins: the invitation gives it up too.
      this.choosing = true;
      this.changed();
    });
  }

  /**
   * Invites the contact to a game with these terms (version 2, or while the contact is away). Kept under "flip", so
   * it goes when the contact opens Chess, and survives a reload with the same terms. A timed game needs "clock" named
   * by both sides.
   */
  invite(tc?: TimeControl): Promise<void> {
    return this.enqueue(async () => {
      if (!this.inChat) return;
      const terms = tc ? { tc } : {};
      if (!this.playable(terms)) return;
      const phase = this.view().phase;
      if (phase !== "setup" && phase !== "invited") return;
      if (this.negotiator.mode === "v1" && this.peerOpen) return;
      if (this.flip && !this.flip.peer && sameTerms(this.flip, terms)) return; // already invited with these terms
      await this.startToss(this.giveUp(), terms);
    });
  }

  /**
   * The clocks' periodic work, called by the page a few times a second in a timed game (and by tests, which drive the
   * time): the flag when this side's time is up (C6), the ack every 2 s on its own turn (C3, C4), "isn't answering",
   * and the pending claim while the contact is away (C8). Nothing is saved here but a flag or a pending claim.
   */
  tick(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.inChat || !this.game?.tc || this.flip || this.choosing) return;
      // A move, claim, answer or sync refused with the contact open (a held session): our state goes again.
      if (this.retry && this.peerOpen) {
        this.retry = false;
        if (!(await this.resync(true))) this.retry = true;
      }
      const game = this.game;
      if (!game?.tc || this.ended()) return;
      const n = game.m.length;
      if (this.chess.turn() === game.me) {
        if (this.ownOut()) return this.selfFlag();
        if (timedPly(n) && this.peerOpen && this.mono() - this.lastAckSent >= ACK_EVERY_MS) await this.sendAck();
        return;
      }
      const silent = this.peerSilent();
      if (silent !== this.wasSilent) {
        this.wasSilent = silent;
        this.changed();
      }
      // Silent with both open: a frame may have been lost. Our sync (with our ply) and an unanswered claim go again at
      // once and every SILENT_MS while it lasts, so neither side waits for a reopen (C8).
      if (!silent) this.lastSilentResync = -Infinity;
      else if (this.mono() - this.lastSilentResync >= SILENT_MS && (await this.resync(true))) this.lastSilentResync = this.mono();
      // The contact's time is up by this side's estimate, and no proof can come (C8): the claim waits for its return.
      if (timedPly(n) && game.fl === undefined && game.pc === undefined && this.tsMono !== undefined && (!this.peerOpen || silent)) {
        if (this.mono() - this.tsMono > timeBefore(game.tc, alignedK(game), n) + this.grace()) {
          this.game = { ...game, pc: n };
          await this.saveGame();
          this.changed();
        }
      }
    });
  }

  /** Accepts the contact's invitation: our seek with the same terms, then the reveal. */
  acceptInvitation(): Promise<void> {
    return this.enqueue(async () => {
      const invitation = this.invitation;
      if (!invitation || !this.peerOpen || this.negotiator.mode !== "v2") return;
      // Terms this build cannot play (a clock, a rematch both sides did not name) are never accepted.
      if (!this.playable(invitation)) return;
      if (this.game && !this.ended() && !this.choosing && !invitation.a.includes(this.game.g)) return;
      this.invitation = null;
      this.flip = { v: 2, salt: newSalt(this.random), dv: 2, a: this.giveUp(), peer: invitation.c, ...termsOf(invitation) };
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
    const { sendHello, reply, sendOpening } = this.negotiator.open(version);
    this.changed();
    if (sendHello) await this.sendHello(reply);
    if (sendOpening) await this.openV2();
    else if (!sendHello) await this.openV1();
    this.scheduleHello();
  }

  /**
   * Our hello. As an answer (`re: 1`), at most once a second: one asked for sooner is held back (false) and goes, with
   * the opening, when the second is up, so a flood of hellos gets one answer a second and a real reopen still gets one.
   */
  private async sendHello(reply: boolean): Promise<boolean> {
    if (reply) {
      const wait = this.lastHelloAnswer + HELLO_ANSWER_GAP_MS - this.now();
      if (wait > 0) {
        this.answerTimer ??= setTimeout(() => {
          this.answerTimer = undefined;
          void this.enqueue(async () => {
            if (!this.peerOpen || this.negotiator.mode !== "v2") return;
            this.lastHelloAnswer = this.now();
            await this.send({ k: "hello", pv: VERSION, f: [...this.own], re: 1 });
            await this.openV2();
          });
        }, wait);
        return false;
      }
      this.lastHelloAnswer = this.now();
    }
    await this.send({ k: "hello", pv: VERSION, f: [...this.own], ...(reply ? { re: 1 as const } : {}) });
    return true;
  }

  private clearHelloTimers(): void {
    clearTimeout(this.helloTimer);
    clearTimeout(this.answerTimer);
    this.helloTimer = undefined;
    this.answerTimer = undefined;
  }

  /** While the contact's hello is awaited with the contact open, ours goes again every few seconds (one may be lost). */
  private scheduleHello(): void {
    clearTimeout(this.helloTimer);
    this.helloTimer = undefined;
    if (this.helloRetryMs <= 0 || !this.peerOpen || !this.negotiator.holding) return;
    this.helloTimer = setTimeout(() => {
      this.helloTimer = undefined;
      void this.enqueue(async () => {
        if (!this.peerOpen || !this.negotiator.holding) return;
        await this.sendHello(false);
        this.scheduleHello();
      });
    }, this.helloRetryMs);
  }

  /**
   * What Chess 1.0.2 tells a peer that just opened, exactly: the toss it has going, or its game, or a new toss. An
   * invitation with terms 1.0.2 cannot play is dropped first.
   */
  private async openV1(): Promise<void> {
    this.invitation = null;
    // Terms 1.0.2 cannot play, or a toss revealed for deal 2 (that salt is known now): dropped.
    if (this.flip && (this.flip.tc || this.flip.r || (this.flip.dv === 2 && this.flip.peer))) {
      this.flip = null;
      await this.api.storage.delete(KEY_FLIP);
    }
    if (this.flip) {
      await this.dealFor(1);
      return void (await this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a }));
    }
    if (this.game && !this.choosing) return this.sendSync();
    await this.startToss(this.giveUp());
  }

  /** Version 2's opening, once both hellos are out: the game (so the contact catches up), and the invitation. */
  private async openV2(): Promise<void> {
    if (this.game) await this.sendSync();
    await this.openClocks();
    if (!this.flip) return;
    await this.dealFor(2);
    await this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a, ...termsOf(this.flip) });
  }

  /**
   * The flip's seek is about to go in this envelope: until the peer's commitment is held, the toss is for that
   * envelope's deal (the seek is all the other side sees of it). Once it is held, the deal is fixed.
   */
  private async dealFor(dv: 1 | 2): Promise<void> {
    if (!this.flip || this.flip.peer || this.flip.dv === dv) return;
    this.flip = { ...this.flip, dv };
    await this.api.storage.set(KEY_FLIP, plain(this.flip));
  }

  private async peerChanged(peer: MiniAppPeerEvent): Promise<void> {
    this.peerOpen = peer.open;
    this.heard = this.mono();
    if (!peer.open) {
      this.retry = false; // the contact's next open brings our state anyway
      this.invitation = null; // it comes again with the contact's next open
      this.negotiator.close();
      this.clearHelloTimers();
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
    // An answer held back by the one-a-second limit takes its opening with it later, unless the mode just changed.
    const answered = decision.sendHello ? await this.sendHello(true) : false;
    if (decision.sendOpening && (answered || decision.changed)) await (this.negotiator.mode === "v1" ? this.openV1() : this.openV2());
    if (!decision.handle) return;
    // A version 1 frame about a dv:2 game cannot be: the two sides disagree on the protocol.
    if (v === 1 && "g" in message && this.game?.dv === 2 && message.g === this.game.g) return this.outOfStep(message.g);
    switch (message.k) {
      case "hello":
        return;
      case "seek":
        if (v === 1) {
          // In version 2, a version 1 seek is the contact's toss from before it read our hello (a version misread):
          // taken only as an answer to an unlimited invitation of ours whose toss is not under way, and then for deal 1.
          const flip = this.flip;
          const answers = Boolean(flip && !flip.peer && !flip.tc && !flip.r);
          return this.negotiator.mode === "v1" || answers ? this.onSeekV1(message.c, message.a) : undefined;
        }
        return this.onSeekV2(message);
      case "decline":
        return this.onDecline(message.c);
      case "reveal":
        return this.onReveal(message.s, message.c);
      case "move":
        return this.onMove(message.g, message.n, message.m, message.t);
      case "sync":
        return this.onSync(v, message);
      case "resign":
        return this.onResign(message.g);
      case "draw":
        return this.onDraw(message.g, message.o, v === 2 ? message.n : undefined);
      case "ack":
        return this.onAck(message.g, message.n);
      case "flag":
        return this.onFlag(message.g, message.n, message.by);
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
    if (this.flip && this.flip.peer === peerCommit) return void (await this.send({ k: "reveal", s: this.flip.salt, c: peerCommit }));
    if (!this.flip || this.flip.peer) {
      // No toss yet, or the peer tossed again after it saw our salt: a fresh salt, since a known one would let it choose.
      if (this.flip) this.notice("toss-restarted");
      else if (game && !over) this.notice("peer-new-game");
      const give = this.flip?.a ?? (game && !over ? [game.g] : []);
      this.flip = { v: 2, salt: newSalt(this.random), dv: 1, a: give, peer: peerCommit };
    } else {
      this.flip = { ...this.flip, dv: 1, peer: peerCommit };
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
    if (flip && flip.peer === seek.c) return void (await this.send({ k: "reveal", s: flip.salt, c: seek.c }));
    if (flip && sameTerms(flip, seek)) {
      if (flip.peer) {
        // The contact tossed again after it saw our salt: a fresh salt, since a known one would let it choose.
        this.notice("toss-restarted");
        this.flip = { ...flip, salt: newSalt(this.random), dv: 2, peer: seek.c };
      } else this.flip = { ...flip, dv: 2, peer: seek.c };
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

  private async onReveal(peerSalt: string, answering: string): Promise<void> {
    // A reveal for an older toss of ours, or with no toss going: stale, nothing to do.
    if (!this.flip || answering !== commitment(this.flip.salt) || !this.flip.peer) return;
    if (commitment(peerSalt) !== this.flip.peer) return this.notice("bad-reveal");
    // The deal the toss is for, whatever envelope the reveal came in.
    if (this.flip.dv === 1) {
      if (this.flip.tc || this.flip.r) return;
      const { g, me } = deal(this.flip.salt, peerSalt);
      return this.begin({ v: 2, g, me, s: [this.flip.salt, peerSalt], dv: 1, m: [], sd: dateStamp(this.now()) });
    }
    const terms = termsOf(this.flip);
    if (terms.r && this.prev?.g !== terms.r) return this.notice("bad-message");
    const { g, me } = deal2(this.flip.salt, peerSalt, terms, terms.r ? this.prev!.me : undefined);
    await this.begin({ v: 2, g, me, s: [this.flip.salt, peerSalt], dv: 2, m: [], sd: dateStamp(this.now()), ...terms });
  }

  private async onMove(g: string, n: number, uci: string, t: number | undefined): Promise<void> {
    if (!this.game || this.game.g !== g || this.flip) return void (await this.resync());
    const game = this.game;
    // A repeat of a ply we hold: an honest resend, and a sign of life.
    if (n < game.m.length && game.m[n] === uci) return void (this.heard = this.mono());
    // Our claim stands at this ply: the move that crossed it waits, unapplied, for the claimed side's answer (C7).
    if (game.tc && game.fl === n && n === game.m.length && !game.x) {
      this.heard = this.mono();
      this.pending = { n, m: uci };
      return;
    }
    const end = this.ended();
    if (end || n !== game.m.length || this.chess.turn() !== other(game.me)) {
      this.notice("invalid-move");
      return void (await this.resync());
    }
    try {
      playUci(this.chess, uci);
    } catch {
      this.notice("invalid-move");
      return void (await this.resync());
    }
    // Signs of life for "isn't answering" are only frames that pass their checks: a stream of wrong ones hides nothing.
    this.heard = this.mono();
    let next: SavedGame = { ...noOffer(game), m: [...game.m, uci] };
    if (game.tc) {
      // The move frame is itself a proof: it left within one-way latency of its arrival (C4).
      const clock = this.contactPly(game, n, t, this.tsMono === undefined ? undefined : this.mono() - this.tsMono);
      if (!clock) {
        this.chess.undo();
        return this.claim(n, { n, m: uci });
      }
      next = this.myTurn(withClock(next, clock));
      // The ack goes before the save: it is what the contact times its own move by.
      await this.sendAck(next);
    }
    this.game = next;
    await this.saveGame();
    this.changed();
  }

  /**
   * The contact's ply n, checked against this side's view of its clock (C5): the k with the contact's time after it,
   * or null when that view is at or below 0, or the proof is past its time (a claim, never a refusal). `E` is the
   * observer bound when there is a proof.
   */
  private contactPly(game: SavedGame, n: number, t: number | undefined, E: number | undefined): Pick<SavedGame, "k" | "ko"> | null {
    const tc = game.tc!;
    const k = alignedK(game);
    const ko = game.ko ?? 0;
    if (!timedPly(n)) {
      k[n] = baseMs(tc);
      return { k, ko: game.ko };
    }
    const P = timeBefore(tc, k, n);
    const I = incrementAt(tc, n);
    const G = this.grace();
    // Read less an earlier clamp: the contact's own clock stands that much above our view of it.
    const reported = t === undefined ? P + I : t - ko;
    const { view, clamped } = checkReported(reported, P, I, E, G);
    // Once per game, also across a reload: a clamp before this one left ko above 0.
    if (clamped && !ko) this.clockOff(game.g);
    if (mayClaim(E, P, G, view)) return null;
    k[n] = Math.max(0, view);
    const more = Math.min(2 ** 31 - 1, ko + Math.max(0, reported - k[n]));
    return { k, ko: more > 0 ? more : undefined };
  }

  /** The contact's ply is applied: this side's turn starts now (C2), and our ply's bound is done with. */
  private myTurn(game: SavedGame): SavedGame {
    this.turnStart = this.mono();
    this.tsMono = undefined;
    this.lastAck = null;
    return { ...without(game, "ts", "pc"), tw: this.now() };
  }

  /** Our claim on the contact's time at ply count n (C7): the crossing move, if any, waits for the answer. */
  private async claim(n: number, pending?: { n: number; m: string }): Promise<void> {
    const game = this.game!;
    if (pending) this.pending = pending;
    this.game = { ...without(game, "pc"), fl: n };
    await this.saveGame();
    this.changed();
    await this.sendClaim(game, n);
  }

  /** Our claim on the contact's time at ply count n goes (again). */
  private async sendClaim(game: SavedGame, n: number): Promise<void> {
    this.lastFlagSent = this.mono();
    await this.send({ k: "flag", g: game.g, n, by: other(game.me) });
  }

  /**
   * The game a sync's salts and terms make under deal `dv`, from this side's point of view; null when its g is not
   * that. Deal 2 never comes in a version 1 frame (that envelope cannot carry its terms).
   */
  private dealOf(v: Envelope, sync: Extract<Message, { k: "sync" }>, dv: 1 | 2): { g: string; me: Colour } | null {
    const [theirSalt, mySalt] = sync.s;
    try {
      if (dv === 1) {
        if (sync.tc || sync.r) return null;
        const dealt = deal(mySalt, theirSalt);
        return dealt.g === sync.g ? dealt : null;
      }
      if (v === 1) return null;
      const terms = termsOf(sync);
      // A rematch's id does not depend on the colours: the colours come from the game before, when adopted.
      const prevColour = terms.r ? (this.prev?.g === terms.r ? this.prev.me : "w") : undefined;
      const dealt = deal2(mySalt, theirSalt, terms, prevColour);
      return dealt.g === sync.g ? dealt : null;
    } catch {
      return null;
    }
  }

  private async onSync(v: Envelope, sync: Extract<Message, { k: "sync" }>): Promise<void> {
    const { g, m: moves, x } = sync;
    const [theirSalt, mySalt] = sync.s;
    const same = this.game && this.game.g === g && this.game.s[0] === mySalt && this.game.s[1] === theirSalt;
    if (same && !this.dealOf(v, sync, this.game!.dv)) return this.notice("bad-message");
    if (!same) {
      // Adopt only a game this side's own salt made: the toss it had going, with its terms, under the deal that toss is
      // for. A sync naming the other deal of the same salts starts nothing: no side picks the better of two deals.
      const flip = this.flip;
      if (flip && flip.salt === mySalt && flip.peer === commitment(theirSalt)) {
        const dealt = sameTerms(flip, sync) ? this.dealOf(v, sync, flip.dv) : null;
        if (!dealt) return this.notice("bad-message");
        if (flip.dv === 2 && flip.r && this.prev?.g !== flip.r) return this.notice("bad-message");
        await this.begin({ v: 2, g, me: dealt.me, s: [mySalt, theirSalt], dv: flip.dv, m: [], sd: dateStamp(this.now()), ...termsOf(flip) });
        return this.onSync(v, sync);
      }
      if (!this.dealOf(v, sync, 1) && !this.dealOf(v, sync, 2)) return this.notice("bad-message");
      if (this.game && this.game.g === g) return this.notice("bad-message");
      return this.outOfStep(g);
    }
    const game = this.game!;
    this.heard = this.mono();
    // A takeback this side never asked for: the two histories differ.
    if ((sync.tb ?? 0) > (game.tb ?? 0)) return this.outOfStep(g);
    this.stepPeerGame = null;
    let next = game;
    let dropped = false;
    const plusOne = moves.length === game.m.length + 1 && isPrefix(game.m, moves);
    if (plusOne && game.x && (!x || sameEnd(x, game.x))) {
      // This side's game ended off the board (it resigned, say) before the sender's last ply reached it, a move made
      // while this side was away. The end stands where this side made it: ours is kept, not out of step. With no end
      // in the sync the sender has not heard of ours yet, so it gets our sync (once per such sync: it drops that ply).
      this.stepPeerGame = null;
      this.changed();
      if (!x) await this.sendSync();
      return;
    }
    let adopted = false;
    if (moves.length > game.m.length) {
      // Ours plus one ply, the sender's: a move of theirs we missed. Anything longer is not provable.
      const n = game.m.length;
      const extra = moves[n];
      const ok = plusOne && this.chess.turn() === other(game.me) && !this.ended();
      const chess = ok ? replay(moves) : null;
      if (!chess) return this.outOfStep(g);
      if (game.tc) {
        // Our claim stands at this ply: the move waits for the answer, and the claim goes again (C7).
        if (game.fl === n) {
          this.pending = { n, m: extra };
          return this.sendClaim(game, n);
        }
        // Caught up from a sync (C9): its t is c[mover], bounded only by the latest ack before it (the move may have
        // been made while the link was down).
        const ack = this.lastAck?.n === n && this.tsMono !== undefined ? this.lastAck.at - this.tsMono : undefined;
        const clock = this.contactPly(game, n, sync.c?.[game.me === "w" ? 1 : 0], ack);
        if (!clock) return this.claim(n, { n, m: extra });
        next = this.myTurn(withClock(next, clock));
        adopted = true;
      }
      this.chess = chess;
      next = { ...noOffer(next), m: [...game.m, extra] };
    } else if (!isPrefix(moves, game.m)) {
      return this.outOfStep(g);
    }
    if (x && !next.x) {
      if (this.acceptEnd(next, x, moves.length)) {
        next = { ...noOffer(next), x };
        // The sender resigned one ply short of ours, and that ply is this side's own: a move made while the sender
        // was away, which it never saw. The game ended before it, so it goes, and both sides hold the same history.
        const last = game.m.length - 1;
        if (x.why === "resign" && moves.length === last && last >= 0 && (last % 2 === 0) === (game.me === "w")) {
          const chess = replay(moves);
          if (chess) {
            this.chess = chess;
            next = { ...next, m: [...moves] };
            // The dropped ply's time goes with it: k stays one entry per ply.
            if (next.k) next = { ...next, k: next.k.slice(0, moves.length) };
            dropped = true;
          }
        }
      } else this.notice("bad-message");
    }
    // The sender's standing draw offer, at this very ply (version 2 only).
    if (!next.x && !next.d && sync.d && sync.d[0] === other(next.me) && sync.d[1] === next.m.length && moves.length === next.m.length) {
      next = { ...next, d: "peer", dn: sync.d[1] };
    }
    if (next.x) this.pending = null;
    if (next.x && next.pc !== undefined) next = without(next, "pc");
    if (adopted) await this.sendAck(next);
    if (next !== game) {
      this.game = next;
      await this.saveGame();
    }
    this.changed();
    // The peer is behind (fewer plies, or no end it should know): it catches up from ours. After a dropped ply, the
    // sender gets the matching history too: it may have gone out of step on our longer one meanwhile. When the sync
    // shows the peer lacked our last ply, it gets it only now: our ply's ts moves to this send (C4).
    const lacked = moves.length < next.m.length && !next.x && this.chess.turn() !== next.me;
    if (moves.length < next.m.length || (next.x && !x) || dropped) await this.sendSync(lacked);
  }

  /**
   * Whether a sync's end is one this side could have reached, with `plies` on the sender's board:
   * - resign by the sender;
   * - agreed when this side's own offer stood at that ply;
   * - time with the sender out of time, in a timed game, with "clock" named by both (this side out of time only
   *   through a claim it accepted, which ended the game here already);
   * - aborted only before ply 2, with "abort" named by both;
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
        // The sender's own flag, on its own turn at that ply count (C6).
        return Boolean(game.tc) && this.negotiator.features.includes("clock") && x.by === sender && (plies % 2 === 0) === (sender === "w");
      case "aborted":
        return this.negotiator.features.includes("abort") && game.m.length < 2 && plies < 2;
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

  /**
   * "I hold n plies", from the contact on its turn: a proof that it had not made ply n yet (C4). The first one for our
   * ply times the round trip (C3); each one may make a claim (C7). An ack about another ply, or in an untimed game,
   * changes nothing.
   */
  private async onAck(g: string, n: number): Promise<void> {
    const game = this.game;
    if (!game?.tc || game.g !== g || n !== game.m.length || this.ended() || this.chess.turn() === game.me) return;
    const at = this.mono();
    this.heard = at;
    if (this.tsMono !== undefined && this.tsLive && !this.sampled) {
      this.samples = addSample(this.samples, at - this.tsMono);
      this.sampled = true;
    }
    this.lastAck = { n, at };
    if (this.wasSilent) {
      this.wasSilent = false;
      this.changed();
    }
    // Still acking with our claim at n unanswered: the claim was lost on the way. It goes again, every SILENT_MS at most.
    if (game.fl === n) {
      if (at - this.lastFlagSent >= SILENT_MS) await this.sendClaim(game, n);
      return;
    }
    if (this.tsMono !== undefined && timedPly(n) && mayClaim(at - this.tsMono, timeBefore(game.tc, alignedK(game), n), this.grace())) return this.claim(n);
    // The contact is back, in time by its proof: a pending claim of ours goes (C8).
    if (game.pc !== undefined) {
      this.game = without(game, "pc");
      await this.saveGame();
      this.changed();
    }
  }

  /**
   * A flag (C6, C7). `by` the sender: its own time ran out at ply count n (a self-report, or its answer accepting our
   * claim). `by` this side: a claim on our time, answered from our own clock at ply n: now when we hold n plies, at
   * our move when we already made ply n. We accept it only with less than GRACE_MIN_MS left (a floor the contact
   * cannot raise, unlike G), and a claim about a ply we already made only when it comes within Gmax of our send of
   * that ply, as a claim that crossed it does: a later one is stale, and disputed. Otherwise we dispute it. Either way
   * the game ends at ply n, so a move that crossed the claim is dropped on both sides, and both show the same end, also
   * when that move ended the game on the board.
   */
  private async onFlag(g: string, n: number, by: Colour): Promise<void> {
    const game = this.game;
    if (!game || game.g !== g) return;
    const sender = other(game.me);
    // A claim on our ply n, which we made already (it crossed the claim), is answered, even when that ply ended the
    // game on the board (a mate): no end off the board yet. Anything else not at n, or after an end, is stale.
    const crossed = Boolean(game.tc) && by === game.me && !game.x && n === game.m.length - 1 && this.chess.turn() === sender;
    if (!crossed && (this.ended() || n !== game.m.length)) return;
    if (!game.tc || !timedPly(n)) return this.notice("bad-message");
    this.heard = this.mono();
    if (by === sender) {
      if (n !== game.m.length || this.chess.turn() !== sender) return;
      this.pending = null;
      this.game = { ...without(noOffer(game), "pc"), x: { why: "time", by: sender } };
      await this.saveGame();
      this.changed();
      return;
    }
    let left: number;
    if (crossed) {
      // Our time at our move, if the claim came while it could have crossed it; a stale one is never accepted.
      const fresh = this.tsMono !== undefined && this.mono() - this.tsMono <= graceMax(game.tc);
      left = fresh ? alignedK(game)[n] - incrementAt(game.tc, n) : Infinity;
    } else if (this.chess.turn() === game.me) left = this.ownLeft() ?? 0;
    else return; // about another ply: stale
    const accept = left < GRACE_MIN_MS;
    if (n < game.m.length) this.chess = replay(game.m.slice(0, n)) ?? this.chess;
    const base = without({ ...noOffer(game), m: game.m.slice(0, n), k: alignedK(game).slice(0, n), fl: n }, "tw", "ts", "pc");
    this.turnStart = undefined;
    this.game = { ...base, x: accept ? { why: "time", by: game.me } : { why: "disputed" } };
    await this.saveGame();
    this.changed();
    if (accept) return void (await this.send({ k: "flag", g, n, by: game.me }));
    await this.send({ k: "dispute", g, n });
    await this.sendSync();
  }

  /** The claimed side disputes a claim: both end "clocks disagree", but only about a claim made at that ply. */
  private async onDispute(g: string, n: number): Promise<void> {
    if (!this.game || this.game.g !== g || n !== this.game.m.length || this.ended()) return;
    if (this.game.fl !== n) return this.notice("bad-message");
    this.heard = this.mono();
    this.pending = null;
    this.game = { ...without(noOffer(this.game), "pc"), x: { why: "disputed" } };
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
    if (!this.game || this.game.d !== "peer" || this.view().phase !== "playing" || this.claiming()) return;
    const n = this.game.dn ?? this.game.m.length;
    this.game = accept ? { ...noOffer(this.game), x: { why: "agreed" } } : noOffer(this.game);
    await this.saveGame();
    this.changed();
    await this.send({ k: "draw", g: this.game.g, o: accept ? "accept" : "decline", n });
  }

  // ---------- the clocks ----------

  /**
   * Our claim on the contact's time waits for its answer (C7). Meanwhile this side neither resigns nor answers a draw:
   * the contact would end the game by the claim and ignore it, and the two sides would show different results.
   */
  private claiming(): boolean {
    const game = this.game;
    return Boolean(game?.tc && game.fl !== undefined && game.fl === game.m.length && !game.x);
  }

  /** This side's time left now, on its own turn in a timed game; undefined otherwise. Before ply 2 it does not run. */
  private ownLeft(): number | undefined {
    const game = this.game;
    if (!this.inChat || !game?.tc || this.chess.turn() !== game.me || this.ended()) return undefined;
    const n = game.m.length;
    const P = timeBefore(game.tc, alignedK(game), n);
    return timedPly(n) ? P - (this.mono() - (this.turnStart ?? this.mono())) : P;
  }

  /** This side's time is up on its own turn, in a game going on. */
  private ownOut(): boolean {
    const left = this.ownLeft();
    return left !== undefined && left <= 0 && timedPly(this.game!.m.length) && !this.flip && !this.choosing && !this.stepPeerGame;
  }

  /** This side's time ran out (C6): the board locks, and the flag goes. A loss, or a draw against K, K+B or K+N. */
  private async selfFlag(): Promise<void> {
    const game = this.game!;
    this.turnStart = undefined;
    this.game = { ...without(noOffer(game), "tw"), x: { why: "time", by: game.me } };
    await this.saveGame();
    this.changed();
    await this.send({ k: "flag", g: game.g, n: game.m.length, by: game.me });
  }

  /** "I hold n plies" (C4), in a timed game with a contact that has clocks. */
  private async sendAck(game: SavedGame | null = this.game): Promise<void> {
    if (!game?.tc || !this.negotiator.features.includes("clock")) return;
    this.lastAckSent = this.mono();
    await this.send({ k: "ack", g: game.g, n: game.m.length });
  }

  /**
   * A frame carrying our last ply went out (C4): ts is when it first did, and moves to a later send only when
   * `again` (the contact's sync showed it lacked the ply). Saved with the game.
   */
  private async plySent(again: boolean): Promise<void> {
    const game = this.game;
    if (!game?.tc || !game.m.length || this.chess.turn() === game.me || this.ended()) return;
    if (game.ts !== undefined && this.tsMono !== undefined && !again) return;
    this.tsMono = this.mono();
    this.tsLive = true;
    this.sampled = false;
    this.lastAck = null;
    this.heard = this.tsMono;
    // Sent again: the contact never had our ply, so its turn starts afresh, and a pending claim of ours goes.
    this.game = { ...(again ? without(game, "pc") : game), ts: this.now() };
    await this.saveGame();
    if (again && game.pc !== undefined) this.changed();
  }

  /** The grace G of this game (C3). */
  private grace(): number {
    return grace(this.samples, this.game?.tc ?? [180, 0]);
  }

  /** The contact, on its timed turn (ply 2 on) and open, has sent nothing about this game that passed its checks for 10 s. */
  private peerSilent(): boolean {
    const game = this.game;
    if (!game?.tc || !this.peerOpen || this.ended() || this.chess.turn() === game.me || this.negotiator.mode !== "v2") return false;
    // Plies 0 and 1 are untimed: no periodic acks, and a first move may take a while.
    if (!timedPly(game.m.length)) return false;
    return this.mono() - this.heard > SILENT_MS;
  }

  /** "Your contact's clock looks off", once per game. */
  private clockOff(g: string): void {
    if (this.clockNoticed === g) return;
    this.clockNoticed = g;
    this.notice("clock-off");
  }

  /**
   * After a reload: both timers start again from the wall times kept (C9). This side's turn runs from tw, so its
   * clock ran while its Chess was closed; out of time, it flags at once (the sync on the next open carries it).
   */
  private async restoreClocks(): Promise<void> {
    const game = this.game;
    this.heard = this.mono();
    if (!game?.tc || this.ended()) return;
    const now = this.now();
    if (this.chess.turn() === game.me) {
      this.turnStart = startFromWall(game.tw ?? now, now, this.mono());
      if (this.ownOut()) {
        this.game = { ...without(noOffer(game), "tw"), x: { why: "time", by: game.me } };
        this.turnStart = undefined;
        await this.saveGame();
      }
    } else if (game.ts !== undefined) {
      this.tsMono = startFromWall(game.ts, now, this.mono());
      this.tsLive = false;
    }
  }

  /** On the contact's open, after our sync: our ack on our turn, and a claim of ours that waits for an answer. */
  private async openClocks(): Promise<void> {
    const game = this.game;
    if (!game?.tc || this.ended()) return;
    if (this.chess.turn() === game.me) return this.sendAck();
    if (game.fl !== undefined) await this.sendClaim(game, game.fl);
  }

  // ---------- helpers ----------

  /** Whether this side can play an invitation's terms: a clock and a rematch need the feature both sides named. */
  private playable(terms: { tc?: TimeControl; r?: string }): boolean {
    const features = this.negotiator.features;
    return (!terms.tc || features.includes("clock")) && (!terms.r || features.includes("rematch"));
  }

  /** The games a new toss gives up: ours, and the peer's when they differ. */
  private giveUp(): string[] {
    return [this.game?.g, this.stepPeerGame].filter((g): g is string => Boolean(g)).slice(0, 2);
  }

  /**
   * A new toss with a fresh salt, giving up these games, with these terms (none in version 1). It is for the deal of
   * the envelope its seek goes in (and goes again in, while the contact is away: see dealFor).
   */
  private async startToss(abandons: string[], terms: { tc?: TimeControl; r?: string } = {}): Promise<void> {
    this.flip = { v: 2, salt: newSalt(this.random), dv: this.negotiator.envelope, a: abandons.slice(0, 2), ...termsOf(terms) };
    await this.api.storage.set(KEY_FLIP, plain(this.flip));
    this.changed();
    await this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a, ...termsOf(this.flip) });
  }

  /** The toss is done: this is the game now. */
  private async begin(game: SavedGame): Promise<void> {
    this.game = game.tc ? { ...game, k: [] } : game;
    this.turnStart = this.tsMono = undefined;
    this.samples = [];
    this.lastAck = this.pending = null;
    this.heard = this.mono();
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

  /** Our game, for the contact to catch up from. `again`: it lacked our last ply, whose ts moves to this send (C4). */
  private async sendSync(again = false): Promise<void> {
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
      // Both clocks after the last ply (C9): after a missed ply, c[mover] is that move's t.
      if (game.tc) message.c = clocksAfter(game.tc, alignedK(game));
    }
    if (await this.send(message)) await this.plySent(again);
  }

  /**
   * Our state for a peer that sent something we could not place, at most once a second: false when held back.
   * `quiet`: sent again by tick(), so a refusal shows no new notice.
   */
  private async resync(quiet = false): Promise<boolean> {
    if (this.now() - this.lastResync < RESYNC_GAP_MS) return false;
    this.lastResync = this.now();
    this.quiet = quiet;
    try {
      if (this.negotiator.mode === "v1") await this.openV1();
      else await this.openV2();
    } finally {
      this.quiet = false;
    }
    return true;
  }

  /**
   * Sends a frame in the envelope now in force. Nothing goes while the contact's Chess is closed (frames are
   * live-only), nothing but our hello while its hello is awaited, and no kind 1.0.2 does not know in version 1.
   */
  private async send(message: Message): Promise<boolean> {
    if (!this.peerOpen) return false;
    if (this.negotiator.holding && message.k !== "hello") return false;
    const envelope = this.negotiator.envelope;
    if (envelope === 1 && !(V1_KINDS as readonly string[]).includes(message.k)) return false;
    try {
      await this.api.chat.send(plain(encodeMessage(message, envelope)));
      return true;
    } catch {
      // The peer closed or the chat dropped: the sync on its next open carries this. A lost ack says nothing. Refused
      // with the contact still open (a held session), our state goes again from tick().
      if (message.k !== "ack" && !this.quiet) this.notice("send-failed");
      if (this.peerOpen && ["move", "flag", "dispute", "sync"].includes(message.k)) this.retry = true;
      return false;
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
