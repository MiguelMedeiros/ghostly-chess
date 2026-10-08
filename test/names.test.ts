// @vitest-environment happy-dom
// covers: apps.chess
// Players' names (2.3.0): each side's own display name (context().name, the `name` permission) goes in its hello to a
// contact that shows names, cleaned before it goes and again on receipt, and the strips, the announcements and the PGN
// use it. Without the permission nothing is sent and the words "You" and "Your contact" stay.
import { afterEach, describe, expect, it } from "vitest";
import { ChessController } from "../src/game.ts";
import { cleanName, initials } from "../src/names.ts";
import { pgnOfGame } from "../src/pgn.ts";
import { encodeMessage, MAX_NAME, type Feature } from "../src/protocol.ts";
import { en } from "../src/strings.ts";
import { chatPair, type MockBroker } from "./mockBroker.ts";
import { agree, mount, play, settle, type Side } from "./sides.ts";
import { PrefsStore } from "../src/prefs.ts";
import type { Notice } from "../src/game.ts";

afterEach(() => document.body.replaceChildren());

/** Chess 2.2.0's features: it names no "names". */
const V220: readonly Feature[] = ["clock", "takeback", "rematch", "abort"];

async function openAs(broker: MockBroker, name?: string, features?: readonly Feature[]): Promise<Side> {
  broker.displayName = name;
  broker.launch();
  const game = new ChessController(broker, features ? { features } : {});
  const notices: Notice[] = [];
  game.onNotice((n) => notices.push(n));
  const prefs = new PrefsStore(broker);
  await prefs.load();
  await game.start();
  return { broker, game, notices, prefs };
}

const hellos = (broker: MockBroker) => broker.sent.filter((f) => (f as { k?: string }).k === "hello") as { n?: string; re?: 1; f: string[] }[];
const strip = (root: HTMLElement, where: "top" | "bottom") => root.querySelector<HTMLElement>(`.strip.${where}`)!;

