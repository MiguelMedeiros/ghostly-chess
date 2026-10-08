// Players' names in real browsers (Chess 2.3.0): each strip shows the player's name beside a disc with its initials,
// the contact's name comes from its hello, markup in a name stays text, and a long name never pushes the clock off a
// 320 px phone. SHOTS=<dir> also saves screenshots of both pages there.
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openSide, type Side } from "./harness.ts";

async function click(side: Side, from: string, to: string): Promise<void> {
  await side.frame.locator(`[data-square="${from}"]`).click();
  await side.frame.locator(`[data-square="${to}"]`).click();
}

const LONG = "<b>Bob</b> of the Rio de Janeiro Sunday Morning Chess Club";
const SHOWN = [...LONG].slice(0, 48).join("").trim();

for (const size of [
  { width: 1024, height: 720 },
  { width: 320, height: 568 },
]) {
  test(`shows both players' names and initials in a timed game, at ${size.width}x${size.height}`, async ({ browser }) => {
    const sides = new Map<string, Side>();
    const contextOptions = { viewport: size };
    const ana = await openSide(browser, { name: "ana", sides, contextOptions, version: "2.3.0", displayName: "Ana Silva" });
    const bob = await openSide(browser, { name: "bob", sides, contextOptions, version: "2.3.0", displayName: LONG });
    await ana.frame.locator('.setup .preset[data-tc="180+2"]').click();
    await ana.frame.locator(".setup .invite-btn").click();
    await bob.frame.locator(".invitation .accept-invite").click();
    for (const side of [ana, bob]) await expect(side.frame.locator(".side")).toHaveText(/^You play (white|black)$/);
    const anaWhite = (await ana.frame.locator(".side").textContent()) === "You play white";
    const [white, black] = anaWhite ? [ana, bob] : [bob, ana];

    // Each side: its own name at the bottom, the contact's on top, as text.
    await expect(ana.frame.locator(".strip.bottom .name")).toHaveText("Ana Silva");
    await expect(ana.frame.locator(".strip.bottom .dot")).toHaveText("AS");
    await expect(ana.frame.locator(".strip.top .name")).toHaveText(SHOWN);
    await expect(ana.frame.locator(".strip.top .dot")).toHaveText("BM");
    await expect(bob.frame.locator(".strip.top .name")).toHaveText("Ana Silva");
    await expect(bob.frame.locator(".strip.bottom .name")).toHaveText(SHOWN);
    for (const side of [ana, bob]) expect(await side.frame.locator("b").count()).toBe(0);

    await click(white, "e2", "e4");
    await click(black, "d7", "d5");
    await click(white, "e4", "d5");
    await expect(black.frame.locator(".status")).toHaveText(/^Your move/);

    // The long name ends in an ellipsis; the clock and the disc stay inside the strip, and nothing scrolls sideways.
    for (const side of [ana, bob]) {
      for (const where of ["top", "bottom"]) {
        const strip = (await side.frame.locator(`.strip.${where}`).boundingBox())!;
        for (const part of [".clock", ".dot"]) {
          const box = (await side.frame.locator(`.strip.${where} ${part}`).boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(strip.x - 0.5);
          expect(box.x + box.width).toBeLessThanOrEqual(strip.x + strip.width + 0.5);
        }
      }
      const overflow = await side.frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }
    if (process.env.SHOTS) {
      for (const [who, side] of [["ana", ana], ["bob", bob]] as const) {
        await side.page.screenshot({ path: join(process.env.SHOTS, `names-${size.width}-${who}-${test.info().project.name}.png`) });
      }
    }
    for (const side of [ana, bob]) await side.context.close();
  });
}

test("keeps the words 'You' and 'Your contact' without the name permission", async ({ browser }) => {
  const sides = new Map<string, Side>();
  const ana = await openSide(browser, { name: "ana", sides, version: "2.3.0" });
  const bob = await openSide(browser, { name: "bob", sides, version: "2.3.0", displayName: "Bob" });
  await ana.frame.locator(".setup .invite-btn").click();
  await bob.frame.locator(".invitation .accept-invite").click();
  for (const side of [ana, bob]) await expect(side.frame.locator(".side")).toHaveText(/^You play (white|black)$/);
  await expect(ana.frame.locator(".strip.bottom")).toHaveText("You");
  await expect(ana.frame.locator(".strip.top .name")).toHaveText("Bob");
  await expect(bob.frame.locator(".strip.top")).toHaveText("Your contact");
  await expect(bob.frame.locator(".strip.bottom .name")).toHaveText("Bob");
  for (const side of [ana, bob]) await side.context.close();
});
