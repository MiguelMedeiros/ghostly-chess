// @vitest-environment happy-dom
// covers: apps.chess
// The live region (src/announce.ts) as a screen reader hears it: it reads the region once the task that changed it
// ends, so what is said in one task must be joined, in order, each text once. Then a premove played on the contact's
// move leaves both moves to be heard, and one dropped as illegal on arrival is said.
import { afterEach, describe, expect, it } from "vitest";
import { createAnnouncer } from "../src/announce.ts";
import { stringsFor } from "../src/strings.ts";
import { mount, play, settle, sq, startChat, tick } from "./sides.ts";

afterEach(() => document.body.replaceChildren());

/**
 * What a screen reader hears from the page's live region: the region's text at the end of each macrotask in which it
 * was given new text (a stand-in for the accessibility tree, which is updated between tasks).
 */
function listen(root: HTMLElement): { heard: () => string[]; stop: () => void } {
  const live = root.querySelector<HTMLElement>("[aria-live]")!;
  const given: { text: string; task: number }[] = [];
  let task = 0;
  let on = true;
  const bump = () => {
    task++;
    if (on) setTimeout(bump, 0);
  };
  setTimeout(bump, 0);
  const own = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
  Object.defineProperty(live, "textContent", {
    configurable: true,
    get() {
      return own.get!.call(this);
    },
    set(text: string) {
      given.push({ text, task });
      own.set!.call(this, text);
    },
  });
  return {
    heard: () => given.filter((g, i) => given[i + 1]?.task !== g.task).map((g) => g.text.trim()),
    stop: () => (on = false),
  };
}

describe("the live region", () => {
  it("joins the texts said in one task, in order and each once, and starts over in the next task", async () => {
    const a = createAnnouncer();
    a.say("Your contact: pawn to e5");
    a.say("You: knight to f3");
    a.say("You: knight to f3");
    expect(a.element.textContent).toBe("Your contact: pawn to e5. You: knight to f3");
    await tick();
    a.say("Move taken back");
    expect(a.element.textContent).toBe("Move taken back");
    await tick();
    // A text with its own full stop gets no second one.
    a.say("Your contact declined the takeback.");
    a.say("Your move");
    expect(a.element.textContent).toBe("Your contact declined the takeback. Your move");
  });

  it("still makes the same words said again in a later task new text, so they are read", async () => {
    const a = createAnnouncer();
    a.say("check");
    await tick();
    a.say("check");
    expect(a.element.textContent).not.toBe("check");
    expect(a.element.textContent!.trim()).toBe("check");
  });

  it("joins with the language's own full stop", () => {
    const a = createAnnouncer(stringsFor("ja").say_sep);
    a.say("相手：ポーンをe5へ");
    a.say("あなた：ナイトをf3へ");
    expect(a.element.textContent).toBe("相手：ポーンをe5へ。あなた：ナイトをf3へ");
  });
});

describe("a premove, heard", () => {
  it("played on the contact's move: both moves are heard, the contact's first", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    await play({ white, black }, "e2e4");
    sq(root, "g1").click();
    sq(root, "f3").click();
    expect(sq(root, "f3").getAttribute("aria-label")).toContain("premove");
    const ear = listen(root);
    await tick();
    expect(await black.game.move("e7", "e5")).toBe(true);
    await settle(white, black);
    ear.stop();
    expect(white.game.view().plies).toBe(3);
    const heard = ear.heard().join(" | ");
    expect(heard).toContain("Your contact: pawn to e5");
    expect(heard).toContain("You: knight to f3");
    expect(heard.indexOf("Your contact: pawn to e5")).toBeLessThan(heard.indexOf("You: knight to f3"));
  });

  it("illegal on arrival: the contact's move and the cancelled premove are both heard, once", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    await play({ white, black }, "e2e4", "e7e5", "g1f3", "b8c6", "f1c4");
    // The queen through its own d2 pawn: a target on an empty board, never legal here.
    sq(root, "d1").click();
    sq(root, "d3").click();
    expect(sq(root, "d3").getAttribute("aria-label")).toContain("premove");
    const ear = listen(root);
    await tick();
    expect(await black.game.move("g8", "f6")).toBe(true);
    await settle(white, black);
    ear.stop();
    expect(white.game.view().plies).toBe(6);
    expect(sq(root, "d3").getAttribute("aria-label")).not.toContain("premove");
    const heard = ear.heard();
    expect(heard).toEqual(["Your contact: knight to f6. Premove cancelled: d1 to d3 is not legal now"]);
    expect(white.notices).toEqual([]);
  });

  it("dropped by a takeback, not illegal: nothing is said about a premove", async () => {
    const { white, black } = await startChat();
    const root = mount(white);
    await play({ white, black }, "e2e4");
    sq(root, "g1").click();
    sq(root, "f3").click();
    const ear = listen(root);
    await white.game.takeback();
    await settle(white, black);
    await black.game.answerTakeback(true);
    await settle(white, black);
    ear.stop();
    expect(ear.heard().join(" | ")).not.toContain("Premove");
  });
});
