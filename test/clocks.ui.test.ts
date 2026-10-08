// @vitest-environment happy-dom
// covers: apps.chess
// The clocks on the page: both strips' clocks (m:ss, tenths under 20 s, the running one marked), the low-time warning
// (red, one sound, 30 s and 10 s read aloud), "isn't answering", the pending claim, the move list's times and the
// game-over reasons. Two controllers on a virtual clock (test/link.ts); the page's own ticker runs on real timers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { overText } from "../src/panel.ts";
import { PrefsStore } from "../src/prefs.ts";
import type { AudioContextLike, SoundName } from "../src/sound.ts";
import { en } from "../src/strings.ts";
import { mountChess } from "../src/ui.ts";
import { play, timedGame, type Side } from "./link.ts";

vi.setConfig({ testTimeout: 60_000 });

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const off of unmounts.splice(0)) off();
  document.body.replaceChildren();
});

/** A context that is running at once: sounds are counted, not made. */
const running = () => ({ state: "running", resume: () => Promise.resolve() }) as unknown as AudioContextLike;

async function mount(side: Side): Promise<{ root: HTMLElement; played: SoundName[] }> {
  const root = document.createElement("div");
  document.body.append(root);
  const prefs = new PrefsStore(side.broker);
  await prefs.load();
  const played: SoundName[] = [];
  const target = new EventTarget();
  unmounts.push(mountChess(root, side.game, en, prefs, { sound: { target, create: running, hidden: () => false, synth: (_c, name) => played.push(name) } }));
  target.dispatchEvent(new Event("click"));
  return { root, played };
}

/** Lets the page's ticker (every 100 ms) draw the clocks. */
const drawn = () => new Promise((resolve) => setTimeout(resolve, 130));

/** The clock in the strip of a colour: the strip whose dot has that colour. */
function clockOf(root: HTMLElement, colour: "w" | "b"): HTMLElement {
  const strip = [...root.querySelectorAll<HTMLElement>(".strip")].find((s) => s.querySelector(`.dot.${colour}`))!;
  return strip.querySelector<HTMLElement>(".clock")!;
}

describe("the clocks on the page", () => {
  it("show both clocks, mark the running one, show tenths under 20 s, and warn once at 10 s in bullet", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    const w = await mount(white);
    const b = await mount(black);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await drawn();
    for (const page of [w, b]) {
      expect(clockOf(page.root, "w").textContent).toBe("1:00");
      expect(clockOf(page.root, "b").textContent).toBe("1:00");
      expect(clockOf(page.root, "w").classList.contains("running")).toBe(true);
      expect(clockOf(page.root, "b").classList.contains("running")).toBe(false);
      expect(clockOf(page.root, "w").getAttribute("role")).toBe("timer");
    }
    await link.advance(30_500);
    await drawn();
    expect(clockOf(w.root, "w").textContent).toBe("0:30");
    expect(w.root.querySelector(".announce")!.textContent).toBe("30 seconds left");
    // The contact's clock on black's page: an estimate from black's own send, within the latency.
    expect(clockOf(b.root, "w").textContent).toMatch(/^0:(29|30)$/);
    await link.advance(11_000);
    await drawn();
    expect(clockOf(w.root, "w").textContent).toMatch(/^0:1[89]\.\d$/);
    expect(clockOf(w.root, "w").classList.contains("low")).toBe(false);
    expect(w.played).not.toContain("lowTime");
    await link.advance(9000);
    await drawn();
    expect(clockOf(w.root, "w").classList.contains("low")).toBe(true);
    expect(w.played.filter((s) => s === "lowTime")).toHaveLength(1);
    expect(w.root.querySelector(".announce")!.textContent).toBe("10 seconds left");
    // Only this side's clock sounds the warning.
    expect(b.played).not.toContain("lowTime");
    await link.advance(5000);
    await drawn();
    expect(w.played.filter((s) => s === "lowTime")).toHaveLength(1);
    // White moves: the time it took is in the move list, and in the move's name.
    await play(link, white, "g1f3");
    await drawn();
    for (const page of [w, b]) {
      const spent = page.root.querySelectorAll(".moves .spent");
      expect(spent).toHaveLength(1);
      expect(spent[0].textContent).toMatch(/^5[56]\.\ds$/);
      expect(page.root.querySelector('.moves [data-ply="3"]')!.getAttribute("aria-label")).toMatch(/^2\. Nf3, .*, 5[56]\.\ds$/);
      expect(clockOf(page.root, "b").classList.contains("running")).toBe(true);
    }
  });

  it("says when the contact's Chess isn't answering, and the pending claim while it is away past its time", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    const b = await mount(black);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    white.broker.rewrite = (f) => (f.k === "ack" ? null : f);
    await link.advance(11_000);
    await drawn();
    const whiteStrip = clockOf(b.root, "w").parentElement!;
    expect(whiteStrip.querySelector(".name.silent")!.textContent).toBe("Your contact's Chess isn't answering");
    await link.close(white);
    await link.advance(52_000);
    await drawn();
    expect(b.root.querySelector(".standing-text")!.textContent).toBe("Their time is running out. It ends when their Chess is back.");
    expect(clockOf(b.root, "w").textContent).toBe("0:00.0");
    expect(b.root.querySelector<HTMLElement>(".over")!.hidden).toBe(true);
  });

  it("ends on time with the game-over card and the PGN's termination", async () => {
    const { link, white, black } = await timedGame([60, 0]);
    const b = await mount(black);
    await play(link, white, "e2e4");
    await play(link, black, "e7e5");
    await link.advance(61_000);
    await drawn();
    expect(b.root.querySelector(".over-head")!.textContent).toBe("You win");
    expect(b.root.querySelector(".over-reason")!.textContent).toBe("Time");
    expect(b.root.querySelector(".status")!.textContent).toBe("You win: time");
    expect(clockOf(b.root, "w").textContent).toBe("0:00.0");
    expect(clockOf(b.root, "w").classList.contains("running")).toBe(false);
  });

  it("names the three clock endings on the game-over card", () => {
    const view = { me: "w", end: { result: "1/2-1/2", why: "timeMaterial" } } as never;
    expect(overText(view, en)).toEqual({ head: "Draw", reason: "Time against insufficient material" });
    expect(overText({ me: "w", end: { result: "0-1", why: "time" } } as never, en)).toEqual({ head: "You lose", reason: "Time" });
    expect(overText({ me: "b", end: { result: "*", why: "disputed" } } as never, en)).toEqual({ head: "No result", reason: "Clocks disagree" });
  });
});
