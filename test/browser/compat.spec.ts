// This build against the published Chess 1.0.2 page (fixtures/chess-1.0.2.html, checked against the digest it was
// published with), in real browsers, through the harness's Node relay: 1.0.2 tosses by itself, this build answers in
// version 1, and a short game ends the same on both boards. It also opens the protocol 2 new-game panel and
// invitation between two of today's pages.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chess102Page, openSide, type Side } from "./harness.ts";

const CHESS_102_DIGEST = "l5ozbABlwoZn7MBgzaQniVWT4shgPI10A_0Bi-fZENE";

async function click(side: Side, from: string, to: string): Promise<void> {
  await side.frame.locator(`[data-square="${from}"]`).click();
  await side.frame.locator(`[data-square="${to}"]`).click();
}

test("plays Scholar's mate against the published Chess 1.0.2", async ({ browser }) => {
  const fixture = readFileSync(join(import.meta.dirname, "fixtures/chess-1.0.2.html"));
  expect(createHash("sha256").update(fixture).digest("base64url")).toBe(CHESS_102_DIGEST);

  const sides = new Map<string, Side>();
  const old = await openSide(browser, { name: "old", sides, version: "1.0.2", html: chess102Page() });
  const now = await openSide(browser, { name: "new", sides, version: "2.0.0" });
  for (const side of [old, now]) await expect(side.frame.locator(".side")).toHaveText(/^You play (white|black)$/);
  const nowWhite = (await now.frame.locator(".side").textContent()) === "You play white";
  const [white, black] = nowWhite ? [now, old] : [old, now];
  await expect(black.frame.locator(".side")).toHaveText("You play black");
  // This build says what the contact's version lacks.
  await expect(now.frame.locator(".standing-text")).toHaveText("Your contact has Chess 1.0.2. Clocks, takebacks and rematches come when they update.");
  const plies = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"];
  for (const [i, uci] of plies.entries()) {
    const mover = i % 2 === 0 ? white : black;
    await expect(mover.frame.locator(".status")).toHaveText(/^Your move/);
    await click(mover, uci.slice(0, 2), uci.slice(2, 4));
  }
  await expect(white.frame.locator(".status")).toHaveText("You win: checkmate");
  await expect(black.frame.locator(".status")).toHaveText("You lose: checkmate");
  // 1.0.2 never saw a frame it does not know: no "newer Chess" notice there.
  await expect(old.frame.locator(".notice")).not.toHaveText(/newer/);
  for (const side of [old, now]) await side.context.close();
});

test("invites from the new-game panel, and the contact accepts the card", async ({ browser }) => {
  const sides = new Map<string, Side>();
  const ana = await openSide(browser, { name: "ana", sides });
  await expect(ana.frame.locator(".status")).toHaveText("Waiting for your contact to open Chess");
  await expect(ana.frame.locator(".setup")).toBeVisible();
  // Only Unlimited can be played until the clocks come; the others say why.
  await expect(ana.frame.locator(".setup .preset:not([disabled])")).toHaveCount(1);
  await expect(ana.frame.locator(".setup .preset-unlimited")).toBeEnabled();
  await expect(ana.frame.locator(".setup .preset-reason")).toHaveText("Coming in a later version of Chess");
  const bob = await openSide(browser, { name: "bob", sides });
  await expect(bob.frame.locator(".status")).toHaveText("Invite your contact to a game");
  await ana.frame.locator(".setup .invite-btn").click();
  await expect(ana.frame.locator(".status")).toHaveText("Invitation sent");
  await expect(bob.frame.locator(".invitation .invite-words")).toHaveText("Your contact invites you: Unlimited");
  await bob.frame.locator(".invitation .accept-invite").click();
  for (const side of [ana, bob]) {
    await expect(side.frame.locator(".side")).toHaveText(/^You play (white|black)$/);
    await expect(side.frame.locator(".setup")).toBeHidden();
    await expect(side.frame.locator(".invitation")).toBeHidden();
  }
  for (const side of [ana, bob]) await side.context.close();
});
