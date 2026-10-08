// The game panel in real browsers, inside <iframe sandbox="allow-scripts"> under the web runner's CSP: sounds start
// only after a click inside the frame, and Copy PGN leaves the text selected when copying is refused.
//
// The AudioContext is watched from outside the app: an init script (it runs in the sandboxed frame too) wraps the
// constructor and counts resume() calls and the sound sources started. The app has no test hook for it.
//
// Neither Playwright engine enforces the gesture rule, so these runs cannot show that the click is what starts audio:
// Chromium's context is born running and the page already has sticky activation, and WebKit's resume() resolves to
// "running" with no gesture at all. What is checked here: no context exists before a click inside the frame; the
// context is made and resumed while the frame has a transient activation (navigator.userActivation.isActive, read
// inside the wrapped constructor and resume()); it then runs, and moves are heard. That a real browser starts audio
// only after the tap is the hand check.
//
// Checked by hand (README, "Checked by hand"): sounds after a tap in the web runner in Chromium and Safari and in
// Desktop's WKWebView, Copy PGN there, and an iPhone web app's ring/silent switch muting Web Audio.
import { expect, test, type Frame } from "@playwright/test";
import { chatPair, openSide } from "./harness.ts";

interface Probe {
  supported: boolean;
  /** navigator.userActivation.isActive when the context was made and at each resume(); "n/a" without the API. */
  activeAt: string[];
  made: number;
  resumes: number;
  started: number;
  /** The context's state when it was made: Playwright's Chromium allows audio without a gesture, so "running". */
  born: string;
  state: string;
}

/** Runs in every frame before the page: watches the AudioContext the app makes. */
function watchAudio(): void {
  const w = window as unknown as Record<string, unknown> & { __audio: Probe & { contexts: AudioContext[] } };
  const Base = (w.AudioContext ?? w.webkitAudioContext) as typeof AudioContext | undefined;
  w.__audio = { supported: Boolean(Base), activeAt: [], made: 0, resumes: 0, started: 0, born: "none", state: "none", contexts: [] };
  if (!Base) return;
  const active = () => {
    const ua = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
    return ua ? String(ua.isActive) : "n/a";
  };
  class Watched extends Base {
    constructor(options?: AudioContextOptions) {
      super(options);
      w.__audio.activeAt.push(`made ${active()}`);
      w.__audio.made++;
      w.__audio.born = this.state;
      w.__audio.contexts.push(this);
    }
    override resume(): Promise<void> {
      w.__audio.resumes++;
      w.__audio.activeAt.push(`resume ${active()}`);
      return super.resume();
    }
  }
  w.AudioContext = Watched;
  if (w.webkitAudioContext) w.webkitAudioContext = Watched;
  for (const node of [OscillatorNode, AudioBufferSourceNode]) {
    const start = node.prototype.start;
    node.prototype.start = function (this: AudioScheduledSourceNode, ...args: number[]) {
      w.__audio.started++;
      return start.apply(this, args as [number?]);
    };
  }
}

const probe = (frame: Frame): Promise<Probe> =>
  frame.evaluate(() => {
    const a = (window as unknown as { __audio: Probe & { contexts: AudioContext[] } }).__audio;
    return { supported: a.supported, activeAt: a.activeAt, made: a.made, resumes: a.resumes, started: a.started, born: a.born, state: a.contexts[0]?.state ?? "none" };
  });

