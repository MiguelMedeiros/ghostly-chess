/**
 * The game as PGN (the Portable Game Notation standard, section 8): the Seven Tag Roster, then ECO, Opening,
 * TimeControl and Termination, a blank line, and the SAN movetext with move numbers, wrapped at 80 columns and ending
 * with the result.
 *
 * A timed game has TimeControl "300+2" and a [%clk h:mm:ss] comment after each move from ply 2 (the mover's time
 * after it); a game lost on time ends "time forfeit", one whose clocks disagreed "unterminated" and an aborted one
 * "abandoned" (both with "*").
 *
 * White and Black are the players' names in a chat (this side's own, the contact's from its hello, both cleaned and
 * escaped here), or "?", the standard's unknown, without one. A game from Chess 1.0.2 has no start date, so its Date
 * is "????.??.??".
 */
import { clkText } from "./clock.ts";
import type { ChessController } from "./game.ts";
import { tcText } from "./protocol.ts";
import { openingOf, type Opening } from "./openings.ts";

export type Result = "1-0" | "0-1" | "1/2-1/2" | "*";

export interface PgnGame {
  sans: readonly string[];
  result: Result;
  /** "YYYY.MM.DD". */
  date?: string;
  opening?: Opening;
  white?: string;
  black?: string;
  /** "-" when the game has no clock. */
  timeControl?: string;
  /** Overrides the default: "normal" for a finished game, "unterminated" for "*". */
  termination?: string;
  /** Each ply's mover's time after it, in ms, for the %clk comments (plies 0 and 1 have none). */
  clocks?: readonly number[];
}

const WIDTH = 80;

/** A tag value with its quotes and backslashes escaped. */
export function escapeTag(value: string): string {
  return value.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\r\n\t]/g, " ");
}

/** Tokens joined by spaces, a line break instead of a space wherever a line would pass `width`. */
export function wrap(tokens: readonly string[], width = WIDTH): string {
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    if (line && line.length + 1 + token.length > width) {
      lines.push(line);
      line = token;
    } else line = line ? `${line} ${token}` : token;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

export function toPgn(game: PgnGame): string {
  const tags: [string, string][] = [
    ["Event", "Ghostly chess"],
    ["Site", "Ghostly"],
    ["Date", game.date ?? "????.??.??"],
    ["Round", "-"],
    ["White", game.white ?? "?"],
    ["Black", game.black ?? "?"],
    ["Result", game.result],
    ["ECO", game.opening?.eco ?? "?"],
    ["Opening", game.opening?.name ?? "?"],
    ["TimeControl", game.timeControl ?? "-"],
    ["Termination", game.termination ?? (game.result === "*" ? "unterminated" : "normal")],
  ];
  const tokens: string[] = [];
  game.sans.forEach((san, i) => {
    if (i % 2 === 0) tokens.push(`${i / 2 + 1}.`);
    tokens.push(san);
    // One token, so a line never breaks inside the comment.
    if (i >= 2 && game.clocks?.[i] !== undefined) tokens.push(`{[%clk ${clkText(game.clocks[i])}]}`);
  });
  tokens.push(game.result);
  return `${tags.map(([name, value]) => `[${name} "${escapeTag(value)}"]`).join("\n")}\n\n${wrap(tokens)}\n`;
}

/** The PGN of the game a controller holds: its moves, its result ("*" while it goes on), its date and opening. */
export function pgnOfGame(game: Pick<ChessController, "record" | "view" | "startDate"> & Partial<Pick<ChessController, "clockRecord">>): string {
  const record = game.record();
  const view = game.view();
  const end = view.end;
  const clocks = game.clockRecord?.();
  const nameOf = (colour: "w" | "b") => (view.me ? (colour === view.me ? view.ownName : view.peerName) : undefined);
  return toPgn({
    sans: record.sans,
    result: end?.result ?? "*",
    date: game.startDate(),
    white: nameOf("w"),
    black: nameOf("b"),
    opening: openingOf(record.fens.slice(1)),
    timeControl: clocks ? tcText(clocks.tc) : undefined,
    clocks: clocks?.k,
    termination: end?.why === "time" || end?.why === "timeMaterial" ? "time forfeit" : end?.why === "aborted" ? "abandoned" : undefined,
  });
}
