// covers: apps.chess
// The PGN export: headers, escaping, the date from the game record, movetext that chess.js loads back, result tokens.
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { ChessController, type SavedGame } from "../src/game.ts";
import { pgnOfGame, toPgn, wrap } from "../src/pgn.ts";
import { chatPair, MockBroker } from "./mockBroker.ts";
import { open, play, settle, startAlone, startChat } from "./sides.ts";

const tags = (pgn: string) => Object.fromEntries([...pgn.matchAll(/^\[(\w+) "((?:[^"\\]|\\.)*)"\]$/gm)].map((m) => [m[1], m[2]]));

describe("PGN", () => {
  it("writes the Seven Tag Roster, then ECO, Opening, TimeControl and Termination", () => {
    const pgn = toPgn({ sans: ["e4", "c5"], result: "*", date: "2026.10.08", opening: { eco: "B20", name: "Sicilian Defense", ply: 2 } });
    expect(Object.keys(tags(pgn))).toEqual(["Event", "Site", "Date", "Round", "White", "Black", "Result", "ECO", "Opening", "TimeControl", "Termination"]);
    expect(tags(pgn)).toEqual({
      Event: "Ghostly chess",
      Site: "Ghostly",
      Date: "2026.10.08",
      Round: "-",
      White: "?",
      Black: "?",
      Result: "*",
      ECO: "B20",
      Opening: "Sicilian Defense",
      TimeControl: "-",
      Termination: "unterminated",
    });
    expect(pgn.endsWith("\n\n1. e4 c5 *\n")).toBe(true);
  });

  it("escapes quotes and backslashes in tag values", () => {
    const pgn = toPgn({ sans: [], result: "1-0", white: 'Ana "the rook" \\o/', opening: { eco: "C60", name: 'a "b"', ply: 5 } });
    expect(pgn).toContain('[White "Ana \\"the rook\\" \\\\o/"]');
    expect(pgn).toContain('[Opening "a \\"b\\""]');
    expect(pgn).toContain('[Termination "normal"]');
    expect(pgn.trimEnd().endsWith("1-0")).toBe(true);
  });

  it("wraps the movetext at 80 columns without breaking a token", () => {
    const tokens = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? `${i / 3 + 1}.` : "Nxf7+"));
    const text = wrap(tokens);
    expect(text.split("\n").every((line) => line.length <= 80)).toBe(true);
    expect(text.split(/\s+/)).toEqual(tokens);
  });

  it("dates a game from its start date, and a game migrated from 1.0.2 '????.??.??'", async () => {
    // The toss completes on 8 October 2026 at noon, local time.
    const at = new Date(2026, 9, 8, 12, 0, 0).getTime();
    const [a, b] = chatPair();
    a.launch();
    b.launch();
    const ana = new ChessController(a, { now: () => at });
    const bob = new ChessController(b, { now: () => at });
    await ana.start();
    await bob.start();
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all([ana.settled(), bob.settled()]);
    expect(ana.startDate()).toBe("2026.10.08");
    expect((JSON.parse(a.stored.get("game")!) as SavedGame).sd).toBe("2026.10.08");
    expect(tags(pgnOfGame(ana)).Date).toBe("2026.10.08");

    // A record as Chess 1.0.2 saved it: no sd.
    const old = new MockBroker("old", "1.0.2");
    const record = JSON.parse(a.stored.get("game")!) as SavedGame;
    delete record.sd;
    old.stored.set("game", JSON.stringify(record));
    const migrated = await open(old);
    expect(migrated.game.startDate()).toBeUndefined();
    expect(tags(pgnOfGame(migrated.game)).Date).toBe("????.??.??");
    // A damaged sd is dropped, not shown.
    const damaged = new MockBroker("dmg", "1.2.0");
    damaged.stored.set("game", JSON.stringify({ ...record, sd: "8 Oct" }));
    damaged.launch();
    const reread = new ChessController(damaged);
    await reread.start();
    expect(reread.startDate()).toBeUndefined();
  });

  it("loads back in chess.js to the same position, with the opening named", async () => {
    const sides = await startChat();
    await play(sides, "e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7");
    const pgn = pgnOfGame(sides.white.game);
    expect(tags(pgn)).toMatchObject({ ECO: "C84", Result: "*", Termination: "unterminated" });
    expect(tags(pgn).Opening).toMatch(/^Ruy Lopez/);
    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.fen()).toBe(sides.white.game.view().fen);
    expect(chess.getHeaders().Event).toBe("Ghostly chess");
  });

  it("writes the result token each ending requires", async () => {
    const result = (pgn: string) => tags(pgn).Result;
    // White mates: 1-0.
    const mate = await startAlone();
    for (const uci of ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"]) await mate.game.move(uci.slice(0, 2) as never, uci.slice(2, 4) as never);
    expect(result(pgnOfGame(mate.game))).toBe("1-0");
    expect(pgnOfGame(mate.game).trimEnd().endsWith("Qxf7# 1-0")).toBe(true);
    // Black mates: 0-1.
    const fool = await startAlone();
    for (const uci of ["f2f3", "e7e5", "g2g4", "d8h4"]) await fool.game.move(uci.slice(0, 2) as never, uci.slice(2, 4) as never);
    expect(result(pgnOfGame(fool.game))).toBe("0-1");
    // Resignation: the other side wins. A draw by agreement: 1/2-1/2.
    const resigned = await startChat();
    await play(resigned, "e2e4");
    await resigned.white.game.resign();
    await settle(resigned.white, resigned.black);
    expect(result(pgnOfGame(resigned.white.game))).toBe("0-1");
    expect(result(pgnOfGame(resigned.black.game))).toBe("0-1");
    const agreed = await startChat();
    await play(agreed, "e2e4");
    await agreed.white.game.offerDraw();
    await settle(agreed.white, agreed.black);
    await agreed.black.game.answerDraw(true);
    await settle(agreed.white, agreed.black);
    expect(result(pgnOfGame(agreed.white.game))).toBe("1/2-1/2");
    // Still going: "*".
    const going = await startChat();
    await play(going, "d2d4");
    expect(result(pgnOfGame(going.black.game))).toBe("*");
    // Each loads back in chess.js.
    for (const g of [mate, fool]) expect(() => new Chess().loadPgn(pgnOfGame(g.game))).not.toThrow();
  });
});