describe("cleaning a name", () => {
  it("removes control, bidi-override, isolate and zero-width characters, and collapses spaces", () => {
    expect(cleanName("  Ana\u0007\u0000 \t\n Silva  ")).toBe("Ana Silva");
    // Overrides and embeddings (U+202A-202E), isolates (U+2066-2069), marks (U+200E/F, U+061C).
    expect(cleanName("\u202eAna\u202c \u2066Bob\u2069 \u2067x\u2068y\u200e\u200f\u061c")).toBe("Ana Bob xy");
    // Zero-width space, non-joiner, joiner, word joiner, BOM and soft hyphen: all Cf.
    expect(cleanName("A\u200bn\u200ca\u200d\u2060\ufeff\u00ad")).toBe("Ana");
    // A lone surrogate is dropped.
    expect(cleanName("Ana\ud800")).toBe("Ana");
  });

  it("normalizes to NFC", () => {
    expect(cleanName("Jose\u0301")).toBe("Jos\u00e9");
    expect(cleanName("Jose\u0301")).toHaveLength(4);
  });

  it("cuts to 48 code points without splitting an emoji's surrogate pair", () => {
    const cut = cleanName(`a${"😀".repeat(60)}`);
    expect([...cut]).toHaveLength(MAX_NAME);
    expect(cut).toBe(`a${"😀".repeat(47)}`);
    expect(cut).toHaveLength(1 + 47 * 2);
    expect(cleanName(`${"a".repeat(47)}😀😀`)).toBe(`${"a".repeat(47)}😀`);
    // No half pair at the end, however the cut falls.
    for (let i = 40; i < 60; i++) expect(cleanName(`${"b".repeat(i % 3)}${"😀".repeat(i)}`)).not.toMatch(/[\ud800-\udbff]$/);
    // A cut that leaves a space at the end trims it.
    expect(cleanName(`${"a".repeat(47)} b`)).toBe("a".repeat(47));
  });

  it("is empty when nothing is left, and the strips fall back to 'Your contact'", async () => {
    expect(cleanName("\u200b\u202e \u2066\u0007")).toBe("");
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a, "Ana");
    const bob = await openAs(b, "\u200b\u202e\u0007 ");
    await settle(ana, bob);
    await agree(ana, bob);
    // Bob's name cleaned to nothing: he sends none, and Ana shows "Your contact".
    expect(hellos(b).every((h) => h.n === undefined)).toBe(true);
    expect(ana.game.view().peerName).toBeUndefined();
    expect(bob.game.view().ownName).toBeUndefined();
    const root = mount(ana);
    expect(strip(root, "top").textContent).toBe(en.contact);
    expect(strip(root, "top").querySelector(".dot")!.textContent).toBe("");
    expect(strip(root, "bottom").querySelector(".name")!.textContent).toBe("Ana");
  });

  it("is empty for a name nobody could see: fillers, blanks, private-use and unassigned characters, lone marks", () => {
    // Hangul fillers (letters by class), the Braille blank and the object replacement character (symbols by class).
    for (const blank of ["\u3164", "\u115f", "\u1160", "\uffa0", "\u2800", "\ufffc"]) {
      expect(cleanName(blank), blank.codePointAt(0)!.toString(16)).toBe("");
      expect(cleanName(`A${blank}na`)).toBe("Ana");
    }
    // Private use (Co) and a noncharacter (Cn) go like the control and format characters.
    expect(cleanName("\ue000\uffff")).toBe("");
    expect(cleanName("A\ue000n\uffffa\u{f0000}")).toBe("Ana");
    // Marks with nothing to sit on: the grapheme joiner, a lone variation selector, a lone accent.
    expect(cleanName("\u034f")).toBe("");
    expect(cleanName("\ufe0f")).toBe("");
    expect(cleanName(" \u0301 \u034f ")).toBe("");
    // A name of punctuation, of a symbol or of an emoji can be seen: it stays.
    expect(cleanName("...")).toBe("...");
    expect(cleanName("+")).toBe("+");
    expect(cleanName("😀")).toBe("😀");
    expect(cleanName("٣")).toBe("٣");
  });

  it("shows the words, and sends no name, for a name of fillers only", async () => {
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a, "Ana");
    const bob = await openAs(b, "\u3164\u2800 \ue000");
    await settle(ana, bob);
    await agree(ana, bob);
    expect(hellos(b).every((h) => h.n === undefined)).toBe(true);
    const root = mount(ana);
    expect(strip(root, "top").textContent).toBe(en.contact);
    expect(pgnOfGame(ana.game)).toContain(ana.game.view().me === "w" ? '[Black "?"]' : '[White "?"]');
  });

  it("gives up to two initials, upper case, never half a surrogate pair", () => {
    expect(initials("ana maria silva")).toBe("AS");
    expect(initials("Bob")).toBe("B");
    expect(initials("😀 Ana")).toBe("😀A");
    expect(initials("élodie")).toBe("É");
    expect(initials("@bob (chess)")).toBe("BC");
    expect(initials("山田 太郎")).toBe("山太");
    expect(initials("𝒜da")).toBe("𝒜");
    expect(initials("")).toBe("");
  });

  it("gives one code point a word, whatever upper case does to a letter, and one drawn character without letters", () => {
    // Letters that grow in upper case: "ß" is "SS", the ligature "ﬁ" is "FI", "ΐ" is three code points.
    expect(initials("ßen ﬁx")).toBe("SF");
    expect(initials("ΐa ΰb")).toBe("ΙΥ");
    expect([...initials("ŉo ǰa")]).toHaveLength(2);
    // The same on every device: no locale's own upper case (Turkish "i" is "İ" there).
    expect(initials("ilker")).toBe("I");
    // Two words without a letter or digit: only the first, as two emoji do not fit the disc.
    expect(initials("😀 😎")).toBe("😀");
    expect(initials("... !!!")).toBe(".");
    // A flag is one drawn character, never half of it.
    expect(initials("🇧🇷")).toBe("🇧🇷");
    expect(initials("🇧🇷 🇵🇹")).toBe("🇧🇷");
    expect(initials("🇧🇷 Ana")).toBe("🇧🇷A");
    // An emoji with its variation selector or skin tone stays whole.
    expect(initials("❤️")).toBe("❤️");
    expect(initials("👍🏽 ok")).toBe("👍🏽O");
  });
});