test.describe("sounds in the sandboxed frame", () => {
  test("nothing plays before a click inside the frame; the context is made and resumed inside it, runs, and moves are heard", async ({ browser, browserName }) => {
    const { white, black, sides } = await chatPair(browser, "frame", undefined, [watchAudio]);
    const [w, b] = [white.frame, black.frame];
    await expect(w.locator(".status")).toHaveText(/^Your move/);

    const before = await probe(b);
    test.skip(!before.supported, `${browserName} has no Web Audio here`);
    // White plays by click, click; black only receives it: black has had no activation.
    await w.locator('[data-square="e2"]').click();
    await w.locator('[data-square="e4"]').click();
    await expect(b.locator('[data-square="e4"]')).toHaveText(/♟/);
    expect(await probe(b), "before a click in black's frame").toMatchObject({ made: 0, started: 0, resumes: 0 });

    // A click inside black's frame (on the status line, nothing to play): the context is made and resumed there.
    await b.locator(".status").click();
    await expect.poll(async () => (await probe(b)).made).toBe(1);
    await expect.poll(async () => (await probe(b)).state).toBe("running");
    const after = await probe(b);
    // A context born suspended is resumed inside that click; one born running needs no resume.
    if (after.born !== "running") expect(after.resumes).toBeGreaterThanOrEqual(1);
    test.info().annotations.push({ type: "audio", description: `${browserName}: born ${after.born}, now ${after.state}, ${after.resumes} resume(s), ${after.activeAt.join(", ")}` });
    // Made, and every resume asked, while the frame had a transient activation (where the browser can tell).
    expect(after.activeAt.length).toBeGreaterThanOrEqual(1);
    for (const at of after.activeAt) expect(at, "made or resumed outside an activation").not.toMatch(/ false$/);

    // Black moves and white answers: black hears both.
    const startedBefore = (await probe(b)).started;
    await b.locator('[data-square="e7"]').click();
    await b.locator('[data-square="e5"]').click();
    await expect(w.locator('[data-square="e5"]')).toHaveText(/♟/);
    await w.locator('[data-square="g1"]').click();
    await w.locator('[data-square="f3"]').click();
    await expect(b.locator('[data-square="f3"]')).toHaveText(/♞/);
    if ((await probe(b)).state === "running") await expect.poll(async () => (await probe(b)).started).toBeGreaterThan(startedBefore);
    for (const side of sides) await side.context.close();
  });
});

test.describe("Copy PGN in the sandboxed frame", () => {
  async function openPgn(browser: import("@playwright/test").Browser) {
    const side = await openSide(browser, { name: "solo", mode: "frame", inChat: false });
    const frame = side.frame;
    await frame.locator('[data-square="e2"]').click();
    await frame.locator('[data-square="e4"]').click();
    await frame.getByRole("button", { name: "Copy PGN" }).click();
    const text = frame.locator(".pgn-text");
    await expect(text).toBeVisible();
    return { side, frame, text };
  }

  const selection = (frame: Frame) =>
    frame.evaluate(() => {
      const t = document.querySelector<HTMLTextAreaElement>(".pgn-text")!;
      return { focused: document.activeElement === t, start: t.selectionStart, end: t.selectionEnd, length: t.value.length };
    });

  test("when copying is refused, the PGN stays selected and the dialog says to copy it", async ({ browser }) => {
    const { side, frame, text } = await openPgn(browser);
    await expect(text).toHaveValue(/\[Event "Ghostly chess"\][\s\S]*1\. e4 \*/);
    // Both ways refused, as a runner without clipboard-write may do.
    await frame.evaluate(() => {
      document.execCommand = () => false;
      Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true });
    });
    await frame.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(frame.locator(".pgn-status")).toHaveText("Copy the selected text (on a phone, press and hold it).");
    const s = await selection(frame);
    expect(s).toEqual({ focused: true, start: 0, end: s.length, length: s.length });
    expect(s.length).toBeGreaterThan(100);
    await side.context.close();
  });

  test("as the browser decides: Copied only when a copy of the whole PGN worked, else the selected text and the hint", async ({ browser }) => {
    const { side, frame } = await openPgn(browser);
    // Watch both ways of copying, as the browser answers them: what execCommand had selected, what writeText got.
    await frame.evaluate(() => {
      const w = window as unknown as { __copies: string[] };
      w.__copies = [];
      const t = document.querySelector<HTMLTextAreaElement>(".pgn-text")!;
      const exec = document.execCommand.bind(document);
      document.execCommand = (command: string, ...rest: unknown[]) => {
        const whole = t.selectionStart === 0 && t.selectionEnd === t.value.length && document.activeElement === t;
        const ok = exec(command, ...(rest as [boolean?, string?]));
        w.__copies.push(`exec ${command} ${ok} ${whole ? "whole" : "part"}`);
        return ok;
      };
      const clipboard = navigator.clipboard;
      if (clipboard?.writeText) {
        const write = clipboard.writeText.bind(clipboard);
        Object.defineProperty(clipboard, "writeText", {
          configurable: true,
          value: (text: string) =>
            write(text).then(
              () => void w.__copies.push(`write ok ${text === t.value ? "whole" : "part"}`),
              (e: unknown) => {
                w.__copies.push("write refused");
                throw e;
              },
            ),
        });
      }
    });
    await frame.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(frame.locator(".pgn-status")).toHaveText(/^(Copied|Copy the selected text \(on a phone, press and hold it\)\.)$/);
    const copies = await frame.evaluate(() => (window as unknown as { __copies: string[] }).__copies);
    test.info().annotations.push({ type: "copy", description: copies.join(", ") });
    const copied = copies.includes("exec copy true whole") || copies.includes("write ok whole");
    await expect(frame.locator(".pgn-status")).toHaveText(copied ? "Copied" : "Copy the selected text (on a phone, press and hold it).");
    expect(copies.some((c) => c.endsWith(" part")), "a copy of part of the PGN").toBe(false);
    const s = await selection(frame);
    expect(s).toMatchObject({ focused: true, start: 0, end: s.length });
    expect(await frame.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
    await side.context.close();
  });
});

