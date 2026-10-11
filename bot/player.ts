/**
 * The bot as a player: it watches Chess's own controller (src/game.ts) and does what a person would with the buttons.
 * It invites or accepts an invitation, moves when it is its turn, and answers a draw offer, a takeback and a rematch.
 * It never resigns and never offers a draw: the person decides when a game with a bot ends early.
 */
import { Chess, type Square } from "chess.js";
import type { ChessController, Ending, View } from "../src/game.ts";
import type { TimeControl } from "../src/protocol.ts";
import { evaluate, pickMove, type Level } from "./engine.ts";

export interface Policy {
  level: Level;
  /** Accept the contact's invitations (a rematch among them). Off: the bot only plays the games it invites to. */
  accept: boolean;
  /** Let the contact take a move back. */
  takebacks: boolean;
  /** The time control the bot invites with; absent: it invites to no game, or (`unlimited`) to one without a clock. */
  invite?: TimeControl | "unlimited";
  /** A pause before each move, in ms, so the bot does not answer faster than a board can be read. */
  thinkMs?: number;
}

export type Said =
  | { what: "invited"; tc: TimeControl | null }
  | { what: "accepted" | "declined"; tc: TimeControl | null; rematch: boolean }
  | { what: "started"; colour: "w" | "b"; tc: TimeControl | null }
  | { what: "moved"; move: string; ply: number }
  | { what: "draw" | "takeback"; accepted: boolean }
  | { what: "over"; end: Ending; plies: number };

/** A draw is taken when the bot is clearly worse, or when a long game stands even. */
export function drawWelcome(fen: string, me: "w" | "b", plies: number): boolean {
  const chess = new Chess(fen);
  const mine = chess.turn() === me ? evaluate(chess) : -evaluate(chess);
  return mine <= -200 || (plies >= 120 && mine <= 50);
}

export class Player {
  private acting = false;
  private again = false;
  private stopped = false;
  private inviting: boolean;
  private game: { plies: number; over: boolean } | null = null;
  private readonly off: () => void;

  constructor(
    private readonly controller: ChessController,
    private readonly policy: Policy,
    private readonly say: (said: Said) => void = () => {},
    private readonly random: () => number = Math.random,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.inviting = policy.invite !== undefined;
    this.off = controller.subscribe(() => void this.act());
  }

  stop(): void {
    this.stopped = true;
    this.off();
  }

  /** One thing at a time: a change that comes while the bot acts is looked at when it is done. */
  async act(): Promise<void> {
    if (this.acting) { this.again = true; return; }
    this.acting = true;
    try {
      do {
        this.again = false;
        if (this.stopped) return;
        await this.step(this.controller.view());
      } while (this.again);
    } finally { this.acting = false; }
  }

  private async step(view: View): Promise<void> {
    const tc = view.tc ?? null;
    if (view.phase === "playing" && view.me && !this.game) {
      this.game = { plies: view.plies, over: false };
      this.inviting = false;
      this.say({ what: "started", colour: view.me, tc });
    }
    if (view.phase === "over" && view.end && this.game && !this.game.over) {
      this.game.over = true;
      this.say({ what: "over", end: view.end, plies: view.plies });
    }
    if (view.phase !== "playing" && view.phase !== "over") this.game = null;

    if (view.invitation) {
      const terms = { tc: view.invitation.tc ?? null, rematch: view.invitation.rematch };
      if (this.policy.accept && view.invitation.playable) {
        // A new game: what is said of the last one is done.
        this.game = null;
        this.inviting = false;
        await this.controller.acceptInvitation();
        this.say({ what: "accepted", ...terms });
      } else {
        await this.controller.declineInvitation();
        this.say({ what: "declined", ...terms });
      }
      return;
    }
    // The bot's own invitation, once the two sides have said hello (the controller takes one only then).
    if (this.inviting && !view.proposal && (view.phase === "setup" || view.phase === "invited") && view.peerOpen) {
      const invite = this.policy.invite === "unlimited" ? undefined : this.policy.invite;
      await this.controller.invite(invite);
      if (this.controller.view().proposal) { this.inviting = false; this.say({ what: "invited", tc: invite ?? null }); }
      return;
    }
    if (view.phase !== "playing" || !view.me) return;
    if (view.takeback === "peer") {
      await this.controller.answerTakeback(this.policy.takebacks);
      this.say({ what: "takeback", accepted: this.policy.takebacks });
      return;
    }
    if (view.drawOffer === "peer") {
      const accepted = drawWelcome(view.fen, view.me, view.plies);
      await this.controller.answerDraw(accepted);
      this.say({ what: "draw", accepted });
      return;
    }
    if (!view.canMove) return;
    if (this.policy.thinkMs) await this.sleep(this.policy.thinkMs);
    // Whatever came while it thought (a takeback asked, the game ended): looked at afresh.
    const now = this.controller.view();
    if (this.stopped || now.phase !== "playing" || !now.canMove || now.plies !== view.plies || now.takeback || now.drawOffer === "peer") { this.again = true; return; }
    const move = pickMove(now.fen, this.policy.level, this.random);
    if (!move) return;
    const played = await this.controller.move(move.slice(0, 2) as Square, move.slice(2, 4) as Square, (move[4] as "q" | "r" | "b" | "n" | undefined));
    if (played) this.say({ what: "moved", move, ply: now.plies });
  }
}
