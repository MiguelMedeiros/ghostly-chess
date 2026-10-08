// covers: apps.chess
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { boardEnding, replay } from "../src/game.ts";
import {
  compareVersions,
  encodeMessage,
  encodeV1,
  encodeV2,
  FEATURE_NAMES,
  jsonBytes,
  MAX_MESSAGE_BYTES,
  MAX_PLIES,
  parseMessage,
  PROTO2_SINCE,
  speaksV2,
  V1_KEYS,
  type Message,
} from "../src/protocol.ts";
import { commitment, deal, deal2, newSalt, termsText } from "../src/toss.ts";
import { en, LANGUAGES, pickLanguage, stringsFor } from "../src/strings.ts";

const g = "0123456789abcdef";

describe("the message protocol", () => {
  it("reads back every kind of version 1 message it writes, with exactly 1.0.2's keys", () => {
    const messages: Message[] = [
      { k: "seek", c: commitment(newSalt()), a: [g] },
      { k: "reveal", s: newSalt(), c: commitment(newSalt()) },
      { k: "move", g, n: 0, m: "e2e4" },
      { k: "move", g, n: 41, m: "a7a8n" },
      { k: "sync", g, s: [newSalt(), newSalt()], m: ["e2e4", "e7e5"], x: { why: "resign", by: "w" } },
      { k: "sync", g, s: [newSalt(), newSalt()], m: [] },
      { k: "resign", g },
      { k: "draw", g, o: "offer" },
    ];
    for (const message of messages) {
      const wire = encodeMessage(message, 1);
      expect(wire).toMatchObject({ p: "chess", v: 1, k: message.k });
      const keys = Object.keys(wire as object).filter((k) => !["p", "v", "k"].includes(k));
      expect(V1_KEYS[message.k as keyof typeof V1_KEYS]).toEqual(expect.arrayContaining(keys));
      expect(parseMessage(JSON.parse(JSON.stringify(wire)))).toEqual({ ok: true, v: 1, message });
    }
  });

  it("leaves every v2 field out of a version 1 frame, and refuses to write a v2 kind or end in one", () => {
    const seek = encodeV1({ k: "seek", c: commitment(newSalt()), a: [], tc: [300, 0], r: g });
    expect(Object.keys(seek as object)).toEqual(["p", "v", "k", "c", "a"]);
    expect(Object.keys(encodeV1({ k: "move", g, n: 2, m: "e2e4", t: 1000 }) as object)).toEqual(["p", "v", "k", "g", "n", "m"]);
    expect(Object.keys(encodeV1({ k: "draw", g, o: "offer", n: 3 }) as object)).toEqual(["p", "v", "k", "g", "o"]);
    const sync = encodeV1({ k: "sync", g, s: [newSalt(), newSalt()], m: [], tc: [60, 0], c: [1, 2], tb: 1, d: ["w", 0], r: g });
    expect(Object.keys(sync as object)).toEqual(["p", "v", "k", "g", "s", "m"]);
    for (const message of [
      { k: "hello", pv: 2, f: [] },
      { k: "decline", c: commitment(newSalt()) },
      { k: "ack", g, n: 1 },
      { k: "flag", g, n: 1, by: "w" },
      { k: "dispute", g, n: 1 },
      { k: "takeback", g, n: 1, o: "ask", h: 2 },
    ] as Message[]) expect(() => encodeV1(message), message.k).toThrow(/no version 1 form/);
    expect(() => encodeV1({ k: "sync", g, s: [newSalt(), newSalt()], m: [], x: { why: "aborted" } })).toThrow(/version 1/);
  });

  it("reads a version 1 frame as 1.0.2 does: a v2 field in it is ignored", () => {
    const c = commitment(newSalt());
    expect(parseMessage({ p: "chess", v: 1, k: "seek", c, a: [], tc: [300, 0] })).toEqual({ ok: true, v: 1, message: { k: "seek", c, a: [] } });
    expect(parseMessage({ p: "chess", v: 1, k: "hello", pv: 2, f: [] })).toEqual({ ok: false, reason: "malformed" });
    expect(parseMessage({ p: "chess", v: 1, k: "sync", g, s: [newSalt(), newSalt()], m: "", x: { why: "aborted" } })).toEqual({ ok: false, reason: "malformed" });
  });

  it("reads back every kind of version 2 message it writes", () => {
    const messages: Message[] = [
      { k: "hello", pv: 2, f: [...FEATURE_NAMES] },
      { k: "hello", pv: 2, f: [], n: "Ana" },
      { k: "seek", c: commitment(newSalt()), a: [g] },
      { k: "seek", c: commitment(newSalt()), a: [], tc: [180, 2], r: g },
      { k: "decline", c: commitment(newSalt()) },
      { k: "reveal", s: newSalt(), c: commitment(newSalt()) },
      { k: "move", g, n: 0, m: "e2e4" },
      { k: "move", g, n: 41, m: "a7a8n", t: 123456 },
      { k: "ack", g, n: 42 },
      { k: "flag", g, n: 42, by: "b" },
      { k: "dispute", g, n: 42 },
      { k: "sync", g, s: [newSalt(), newSalt()], m: ["e2e4", "e7e5"], x: { why: "time", by: "w" }, tc: [300, 0], r: g, c: [1000, 2000], tb: 2, d: ["b", 2] },
      { k: "sync", g, s: [newSalt(), newSalt()], m: [], x: { why: "aborted" } },
      { k: "sync", g, s: [newSalt(), newSalt()], m: ["e2e4"], x: { why: "disputed" } },
      { k: "sync", g, s: [newSalt(), newSalt()], m: [], x: { why: "agreed" } },
      { k: "resign", g },
      { k: "draw", g, o: "offer", n: 0 },
      { k: "draw", g, o: "accept", n: 12 },
      { k: "takeback", g, n: 10, o: "ask", h: 11 },
      { k: "takeback", g, n: 10, o: "decline" },
    ];
    const seen = new Set<string>();
    for (const message of messages) {
      const wire = encodeMessage(message);
      expect(wire).toMatchObject({ p: "chess", v: 2, k: message.k });
      expect(parseMessage(JSON.parse(JSON.stringify(wire)))).toEqual({ ok: true, v: 2, message });
      seen.add(message.k);
    }
    expect([...seen].sort()).toEqual(["ack", "decline", "dispute", "draw", "flag", "hello", "move", "resign", "reveal", "seek", "sync", "takeback"]);
  });

  it("refuses a whole v2 frame with a field out of bounds", () => {
    const salt = newSalt();
    const c = commitment(salt);
    const s = [newSalt(), newSalt()];
    const bad: Record<string, unknown>[] = [
      // tc: base 15..10800 s, increment 0..60 s, integers, a pair
      { k: "seek", c, a: [], tc: [14, 0] },
      { k: "seek", c, a: [], tc: [10801, 0] },
      { k: "seek", c, a: [], tc: [300, 61] },
      { k: "seek", c, a: [], tc: [300, -1] },
      { k: "seek", c, a: [], tc: [300.5, 0] },
      { k: "seek", c, a: [], tc: [300] },
      { k: "seek", c, a: [], tc: "300+0" },
      { k: "seek", c, a: [], r: "nope" },
      { k: "sync", g, s, m: "", tc: [9, 0] },
      // t: an integer of ms in 0..2^31-1
      { k: "move", g, n: 2, m: "e2e4", t: -1 },
      { k: "move", g, n: 2, m: "e2e4", t: 2 ** 31 },
      { k: "move", g, n: 2, m: "e2e4", t: 1.5 },
      { k: "move", g, n: 2, m: "e2e4", t: "1000" },
      { k: "sync", g, s, m: "", c: [0, 2 ** 31] },
      { k: "sync", g, s, m: "", c: [0] },
      // n: a ply count in 0..2000
      { k: "ack", g, n: -1 },
      { k: "ack", g, n: MAX_PLIES + 1 },
      { k: "flag", g, n: 1.5, by: "w" },
      { k: "flag", g, n: 1, by: "x" },
      { k: "dispute", g },
      { k: "draw", g, o: "offer" },
      { k: "draw", g, o: "offer", n: MAX_PLIES + 1 },
      { k: "takeback", g, n: MAX_PLIES, o: "ask", h: MAX_PLIES },
      { k: "takeback", g, n: 1, o: "maybe" },
      // an ask names the plies its sender held: 1..2000
      { k: "takeback", g, n: 1, o: "ask" },
      { k: "takeback", g, n: 1, o: "ask", h: 0 },
      { k: "takeback", g, n: 1, o: "ask", h: MAX_PLIES + 1 },
      { k: "takeback", g, n: 1, o: "ask", h: "2" },
      { k: "sync", g, s, m: "", d: ["w", MAX_PLIES + 1] },
      { k: "sync", g, s, m: "", d: ["x", 0] },
      { k: "sync", g, s, m: "", tb: -1 },
      // the name: a string (one over 48 code points is cut, not refused: see below)
      { k: "hello", pv: 2, f: [], n: 7 },
      { k: "hello", pv: 2, f: [], n: ["Ana"] },
      { k: "hello", pv: 2, f: [], n: null },
      // the features: at most 16 names of [a-z-], each 16 characters or fewer
      { k: "hello", pv: 2, f: Array.from({ length: 17 }, (_, i) => `f${"abcdefghijklmnopq"[i]}`) },
      { k: "hello", pv: 2, f: ["Clock"] },
      { k: "hello", pv: 2, f: ["a".repeat(17)] },
      { k: "hello", pv: 2, f: [""] },
      { k: "hello", pv: 2, f: "clock" },
      { k: "hello", pv: 1, f: [] },
      // the salt: 64 hex digits
      { k: "decline", c: "abc" },
      { k: "reveal", s: salt.toUpperCase(), c },
      { k: "seek", c: `${c}0`, a: [] },
      { k: "sync", g, s: [s[0], "00"], m: "" },
      { k: "sync", g, s, m: "", x: { why: "time" } },
    ];
    for (const frame of bad) expect(parseMessage({ p: "chess", v: 2, ...frame }), JSON.stringify(frame)).toEqual({ ok: false, reason: "malformed" });
    // At the bounds, they are taken.
    expect(parseMessage({ p: "chess", v: 2, k: "seek", c, a: [], tc: [15, 60] }).ok).toBe(true);
    expect(parseMessage({ p: "chess", v: 2, k: "seek", c, a: [], tc: [10800, 0] }).ok).toBe(true);
    expect(parseMessage({ p: "chess", v: 2, k: "move", g, n: 2, m: "e2e4", t: 2 ** 31 - 1 }).ok).toBe(true);
    expect(parseMessage({ p: "chess", v: 2, k: "hello", pv: 2, f: Array.from({ length: 16 }, () => "a".repeat(16)), n: "😀".repeat(48) }).ok).toBe(true);
  });

  it("cleans a hello's name, and keeps feature names it does not know", () => {
    expect(parseMessage({ p: "chess", v: 2, k: "hello", pv: 2, f: ["clock", "later-thing", "clock"], n: "  Ana\u202e\u0007  Silva " })).toEqual({
      ok: true,
      v: 2,
      message: { k: "hello", pv: 2, f: ["clock", "later-thing"], n: "Ana Silva" },
    });
    expect(parseMessage({ p: "chess", v: 2, k: "hello", pv: 3, f: [], n: "\u200b" })).toEqual({ ok: true, v: 2, message: { k: "hello", pv: 3, f: [] } });
  });

  it("cuts a hello's name over 48 code points instead of refusing the hello", () => {
    // A display field never stops two sides from pairing: a later Chess may allow longer names.
    const hello = (n: string) => parseMessage({ p: "chess", v: 2, k: "hello", pv: 2, f: [], n });
    expect(hello("a".repeat(49))).toEqual({ ok: true, v: 2, message: { k: "hello", pv: 2, f: [], n: "a".repeat(48) } });
    expect(hello("😀".repeat(49))).toEqual({ ok: true, v: 2, message: { k: "hello", pv: 2, f: [], n: "😀".repeat(48) } });
    expect(hello(`${"a".repeat(47)} ${"b".repeat(4000)}`)).toEqual({ ok: true, v: 2, message: { k: "hello", pv: 2, f: [], n: "a".repeat(47) } });
    // The frame's own cap still holds.
    expect(hello("a".repeat(17000))).toEqual({ ok: false, reason: "too-big" });
  });

  it("keeps a hello's re: 1 (an answer), and refuses any other re", () => {
    const answer: Message = { k: "hello", pv: 2, f: [], re: 1 };
    expect(parseMessage(encodeMessage(answer))).toEqual({ ok: true, v: 2, message: answer });
    expect(parseMessage({ p: "chess", v: 2, k: "hello", pv: 2, f: [] })).toEqual({ ok: true, v: 2, message: { k: "hello", pv: 2, f: [] } });
    for (const re of [0, 2, "1", true, null]) {
      expect(parseMessage({ p: "chess", v: 2, k: "hello", pv: 2, f: [], re }), JSON.stringify(re)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("gives newer-version for a frame of version 3 or later, and ignores unknown extra fields", () => {
    expect(parseMessage({ p: "chess", v: 3, k: "hello", pv: 3, f: [] })).toEqual({ ok: false, reason: "newer-version" });
    expect(parseMessage({ p: "chess", v: 9, k: "anything" })).toEqual({ ok: false, reason: "newer-version" });
    expect(parseMessage({ p: "chess", v: 2, k: "resign", g, extra: { deep: [1] } })).toEqual({ ok: true, v: 2, message: { k: "resign", g } });
  });

  it("fits the longest v2 sync, with clocks and terms, in 16 KiB", () => {
    const longest: Message = {
      k: "sync",
      g,
      s: [newSalt(), newSalt()],
      m: Array.from({ length: MAX_PLIES }, () => "e7e8q"),
      x: { why: "time", by: "b" },
      tc: [10800, 60],
      r: g,
      c: [2 ** 31 - 1, 2 ** 31 - 1],
      tb: 2 ** 31 - 1,
      d: ["w", MAX_PLIES],
    };
    expect(jsonBytes(encodeV2(longest))).toBeLessThanOrEqual(16 * 1024);
  });

  it("fits the longest game in one sync, well under the 32 KiB frame cap", () => {
    const longest: Message = { k: "sync", g, s: [newSalt(), newSalt()], m: Array.from({ length: MAX_PLIES }, () => "e7e8q"), x: { why: "agreed" } };
    const bytes = jsonBytes(encodeMessage(longest, 1));
    expect(bytes).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(MAX_MESSAGE_BYTES).toBeLessThanOrEqual(32 * 1024 / 2);
  });

  it("refuses to write a message over the cap", () => {
    const tooLong: Message = { k: "sync", g, s: [newSalt(), newSalt()], m: Array.from({ length: 4000 }, () => "e7e8q") };
    expect(() => encodeMessage(tooLong)).toThrow(/over/);
  });

  it("refuses more plies than a game may have, and values JSON cannot carry", () => {
    const m = Array.from({ length: MAX_PLIES + 1 }, () => "e2e4").join(" ");
    expect(parseMessage({ p: "chess", v: 1, k: "sync", g, s: [newSalt(), newSalt()], m })).toEqual({ ok: false, reason: "malformed" });
    expect(parseMessage({ p: "chess", v: 1, k: "move", g, n: MAX_PLIES, m: "e2e4" })).toEqual({ ok: false, reason: "malformed" });
    expect(parseMessage(undefined)).toEqual({ ok: false, reason: "too-big" });
    expect(parseMessage({ toJSON: () => { throw new Error("no"); } })).toEqual({ ok: false, reason: "too-big" });
  });
});

describe("the colour toss", () => {
  it("gives both sides the same game id and opposite colours", () => {
    for (let i = 0; i < 20; i++) {
      const a = newSalt();
      const b = newSalt();
      const fromA = deal(a, b);
      const fromB = deal(b, a);
      expect(fromA.g).toBe(fromB.g);
      expect(fromA.g).toMatch(/^[0-9a-f]{16}$/);
      expect(fromA.me).not.toBe(fromB.me);
    }
  });

  it("refuses equal salts", () => {
    const salt = newSalt();
    expect(() => deal(salt, salt)).toThrow();
  });

  it("commits to a salt without showing it", () => {
    const salt = newSalt();
    expect(commitment(salt)).toMatch(/^[0-9a-f]{64}$/);
    expect(commitment(salt)).not.toContain(salt.slice(0, 16));
    expect(commitment(salt)).toBe(commitment(salt));
  });
});

describe("the rules", () => {
  const at = (fen: string) => new Chess(fen);
  it("knows mate, stalemate, bare kings and the 50-move rule", () => {
    expect(boardEnding(replay(["f2f3", "e7e5", "g2g4", "d8h4"])!, 4)).toEqual({ result: "0-1", why: "checkmate" });
    expect(boardEnding(at("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"), 1)).toEqual({ result: "1/2-1/2", why: "stalemate" });
    expect(boardEnding(at("8/8/4k3/8/8/4K3/8/8 w - - 0 1"), 1)).toEqual({ result: "1/2-1/2", why: "material" });
    expect(boardEnding(at("8/8/4k3/8/8/4K3/8/R7 w - - 100 90"), 1)).toEqual({ result: "1/2-1/2", why: "fifty" });
    expect(boardEnding(new Chess(), MAX_PLIES)).toEqual({ result: "1/2-1/2", why: "limit" });
    expect(boardEnding(new Chess(), 0)).toBeUndefined();
  });

  it("replays only legal plies, with the promotion exactly when there is one", () => {
    expect(replay(["e2e4", "e7e5"])?.history()).toHaveLength(2);
    expect(replay(["e2e5"])).toBeNull();
    expect(replay(["e2e4q"])).toBeNull();
    const promote = ["a2a4", "b7b5", "a4b5", "a7a6", "b5a6", "c8b7", "a6b7", "b8c6"];
    expect(replay([...promote, "b7a8"])).toBeNull();
    expect(replay([...promote, "b7a8n"])?.history().at(-1)).toBe("bxa8=N");
  });
});

describe("strings", () => {
  it("picks one of the 8 app languages from a locale, English otherwise", () => {
    expect(pickLanguage("pt-BR")).toBe("pt");
    expect(pickLanguage("zh_Hant")).toBe("zh");
    expect(pickLanguage("de-DE")).toBe("en");
    expect(pickLanguage(undefined)).toBe("en");
    expect(stringsFor("de" as never).newGame).toBe("New game");
  });

  it("has every word in each of the 8 languages, not English in their place", () => {
    for (const language of LANGUAGES) {
      const words = stringsFor(language);
      for (const key of Object.keys(en) as (keyof typeof en)[]) expect(words[key].trim(), `${language}.${key}`).not.toBe("");
      if (language === "en") continue;
      // Only the square names, which are the same everywhere, may match English; and the chess words "Bullet" and
      // "Blitz" with the time-control patterns made of numbers and units, which most of these languages use as is.
      const international = new Set(["tc_bullet", "tc_blitz", "tc_words", "tc_wordsInc"]);
      const same = (Object.keys(en) as (keyof typeof en)[]).filter((key) => words[key] === en[key] && !international.has(key));
      expect(same, language).toEqual([]);
    }
    expect(stringsFor("pt").yourMove).toBe("Sua vez");
    expect(stringsFor("ar").newGame).toBe("لعبة جديدة");
  });

  it("never names Abort as Cancel: one tap on Abort ends the game, Cancel closes a dialog", () => {
    for (const language of LANGUAGES) {
      const words = stringsFor(language);
      expect(words.abort.trim().toLowerCase(), language).not.toBe(words.cancel.trim().toLowerCase());
    }
  });
});

describe("versions", () => {
  it("compares semver, a prerelease below its release, and tells a protocol 2 peer by its version", () => {
    expect(PROTO2_SINCE).toBe("2.0.0");
    expect(compareVersions("1.0.2", PROTO2_SINCE)).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0", "2.0.0+build.7")).toBe(0);
    expect(compareVersions("2.0.0-rc.1", "2.0.0")).toBe(-1);
    expect(compareVersions("2.0.0-rc.2", "2.0.0-rc.10")).toBe(-1);
    expect(compareVersions("2.0.0-alpha", "2.0.0-1")).toBe(1);
    expect(compareVersions("dev", "2.0.0")).toBeNull();
    for (const version of ["1.0.2", "1.2.0", "1.99.99", "2.0.0-rc.1", "dev", "", "2", "v2.0.0", undefined, null, 2]) expect(speaksV2(version), String(version)).toBe(false);
    for (const version of ["2.0.0", "2.0.1", "2.10.0", "3.0.0"]) expect(speaksV2(version), version).toBe(true);
  });
});

describe("the v2 deal", () => {
  it("binds the terms into the game id, keeps the v1 deal as it was, and swaps colours in a rematch", () => {
    const a = newSalt();
    const b = newSalt();
    expect(termsText({})).toBe("tc=-;r=-");
    expect(termsText({ tc: [300, 2], r: g })).toBe(`tc=300+2;r=${g}`);
    const plain = deal2(a, b, {});
    expect(plain).toEqual({ g: deal2(a, b, {}).g, me: plain.me });
    expect(deal2(b, a, {}).g).toBe(plain.g);
    expect(deal2(b, a, {}).me).not.toBe(plain.me);
    expect(plain.g).not.toBe(deal(a, b).g);
    expect(deal2(a, b, { tc: [300, 0] }).g).not.toBe(plain.g);
    expect(deal2(a, b, { r: g }, "w").g).not.toBe(plain.g);
    expect(deal2(a, b, { r: g }, "w").me).toBe("b");
    expect(deal2(b, a, { r: g }, "b").me).toBe("w");
    expect(() => deal2(a, b, { r: g })).toThrow(/rematch/);
    expect(() => deal2(a, a, {})).toThrow(/same salt/);
    expect(plain.g).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives each side the same game and opposite colours, and either colour comes up", () => {
    const colours = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const a = newSalt();
      const b = newSalt();
      const mine = deal2(a, b, { tc: [180, 2] });
      const theirs = deal2(b, a, { tc: [180, 2] });
      expect(mine.g).toBe(theirs.g);
      expect(mine.me).not.toBe(theirs.me);
      colours.add(mine.me);
    }
    expect(colours).toEqual(new Set(["w", "b"]));
  });
});