// Below the board, the panel has a reserved height (NARROW_PANEL in src/ui.ts) with one row of controls. Reviewing
// must not add a second row: the way back to the live game is the review bar's », not a button in the controls. French
// and Spanish have the longest labels.
test.describe("the narrow layout while reviewing", () => {
  const fits = (frame: Frame) =>
    frame.evaluate(() => ({
      actions: Math.round(document.querySelector(".actions")!.getBoundingClientRect().height),
      scroll: document.documentElement.scrollHeight,
      inner: window.innerHeight,
      layout: document.querySelector<HTMLElement>(".app")!.dataset.layout,
    }));

  for (const locale of ["fr", "es"]) {
    for (const [width, height] of [
      [320, 568],
      [375, 667],
    ] as const) {
      test(`${locale} at ${width}x${height}: a chat game under review keeps one row of controls, and no page scroll`, async ({ browser }) => {
        const { white, black, sides } = await chatPair(browser, "top", { viewport: { width, height } }, undefined, locale);
        await expect(white.frame.locator("html")).toHaveAttribute("lang", locale);
        await white.frame.locator('[data-square="e2"]').click();
        await white.frame.locator('[data-square="e4"]').click();
        await expect(black.frame.locator('[data-square="e4"]')).toHaveText(/♟/);
        await black.frame.locator('[data-square="e7"]').click();
        await black.frame.locator('[data-square="e5"]').click();
        await expect(white.frame.locator('[data-square="e5"]')).toHaveText(/♟/);
        await white.frame.locator(".nav-prev").click();
        await expect(white.frame.locator(".nav-last")).toHaveClass(/\blive\b/);
        const m = await fits(white.frame);
        expect(m.layout).toBe("narrow");
        expect(m.actions).toBeLessThanOrEqual(36);
        expect(m.scroll).toBeLessThanOrEqual(m.inner);
        await white.frame.locator(".nav-last").click();
        await expect(white.frame.locator(".nav-last")).not.toHaveClass(/\blive\b/);
        for (const side of sides) await side.context.close();
      });

      test(`${locale} at ${width}x${height}: a game played alone, over and under review, keeps one row of controls`, async ({ browser }) => {
        const solo = await openSide(browser, { name: "solo", inChat: false, locale, contextOptions: { viewport: { width, height } } });
        await expect(solo.frame.locator("html")).toHaveAttribute("lang", locale);
        for (const [from, to] of [
          ["f2", "f3"],
          ["e7", "e5"],
          ["g2", "g4"],
          ["d8", "h4"],
        ]) {
          await solo.frame.locator(`[data-square="${from}"]`).click();
          await solo.frame.locator(`[data-square="${to}"]`).click();
        }
        await expect(solo.frame.locator(".over")).toBeVisible();
        let m = await fits(solo.frame);
        expect(m.actions).toBeLessThanOrEqual(36);
        expect(m.scroll).toBeLessThanOrEqual(m.inner);
        await solo.frame.locator(".over-review").click();
        await solo.frame.locator(".nav-prev").click();
        await expect(solo.frame.locator(".nav-last")).toHaveClass(/\blive\b/);
        m = await fits(solo.frame);
        expect(m.layout).toBe("narrow");
        expect(m.actions).toBeLessThanOrEqual(36);
        expect(m.scroll).toBeLessThanOrEqual(m.inner);
        await solo.context.close();
      });
    }
  }
});