describe("names between two Chess 2.3.0", () => {
  it("each side sends its own name in its hello and shows the contact's in the strips", async () => {
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a, "Ana Silva");
    const bob = await openAs(b, "Bob");
    await settle(ana, bob);
    await agree(ana, bob);
    expect(hellos(a).length).toBeGreaterThan(0);
    expect(hellos(a).every((h) => h.n === "Ana Silva" && h.f.includes("names"))).toBe(true);
    expect(hellos(b).every((h) => h.n === "Bob")).toBe(true);
    expect(ana.game.view().features).toContain("names");
    expect(ana.game.view()).toMatchObject({ ownName: "Ana Silva", peerName: "Bob" });
    expect(bob.game.view()).toMatchObject({ ownName: "Bob", peerName: "Ana Silva" });

    const root = mount(ana);
    const anaColour = ana.game.view().me!;
    expect(strip(root, "bottom").querySelector(".name")!.textContent).toBe("Ana Silva");
    expect(strip(root, "bottom").querySelector(`.dot.${anaColour}`)!.textContent).toBe("AS");
    expect(strip(root, "top").querySelector(".name")!.textContent).toBe("Bob");
    expect(strip(root, "top").querySelector(".dot")!.textContent).toBe("B");
    // The disc is not read aloud: the name is.
    expect(strip(root, "top").querySelector(".dot")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the contact's name across its reload, and while its Chess is closed", async () => {
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a, "Ana");
    let bob = await openAs(b, "Bob");
    await settle(ana, bob);
    await agree(ana, bob);
    b.shutdown();
    bob.game.stop();
    await settle(ana);
    // Away: the strip keeps the name.
    expect(ana.game.view().peerName).toBe("Bob");
    bob = await openAs(b, "Bob");
    await settle(ana, bob);
    expect(ana.game.view().peerName).toBe("Bob");
    expect(bob.game.view().peerName).toBe("Ana");
    // Ana reloads too: both names come back.
    a.shutdown();
    ana.game.stop();
    const back = await openAs(a, "Ana");
    await settle(back, bob);
    expect(back.game.view().peerName).toBe("Bob");
    expect(bob.game.view().peerName).toBe("Ana");
  });

  it("cleans a name again on receipt", async () => {
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a, "Ana");
    b.launch(); // Bob is a script
    await settle(ana);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: ["names"], n: "\u202eB\u200bo\u0007b\u2066  x" }));
    await settle(ana);
    expect(ana.game.view().peerName).toBe("Bob x");
    // Its answer carried Ana's name, as the hello named "names".
    expect(hellos(a).at(-1)).toMatchObject({ n: "Ana", re: 1 });
  });

  it("shows a name with markup literally, creating no element", async () => {
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a, "Ana");
    const bob = await openAs(b, '<img src=x onerror="alert(1)">');
    await settle(ana, bob);
    await agree(ana, bob);
    const root = mount(ana);
    const top = strip(root, "top");
    expect(top.querySelector(".name")!.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(top.querySelector(".dot")!.textContent).toBe("IO");
    expect(root.querySelector("img")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("reads the contact's moves aloud with its name, and this side's as 'You'", async () => {
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a, "Ana");
    const bob = await openAs(b, "Bob");
    await settle(ana, bob);
    await agree(ana, bob);
    const white = ana.game.view().me === "w" ? ana : bob;
    const black = white === ana ? bob : ana;
    const root = mount(white);
    await play({ white, black }, "e2e4");
    expect(root.querySelector(".announce")!.textContent!.trim()).toBe("You: pawn to e4");
    await play({ white, black }, "e7e5");
    const blackName = black === bob ? "Bob" : "Ana";
    expect(root.querySelector(".announce")!.textContent!.trim()).toBe(`${blackName}: pawn to e5`);
  });

  for (const name of ["{piece}", "{square}", "{who}", "$'", "$&", "$`", "a$$b"]) {
    it(`reads the contact's move with the name ${name} as it is`, async () => {
      const [a, b] = chatPair("2.3.0");
      const ana = await openAs(a, "Ana");
      const bob = await openAs(b, name);
      await settle(ana, bob);
      await agree(ana, bob);
      const white = ana.game.view().me === "w" ? ana : bob;
      const black = white === ana ? bob : ana;
      // Ana's page hears Bob's first move: e4 when he is White, e5 after hers otherwise.
      const root = mount(ana);
      await play({ white, black }, ...(white === ana ? ["e2e4", "e7e5"] : ["e2e4"]));
      expect(root.querySelector(".announce")!.textContent!.trim()).toBe(`${name}: pawn to ${white === ana ? "e5" : "e4"}`);
    });
  }

  it("tells a screen reader whose strip it is beside a name, and adds nothing without one", async () => {
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a, "Ana");
    const bob = await openAs(b, "Ana"); // the same name on both sides
    await settle(ana, bob);
    await agree(ana, bob);
    const root = mount(ana);
    const hidden = (where: "top" | "bottom") => strip(root, where).querySelector(".sr-only");
    expect(hidden("bottom")!.textContent).toBe(en.you);
    expect(hidden("top")!.textContent).toBe(en.contact);
    // Before the name, so it is read first, and outside the name's own span.
    expect(hidden("top")!.nextElementSibling).toBe(strip(root, "top").querySelector(".name"));
    expect(strip(root, "top").querySelector(".name")!.textContent).toBe("Ana");
    document.body.replaceChildren();
    // Without names the strip is the words alone, as before: no second copy for a screen reader.
    const [c, d] = chatPair("2.3.0");
    const carl = await openAs(c);
    const dora = await openAs(d);
    await settle(carl, dora);
    await agree(carl, dora);
    const plain = mount(carl);
    expect(plain.querySelector(".strip .sr-only")).toBeNull();
    expect(strip(plain, "top").textContent).toBe(en.contact);
    expect(strip(plain, "bottom").textContent).toBe(en.you);
  });

  it("names both players in the PGN, escaped", async () => {
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a, 'Ana "the rook"');
    const bob = await openAs(b, "Bob \\o/");
    await settle(ana, bob);
    await agree(ana, bob);
    const white = ana.game.view().me === "w" ? ana : bob;
    const black = white === ana ? bob : ana;
    await play({ white, black }, "e2e4");
    const names = { ana: 'Ana \\"the rook\\"', bob: "Bob \\\\o/" };
    for (const side of [ana, bob]) {
      const pgn = pgnOfGame(side.game);
      expect(pgn).toContain(`[White "${white === ana ? names.ana : names.bob}"]`);
      expect(pgn).toContain(`[Black "${black === ana ? names.ana : names.bob}"]`);
    }
  });
});

