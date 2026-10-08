// A timed game in real browsers: invited from a preset, both clocks in the strips, the running one counting down on
// both pages, the time each move took in the move list, and no page scroll at a phone's width. SHOTS=<dir> also saves
// screenshots of both pages there.
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openSide, type Side } from "./harness.ts";

async function click(side: Side, from: string, to: string): Promise<void> {
  await side.frame.locator(`[data-square="${from}"]`).click();
  await side.frame.locator(`[data-square="${to}"]`).click();
}

const clock = (side: Side, colour: "w" | "b") => side.frame.locator(`.strip:has(.dot.${colour}) .clock`);

for (const size of [
  { width: 1024, height: 720 },
  { width: 320, height: 568 },
]) {
  test(`plays a 3|2 game with both clocks running in the strips, at ${size.width}x${size.height}`, async ({ browser }) => {
    const sides = new Map<string, Side>();
    const contextOptions = { viewport: size };
    const ana = await openSide(browser, { name: "ana", sides, contextOptions, version: "2.1.0" });
    const bob = await openSide(browser, { name: "bob", sides, contextOptions, version: "2.1.0" });
    await ana.frame.locator('.setup .preset[data-tc="180+2"]').click();
    await ana.frame.locator(".setup .invite-btn").click();
    await expect(bob.frame.locator(".invitation .invite-words")).toHaveText("Your contact invites you: Blitz, 3 min + 2 s");
    await bob.frame.locator(".invitation .accept-invite").click();
    for (const side of [ana, bob]) await expect(side.frame.locator(".side")).toHaveText(/^You play (white|black)$/);
    const anaWhite = (await ana.frame.locator(".side").textContent()) === "You play white";
    const [white, black] = anaWhite ? [ana, bob] : [bob, ana];
    for (const side of [white, black]) {
      await expect(clock(side, "w")).toHaveText("3:00");
      await expect(clock(side, "b")).toHaveText("3:00");
    }
    await click(white, "e2", "e4");
    await expect(black.frame.locator(".status")).toHaveText(/^Your move/);
    await click(black, "e7", "e5");
    await expect(white.frame.locator(".status")).toHaveText(/^Your move/);
    // White's clock runs on both pages from ply 2.
    for (const side of [white, black]) await expect(clock(side, "w")).toHaveClass(/running/);
    await expect(clock(white, "w")).toHaveText("2:58", { timeout: 4000 });
    await expect(clock(black, "w")).toHaveText(/^2:5[789]$/);
    await click(white, "g1", "f3");
    for (const side of [white, black]) {
      await expect(clock(side, "b")).toHaveClass(/running/);
      await expect(side.frame.locator(".moves .spent")).toHaveText([/^\d+\.\ds$/]);
      // White's clock took its 2 s increment.
      await expect(clock(side, "w")).toHaveText(/^3:0[01]$/);
    }
    // Nothing overflows the window, the clocks included.
    for (const side of [white, black]) {
      expect(await side.frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const strip = await side.frame.locator(".strip.bottom").boundingBox();
      const c = await side.frame.locator(".strip.bottom .clock").boundingBox();
      expect(c!.x + c!.width).toBeLessThanOrEqual(strip!.x + strip!.width + 0.5);
    }
    if (process.env.SHOTS) {
      for (const [side, who] of [
        [white, "white"],
        [black, "black"],
      ] as const)
        await side.page.screenshot({ path: join(process.env.SHOTS, `clock-${size.width}-${who}-${test.info().project.name}.png`) });
    }
    for (const side of [ana, bob]) await side.context.close();
  });
}
