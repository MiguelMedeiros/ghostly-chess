// The game panel in real browsers, inside <iframe sandbox="allow-scripts"> under the web runner's CSP: sounds start
// only after a click inside the frame, and Copy PGN leaves the text selected when copying is refused.
//
// The AudioContext is watched from outside the app: an init script (it runs in the sandboxed frame too) wraps the
// constructor and counts resume() calls and the sound sources started. The app has no test hook for it.
//
// Playwright's Chromium allows audio without a gesture (a context is born running, and its flag cannot be turned
// back), so there it checks that no context exists before the click. WebKit's context is born suspended: there the
// resume asked inside the click is what makes it run.
//
// Checked by hand (README, "Checked by hand"): sounds after a tap in the web runner in Chromium and Safari and in
// Desktop's WKWebView, Copy PGN there, and an iPhone web app's ring/silent switch muting Web Audio.
import { expect, test, type Frame } from "@playwright/test";
import { chatPair, openSide } from "./harness.ts";

interface Probe {
  supported: boolean;
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
  w.__audio = { supported: Boolean(Base), made: 0, resumes: 0, started: 0, born: "none", state: "none", contexts: [] };
  if (!Base) return;
  class Watched extends Base {
    constructor(options?: AudioContextOptions) {
      super(options);
      w.__audio.made++;
      w.__audio.born = this.state;
      w.__audio.contexts.push(this);
    }
    override resume(): Promise<void> {
      w.__audio.resumes++;
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
    return { supported: a.supported, made: a.made, resumes: a.resumes, started: a.started, born: a.born, state: a.contexts[0]?.state ?? "none" };
  });

test.describe("sounds in the sandboxed frame", () => {
  test("nothing plays before a click inside the frame; after it the context resumes and moves are heard", async ({ browser, browserName }) => {
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
    const after = await probe(b);
    // A context born suspended is resumed inside that click; one born running needs no resume.
    if (after.born !== "running") expect(after.resumes).toBeGreaterThanOrEqual(1);
    test.info().annotations.push({ type: "audio", description: `${browserName}: born ${after.born}, now ${after.state}, ${after.resumes} resume(s)` });
    if (browserName === "chromium") {
      await expect.poll(async () => (await probe(b)).state).toBe("running");
    } else {
      // Headless WebKit may hold a context suspended without an output device: the resume asked inside the click is
      // what is checked here, and a real WebKit (Safari, Desktop's WKWebView) by hand.
      expect(["running", "suspended", "interrupted"]).toContain(after.state);
    }

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

  test("as the browser decides: Copied, or the selected text and the hint, never neither", async ({ browser }) => {
    const { side, frame } = await openPgn(browser);
    await frame.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(frame.locator(".pgn-status")).toHaveText(/^(Copied|Copy the selected text \(on a phone, press and hold it\)\.)$/);
    const s = await selection(frame);
    expect(s).toMatchObject({ focused: true, start: 0, end: s.length });
    expect(await frame.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
    await side.context.close();
  });
});