describe("without the name permission", () => {
  it("sends no name and keeps the words, while the contact's name still shows", async () => {
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a); // no context().name
    const bob = await openAs(b, "Bob");
    await settle(ana, bob);
    await agree(ana, bob);
    expect(hellos(a).length).toBeGreaterThan(0);
    expect(hellos(a).every((h) => !("n" in h))).toBe(true);
    expect(bob.game.view().peerName).toBeUndefined();
    expect(ana.game.view().ownName).toBeUndefined();
    const anaRoot = mount(ana);
    expect(strip(anaRoot, "bottom").textContent).toBe(en.you);
    expect(strip(anaRoot, "top").querySelector(".name")!.textContent).toBe("Bob");
    const bobRoot = mount(bob);
    expect(strip(bobRoot, "top").textContent).toBe(en.contact);
    // The PGN has "?" for the unnamed player.
    const anaWhite = ana.game.view().me === "w";
    expect(pgnOfGame(bob.game)).toContain(anaWhite ? '[White "?"]' : '[Black "?"]');
  });
});

describe("older contacts", () => {
  it("never sends a name to Chess 2.2.0, which names no 'names', whoever opens first or reloads", async () => {
    for (const first of ["new", "old"] as const) {
      const [a, b] = chatPair("2.3.0", "2.2.0");
      const open = async () => {
        if (first === "new") return [await openAs(a, "Ana"), await openAs(b, "Bob", V220)];
        const old = await openAs(b, "Bob", V220);
        return [await openAs(a, "Ana"), old];
      };
      const [ana, bob] = await open();
      await settle(ana, bob);
      await agree(ana, bob);
      // The old side reloads, then the new one.
      b.shutdown();
      bob.game.stop();
      const bob2 = await openAs(b, "Bob", V220);
      await settle(ana, bob2);
      a.shutdown();
      ana.game.stop();
      const ana2 = await openAs(a, "Ana");
      await settle(ana2, bob2);
      expect(ana2.game.view().mode, first).toBe("v2");
      expect(hellos(a).length, first).toBeGreaterThan(2);
      expect(hellos(a).every((h) => !("n" in h)), first).toBe(true);
      expect(ana2.game.view().features, first).not.toContain("names");
      expect(ana2.game.view().peerName, first).toBeUndefined();
      const root = mount(ana2);
      expect(strip(root, "top").textContent).toBe(en.contact);
      expect(strip(root, "bottom").querySelector(".name")!.textContent).toBe("Ana");
      document.body.replaceChildren();
    }
  });

  it("sends its name when the contact's hello names 'names' although its version said less", async () => {
    const [a, b] = chatPair("2.3.0", "2.2.0");
    const ana = await openAs(a, "Ana");
    const anaRoot = mount(ana);
    const bob = await openAs(b, "Bob"); // a Chess that names "names", reporting 2.2.0
    const bobRoot = mount(bob);
    await settle(ana, bob);
    expect(hellos(a).some((h) => h.n === "Ana" && h.re === 1)).toBe(true);
    expect(bob.game.view().peerName).toBe("Ana");
    expect(ana.game.view().peerName).toBe("Bob");
    // The name came with both sides already in version 2: the pages show it at once, with no other change.
    expect(strip(anaRoot, "top").querySelector(".name")!.textContent).toBe("Bob");
    expect(strip(bobRoot, "top").querySelector(".name")!.textContent).toBe("Ana");
  });

  for (const version of ["2.3.0-rc.1", "2.2.9"]) {
    it(`shows both names at once between two sides that name 'names' and report ${version}`, async () => {
      const [a, b] = chatPair(version);
      const ana = await openAs(a, "Ana");
      const anaRoot = mount(ana);
      const bob = await openAs(b, "Bob");
      const bobRoot = mount(bob);
      await settle(ana, bob);
      // No first hello carried a name (the version said less): each went in an answer, never answered back.
      expect(hellos(a).filter((h) => h.n).every((h) => h.re === 1)).toBe(true);
      expect(hellos(b).filter((h) => h.n).every((h) => h.re === 1)).toBe(true);
      expect(strip(anaRoot, "top").querySelector(".name")!.textContent).toBe("Bob");
      expect(strip(bobRoot, "top").querySelector(".name")!.textContent).toBe("Ana");
      expect(strip(anaRoot, "top").querySelector(".dot")!.textContent).toBe("B");
    });
  }

  it("shows a name a later hello brings, and takes it away when a later hello has none", async () => {
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a, "Ana");
    const root = mount(ana);
    b.launch(); // Bob is a script
    await settle(ana);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: ["names"] }));
    await settle(ana);
    expect(strip(root, "top").textContent).toBe(en.contact);
    const sent = hellos(a).length;
    a.inject(encodeMessage({ k: "hello", pv: 2, f: ["names"], n: "Bob", re: 1 }));
    await settle(ana);
    expect(strip(root, "top").querySelector(".name")!.textContent).toBe("Bob");
    // An answer (re: 1) is never answered, however many come.
    for (let i = 0; i < 20; i++) a.inject(encodeMessage({ k: "hello", pv: 2, f: ["names"], n: `Bob ${i}`, re: 1 }));
    await settle(ana);
    expect(hellos(a)).toHaveLength(sent);
    expect(strip(root, "top").querySelector(".name")!.textContent).toBe("Bob 19");
    a.inject(encodeMessage({ k: "hello", pv: 2, f: ["names"], re: 1 }));
    await settle(ana);
    expect(strip(root, "top").textContent).toBe(en.contact);
  });

  it("stops sending its name once the contact's hello is in and names no 'names', whatever its version", async () => {
    const [a, b] = chatPair("2.3.0", "2.4.0");
    const ana = await openAs(a, "Ana");
    b.launch(); // a later Chess, a fork or a bot that reports 2.4.0 and takes no names
    await settle(ana);
    // Before its hello only its version could say: our first hello carried the name.
    expect(hellos(a)).toHaveLength(1);
    expect(hellos(a)[0]).toMatchObject({ n: "Ana", f: expect.arrayContaining(["names"]) });
    expect("re" in hellos(a)[0]).toBe(false);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: V220 as Feature[] }));
    await settle(ana);
    // Its hello is in, without "names": our answer has no name, and no hello after it has one.
    expect(hellos(a)).toHaveLength(2);
    expect(hellos(a)[1]).toMatchObject({ re: 1 });
    expect("n" in hellos(a)[1]).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // past the one-answer-a-second limit
    a.inject(encodeMessage({ k: "hello", pv: 2, f: V220 as Feature[] }));
    await settle(ana);
    expect(hellos(a)).toHaveLength(3);
    expect("n" in hellos(a)[2]).toBe(false);
    expect(ana.game.view().peerName).toBeUndefined();
  });

  it("takes a hello whose name is over 48 code points, cut, instead of refusing to pair", async () => {
    const [a, b] = chatPair("2.3.0");
    const ana = await openAs(a, "Ana");
    b.launch();
    await settle(ana);
    // Written by hand: encodeMessage is this build's writer, and a later Chess with a longer limit is not.
    a.inject({ p: "chess", v: 2, k: "hello", pv: 2, f: ["names"], n: `${"B".repeat(60)}` });
    await settle(ana);
    expect(ana.notices).toEqual([]);
    expect(ana.game.view().mode).toBe("v2");
    expect(ana.game.view().peerName).toBe("B".repeat(MAX_NAME));
  });

  it("sends nothing of the kind to Chess 1.0.2: version 1 has no hello", async () => {
    const [a, b] = chatPair("2.3.0", "1.0.2");
    const ana = await openAs(a, "Ana");
    b.launch();
    await settle(ana);
    expect(hellos(a)).toEqual([]);
    expect(JSON.stringify(a.sent)).not.toContain("Ana");
    expect(ana.game.view().ownName).toBe("Ana");
  });
});
