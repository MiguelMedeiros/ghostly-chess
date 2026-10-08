// The game flow in real browsers (Chess 2.2.0): a takeback asked and accepted, Resign asking first, a rematch with
// colours swapped, a premove played on arrival, and the controls' row at phone width in every language.
import { expect, test, type Frame } from "@playwright/test";
import { chatPair, type Side } from "./harness.ts";

const click = async (side: Side, from: string, to: string) => {
  await side.frame.locator(`[data-square="${from}"]`).click();
  await side.frame.locator(`[data-square="${to}"]`).click();
};
const piece = (side: Side, square: string) => side.frame.locator(`[data-square="${square}"]`);

test("takes back a move, asks before resigning, and rematches with colours swapped", async ({ browser }) => {
  const { white, black, sides } = await chatPair(browser, "top", { viewport: { width: 375, height: 667 } }, undefined, "en", "2.2.0");
  await click(white, "e2", "e4");
  await expect(piece(black, "e4")).toHaveAttribute("data-piece", "wp");
  await click(black, "e7", "e5");
  await expect(piece(white, "e5")).toHaveAttribute("data-piece", "bp");
  await click(white, "g1", "f3");
  await expect(piece(black, "f3")).toHaveAttribute("data-piece", "wn");
  // White asks to take Nf3 back; Black accepts on the card.
  await white.frame.locator(".actions .takeback-btn").click();
  await expect(black.frame.locator(".offer-card .offer")).toHaveText("Your contact asks to take back a move");
  await black.frame.locator(".offer-card .primary").click();
  for (const side of [white, black]) {
    await expect(piece(side, "g1")).toHaveAttribute("data-piece", "wn");
    await expect(piece(side, "f3")).toHaveAttribute("data-piece", "");
  }
  await expect(white.frame.locator(".status")).toHaveText("Your move");
  // Resign asks first; Escape keeps the game.
  await white.frame.locator(".actions .resign-btn").click();
  await expect(white.frame.locator(".resign-dialog")).toBeVisible();
  await expect(white.frame.locator(".resign-dialog .resign-cancel")).toBeFocused();
  await white.page.keyboard.press("Escape");
  await expect(white.frame.locator(".resign-dialog")).toHaveCount(0);
  await expect(white.frame.locator(".actions .resign-btn")).toBeFocused();
  await white.frame.locator(".actions .resign-btn").click();
  await white.frame.locator(".resign-dialog .resign-confirm").click();
  await expect(black.frame.locator(".over-head")).toHaveText("You win");
  // A rematch from the game-over card: the colours swap.
  await white.frame.locator(".over .over-rematch").click();
  await expect(black.frame.locator(".invitation .invite-words")).toHaveText("Rematch? (Unlimited)");
  await black.frame.locator(".invitation .accept-invite").click();
  await expect(white.frame.locator(".side")).toHaveText("You play black");
  await expect(black.frame.locator(".side")).toHaveText("You play white");
  for (const side of sides) await side.context.close();
});

test("plays a premove as soon as the contact's move arrives", async ({ browser }) => {
  const { white, black, sides } = await chatPair(browser, "top", { viewport: { width: 1024, height: 720 } }, undefined, "en", "2.2.0");
  // Black, on White's turn, queues e7-e5: drawn apart until White moves.
  await click(black, "e7", "e5");
  await expect(piece(black, "e7")).toHaveClass(/\bpremove\b/);
  await expect(piece(black, "e5")).toHaveClass(/\bpremove\b/);
  await click(white, "e2", "e4");
  for (const side of [white, black]) await expect(piece(side, "e5")).toHaveAttribute("data-piece", "bp");
  await expect(black.frame.locator(".premove")).toHaveCount(0);
  await expect(white.frame.locator(".status")).toHaveText("Your move");
  for (const side of sides) await side.context.close();
});

// Below the board the controls are one row (NARROW_PANEL reserves one): ↶, Offer draw and Resign fit at 320 px in
// every language, and a takeback ask floats over them.
const row = (frame: Frame) =>
  frame.evaluate(() => ({
    actions: Math.round(document.querySelector(".actions")!.getBoundingClientRect().height),
    scroll: document.documentElement.scrollHeight,
    inner: window.innerHeight,
    wide: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));

for (const locale of ["en", "pt", "es", "fr", "it", "ja", "zh", "ar"]) {
  test(`${locale} at 320x568: the controls stay one row, with a takeback ask over them`, async ({ browser }) => {
    const { white, black, sides } = await chatPair(browser, "top", { viewport: { width: 320, height: 568 } }, undefined, locale, "2.2.0");
    await click(white, "e2", "e4");
    await expect(piece(black, "e4")).toHaveAttribute("data-piece", "wp");
    await click(black, "e7", "e5");
    await expect(piece(white, "e5")).toHaveAttribute("data-piece", "bp");
    for (const side of [white, black]) {
      await expect(side.frame.locator(".actions .resign-btn")).toBeVisible();
      const m = await row(side.frame);
      expect(m.actions).toBeLessThanOrEqual(36);
      expect(m.scroll).toBeLessThanOrEqual(m.inner);
      expect(m.wide).toBe(false);
    }
    await black.frame.locator(".actions .takeback-btn").click();
    await expect(white.frame.locator(".offer-card")).toBeVisible();
    const m = await row(white.frame);
    expect(m.scroll).toBeLessThanOrEqual(m.inner);
    for (const side of sides) await side.context.close();
  });
}
