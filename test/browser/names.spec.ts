// Players' names in real browsers (Chess 2.3.0): each strip shows the player's name beside a disc with its initials,
// the contact's name comes from its hello, markup in a name stays text, and a long name never pushes the clock off a
// 320 px phone nor hides the pieces taken. SHOTS=<dir> also saves screenshots of both pages there.
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

// 21 plies with 12 captures: White ends with eight pieces taken and a lead of 18, Black with four.
const CAPTURES = "e2e4 d7d5 e4d5 d8d5 b1c3 d5g2 f1g2 g8f6 g2b7 c8b7 g1f3 b7f3 d1f3 b8c6 f3c6 f6d7 c6a8 d7b8 a8b8 e8d7 b8a7".split(" ");

for (const width of [320, 375]) {
  test(`keeps the pieces taken and the lead in sight beside two long names, at ${width} px`, async ({ browser }) => {
    const sides = new Map<string, Side>();
    const contextOptions = { viewport: { width, height: 568 } };
    const ana = await openSide(browser, { name: "ana", sides, contextOptions, version: "2.3.0", displayName: LONG });
    const bob = await openSide(browser, { name: "bob", sides, contextOptions, version: "2.3.0", displayName: LONG });
    await ana.frame.locator('.setup .preset[data-tc="180+2"]').click();
    await ana.frame.locator(".setup .invite-btn").click();
    await bob.frame.locator(".invitation .accept-invite").click();
    for (const side of [ana, bob]) await expect(side.frame.locator(".side")).toHaveText(/^You play (white|black)$/);
    const anaWhite = (await ana.frame.locator(".side").textContent()) === "You play white";
    const [white, black] = anaWhite ? [ana, bob] : [bob, ana];
    for (const [i, uci] of CAPTURES.entries()) {
      const mover = i % 2 === 0 ? white : black;
      await expect(mover.frame.locator(".status")).toHaveText(/^Your move/);
      await click(mover, uci.slice(0, 2), uci.slice(2, 4));
    }
    await expect(black.frame.locator(".status")).toHaveText(/^Your move/);

    for (const side of [ana, bob]) {
      const caps: number[] = [];
      for (const where of ["top", "bottom"]) {
        const strip = side.frame.locator(`.strip.${where}`);
        const box = (await strip.boundingBox())!;
        // Every piece taken is drawn in full: the long name gave way, not the pieces.
        const taken = await strip.locator(".taken").evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth, caps: node.querySelectorAll(".cap").length }));
        expect(taken.scroll, `${where} .taken`).toBeLessThanOrEqual(taken.client);
        caps.push(taken.caps);
        for (const part of [".taken", ".clock", ".dot", ".name"]) {
          const inner = (await strip.locator(part).boundingBox())!;
          expect(inner.x, `${where} ${part}`).toBeGreaterThanOrEqual(box.x - 0.5);
          expect(inner.x + inner.width, `${where} ${part}`).toBeLessThanOrEqual(box.x + box.width + 0.5);
        }
        // The name is still there, cut with an ellipsis.
        const name = await strip.locator(".name").evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
        expect(name.client, `${where} .name`).toBeGreaterThanOrEqual(12);
        expect(name.scroll, `${where} .name`).toBeGreaterThan(name.client);
      }
      expect(caps.sort()).toEqual([4, 8]);
      // The lead in material, at the end of the pieces of the side that is ahead, inside its strip.
      const lead = side.frame.locator(".strip .lead");
      await expect(lead).toHaveText("+18");
      const edges = await lead.evaluate((node) => {
        const of = (e: Element) => (({ left, right }) => ({ left, right }))(e.getBoundingClientRect());
        return { lead: of(node), taken: of(node.closest(".taken")!), strip: of(node.closest(".strip")!) };
      });
      expect(edges.lead.right - edges.lead.left).toBeGreaterThan(8);
      for (const outer of [edges.taken, edges.strip]) {
        expect(edges.lead.left).toBeGreaterThanOrEqual(outer.left - 0.5);
        expect(edges.lead.right).toBeLessThanOrEqual(outer.right + 0.5);
      }
      const overflow = await side.frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }
    if (process.env.SHOTS) {
      for (const [who, side] of [["ana", ana], ["bob", bob]] as const) {
        await side.page.screenshot({ path: join(process.env.SHOTS, `names-captures-${width}-${who}-${test.info().project.name}.png`) });
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
