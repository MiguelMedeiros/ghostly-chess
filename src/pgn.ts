/**
 * The game as PGN (the Portable Game Notation standard, section 8): the Seven Tag Roster, then ECO, Opening,
 * TimeControl and Termination, a blank line, and the SAN movetext with move numbers, wrapped at 80 columns and ending
 * with the result.
 *
 * Players are "?", the standard's unknown, until a later version knows their names. A game from Chess 1.0.2 has no
 * start date, so its Date is "????.??.??".
 */
import type { ChessController } from "./game.ts";
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
  });
  tokens.push(game.result);
  return `${tags.map(([name, value]) => `[${name} "${escapeTag(value)}"]`).join("\n")}\n\n${wrap(tokens)}\n`;
}

/** The PGN of the game a controller holds: its moves, its result ("*" while it goes on), its date and opening. */
export function pgnOfGame(game: Pick<ChessController, "record" | "view" | "startDate">): string {
  const record = game.record();
  return toPgn({
    sans: record.sans,
    result: game.view().end?.result ?? "*",
    date: game.startDate(),
    opening: openingOf(record.fens.slice(1)),
  });
}
