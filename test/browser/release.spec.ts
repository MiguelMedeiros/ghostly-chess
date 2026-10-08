// The release smoke: two sides of one chat on the built page, each in the runner's sandboxed frame, at the version
// the manifest names. One sitting covers what a release must not break: an invitation with a time control, names,
// both clocks, a draw offered and accepted, the PGN and its Copy, a rematch with colours swapped, and a game won by
// checkmate. docs/PUBLISHING.md asks for this spec before a version is signed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openSide, type Side } from "./harness.ts";

const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, "../../ghostly-app.json"), "utf8")) as { version: string }).version;

async function click(side: Side, from: string, to: string): Promise<void> {
  await side.frame.locator(`[data-square="${from}"]`).click();
  await side.frame.locator(`[data-square="${to}"]`).click();
}

const piece = (side: Side, square: string) => side.frame.locator(`[data-square="${square}"]`);
const clock = (side: Side, colour: "w" | "b") => side.frame.locator(`.strip:has(.dot.${colour}) .clock`);

/** A clock's reading in seconds ("2:58" is 178). */
async function seconds(side: Side, colour: "w" | "b"): Promise<number> {
  const text = (await clock(side, colour).textContent()) ?? "";
  return text.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

/** Opens the PGN from the game-over card and returns its text; the dialog stays open. */
async function openPgn(side: Side): Promise<string> {
  await side.frame.locator(".over .over-pgn").click();
  const text = side.frame.locator(".pgn-text");
  await expect(text).toBeVisible();
  return text.inputValue();
}

test("a timed game drawn by agreement, its PGN copied, then a rematch won by checkmate", async ({ browser }) => {
  const sides = new Map<string, Side>();
  // Desktop's chat-app window.
  const contextOptions = { viewport: { width: 560, height: 640 } };
  const errors: string[] = [];
  const ana = await openSide(browser, { name: "ana", mode: "frame", sides, contextOptions, version: VERSION, displayName: "Ana Silva" });
  const bob = await openSide(browser, { name: "bob", mode: "frame", sides, contextOptions, version: VERSION, displayName: "Bob Costa" });
  for (const side of [ana, bob]) side.page.on("pageerror", (e) => errors.push(`${side.name}: ${e.message}`));

  // Ana invites to 3 minutes + 2 seconds; Bob accepts the card.
  await ana.frame.locator('.setup .preset[data-tc="180+2"]').click();
  await ana.frame.locator(".setup .invite-btn").click();
  await expect(bob.frame.locator(".invitation .invite-words")).toHaveText("Your contact invites you: Blitz, 3 min + 2 s");
  await bob.frame.locator(".invitation .accept-invite").click();
  for (const side of [ana, bob]) await expect(side.frame.locator(".side")).toHaveText(/^You play (white|black)$/);
  const anaWhite = (await ana.frame.locator(".side").textContent()) === "You play white";
  const [white, black] = anaWhite ? [ana, bob] : [bob, ana];
  const [whiteName, blackName] = anaWhite ? ["Ana Silva", "Bob Costa"] : ["Bob Costa", "Ana Silva"];

  // Each side sees its own name below and the contact's above, and both clocks at 3:00.
  await expect(white.frame.locator(".strip.bottom .name")).toHaveText(whiteName);
  await expect(white.frame.locator(".strip.top .name")).toHaveText(blackName);
  await expect(black.frame.locator(".strip.top .name")).toHaveText(whiteName);
  for (const side of [white, black]) {
    await expect(clock(side, "w")).toHaveText("3:00");
    await expect(clock(side, "b")).toHaveText("3:00");
  }

  // 1. e4 e5 2. Nf3: the clocks run from ply 2, and count down on both pages.
  await click(white, "e2", "e4");
  await expect(piece(black, "e4")).toHaveAttribute("data-piece", "wp");
  await click(black, "e7", "e5");
  await expect(piece(white, "e5")).toHaveAttribute("data-piece", "bp");
  for (const side of [white, black]) await expect(clock(side, "w")).toHaveClass(/running/);
  const first = await seconds(white, "w");
  await expect.poll(() => seconds(white, "w"), { timeout: 4000 }).toBeLessThan(first);
  await click(white, "g1", "f3");
  await expect(piece(black, "f3")).toHaveAttribute("data-piece", "wn");
  for (const side of [white, black]) await expect(clock(side, "b")).toHaveClass(/running/);

  // Black offers a draw; White accepts on the card. Both clocks stop.
  await black.frame.getByRole("button", { name: "Offer draw" }).click();
  await expect(white.frame.locator(".offer-card .offer")).toHaveText("Your contact offers a draw");
  await white.frame.getByRole("button", { name: "Accept" }).click();
  for (const side of [white, black]) {
    await expect(side.frame.locator(".over-head")).toHaveText("Draw");
    await expect(side.frame.locator(".over-reason")).toHaveText("Agreed");
    await expect(side.frame.locator(".clock.running")).toHaveCount(0);
  }

  // The PGN names both players, the time control and the result, with White's clock after its second move.
  const drawn = await openPgn(white);
  expect(drawn).toContain(`[White "${whiteName}"]`);
  expect(drawn).toContain(`[Black "${blackName}"]`);
  expect(drawn).toContain('[Result "1/2-1/2"]');
  expect(drawn).toContain('[TimeControl "180+2"]');
  expect(drawn).toMatch(/\n1\. e4 e5 2\. Nf3 \{\[%clk 0:0[23]:\d\d\]\} 1\/2-1\/2\n$/);
  // Copy: Copied when the browser let the frame copy, else the whole text stays selected with the hint.
  await white.frame.getByRole("button", { name: "Copy", exact: true }).click();
  const status = white.frame.locator(".pgn-status");
  await expect(status).toHaveText(/^(Copied|Copy the selected text \(on a phone, press and hold it\)\.)$/);
  test.info().annotations.push({ type: "copy", description: (await status.textContent()) ?? "" });
  const selection = await white.frame.evaluate(() => {
    const t = document.querySelector<HTMLTextAreaElement>(".pgn-text")!;
    return { start: t.selectionStart, end: t.selectionEnd, length: t.value.length };
  });
  expect(selection).toEqual({ start: 0, end: drawn.length, length: drawn.length });
  await white.page.keyboard.press("Escape");
  await expect(white.frame.locator(".pgn-text")).toHaveCount(0);

  // Black asks for a rematch from the game-over card: the same time control, colours swapped.
  await black.frame.locator(".over .over-rematch").click();
  await expect(white.frame.locator(".invitation .invite-words")).toHaveText("Rematch? (3 | 2)");
  await white.frame.locator(".invitation .accept-invite").click();
  await expect(white.frame.locator(".side")).toHaveText("You play black");
  await expect(black.frame.locator(".side")).toHaveText("You play white");
  const [white2, black2] = [black, white];
  for (const side of [white2, black2]) {
    await expect(clock(side, "w")).toHaveText("3:00");
    await expect(clock(side, "b")).toHaveText("3:00");
    await expect(side.frame.locator(".over")).toBeHidden();
  }

  // 1. f3 e5 2. g4 Qh4#.
  await click(white2, "f2", "f3");
  await expect(piece(black2, "f3")).toHaveAttribute("data-piece", "wp");
  await click(black2, "e7", "e5");
  await expect(piece(white2, "e5")).toHaveAttribute("data-piece", "bp");
  await click(white2, "g2", "g4");
  await expect(piece(black2, "g4")).toHaveAttribute("data-piece", "wp");
  await click(black2, "d8", "h4");
  for (const side of [white2, black2]) {
    await expect(piece(side, "h4")).toHaveAttribute("data-piece", "bq");
    await expect(side.frame.locator(".over-reason")).toHaveText("Checkmate");
    await expect(side.frame.locator(".clock.running")).toHaveCount(0);
  }
  await expect(black2.frame.locator(".over-head")).toHaveText("You win");
  await expect(white2.frame.locator(".over-head")).toHaveText("You lose");
  const mated = await openPgn(black2);
  expect(mated).toContain(`[White "${blackName}"]`);
  expect(mated).toContain(`[Black "${whiteName}"]`);
  expect(mated).toContain('[Result "0-1"]');
  expect(mated).toMatch(/\n1\. f3 e5 2\. g4 \{\[%clk 0:0[23]:\d\d\]\} Qh4# \{\[%clk 0:0[23]:\d\d\]\} 0-1\n$/);

  // Nothing broke the runner's rules on the way, and no script failed.
  for (const side of [ana, bob]) expect(await side.frame.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
  expect(errors).toEqual([]);
  for (const side of [ana, bob]) await side.context.close();
});
