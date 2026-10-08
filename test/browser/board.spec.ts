// The built page in Chromium and WebKit: drag and drop with a mouse and a finger, taps, the layout at the sizes Chess
// runs at (and a board that keeps its size while a game goes on), forced colours, and the page in a sandboxed frame
// under the web runner's CSP.
//
// Not covered here: a real finger's drag in WebKit (Playwright drives no touch-move there), and WebKit's choice not
// to pan the page under it. Both are checked by hand in iOS Safari and in Desktop's WKWebView (README, "Checked by
// hand").
import { expect, test } from "@playwright/test";
import { chatPair, mouseDrag, openSide, squareCenter, type Side } from "./harness.ts";

/** The side whose move it is. */
async function mover(white: Side, black: Side): Promise<Side> {
  return (await white.frame.locator(".status").textContent())!.startsWith("Your move") ? white : black;
}

test.describe("drag and drop", () => {
  test("a mouse drag plays a move, and the contact's board shows it", async ({ browser }) => {
    const { white, black, sides } = await chatPair(browser);
    await expect(white.frame.locator(".status")).toHaveText(/^Your move/);
    await mouseDrag(white, "e2", "e4");
    for (const side of sides) {
      await expect(side.frame.locator('[data-square="e4"]')).toHaveText(/♟/);
      await expect(side.frame.locator('[data-square="e4"]')).toHaveClass(/\blast\b/);
      await expect(side.frame.locator('[data-square="e2"]')).toHaveText("");
    }
    await expect(black.frame.locator(".status")).toHaveText(/^Your move/);
    // An illegal drop snaps back: nothing moves, nothing is sent.
    await mouseDrag(black, "e7", "e3");
    await expect(black.frame.locator('[data-square="e7"]')).toHaveText(/♟/);
    await expect(black.frame.locator(".status")).toHaveText(/^Your move/);
    for (const side of sides) await side.context.close();
  });

  test("click, click still plays a move (Ghostly's end-to-end tests do it this way)", async ({ browser }) => {
    const { white, black, sides } = await chatPair(browser);
    const board = white.frame;
    await board.locator('[data-square="g1"]').click();
    await expect(board.locator('[data-square="g1"]')).toHaveClass(/\bselected\b/);
    await board.locator('[data-square="f3"]').click();
    for (const side of [white, black]) {
      await expect(side.frame.locator('[data-square="f3"]')).toHaveText(/♞/);
      await expect(side.frame.locator('[data-square="g1"]')).toHaveText("");
    }
    for (const side of sides) await side.context.close();
  });

  test("a touch drag plays a move and does not scroll the page (WebKit: the pointer path only)", async ({ browser, browserName }) => {
    // A short phone window (a keyboard up, or a landscape phone), with a page taller than it, so a finger that panned would scroll it.
    const { white, sides } = await chatPair(browser, "top", { viewport: { width: 360, height: 360 }, hasTouch: true, isMobile: browserName === "chromium" });
    await expect(white.frame.locator(".status")).toHaveText(/^Your move/);
    const from = await squareCenter(white, "d2");
    const to = await squareCenter(white, "d4");
    // The page can scroll (it is taller than its window), so a finger that panned would move it.
    expect(await white.page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
    await white.page.evaluate(() => window.scrollTo(0, 0));
    if (browserName === "chromium") {
      // A real touch through the DevTools protocol: the browser decides between panning and pointer events itself.
      const cdp = await white.context.newCDPSession(white.page);
      const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
        cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
      await touch("touchStart", from.x, from.y);
      for (let i = 1; i <= 10; i++) await touch("touchMove", from.x, from.y + ((to.y - from.y) * i) / 10);
      await touch("touchEnd", to.x, to.y);
    } else {
      // WebKit through Playwright has no touch-move: pointer events with pointerType "touch" stand in. They check the
      // drag path only; they never pan, so the scroll check below cannot fail here. WebKit's own choice to pan is
      // checked by hand in iOS Safari and Desktop's WKWebView.
      await white.frame.locator(".board").evaluate((board, [a, b]) => {
        const fire = (type: string, x: number, y: number) =>
          board.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, button: 0 }));
        const target = document.elementFromPoint(a.x, a.y)!;
        target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: a.x, clientY: a.y, button: 0 }));
        for (let i = 1; i <= 10; i++) fire("pointermove", a.x, a.y + ((b.y - a.y) * i) / 10);
        fire("pointerup", b.x, b.y);
      }, [from, to]);
    }
    await expect(white.frame.locator('[data-square="d4"]')).toHaveText(/♟/);
    await expect(white.frame.locator('[data-square="d2"]')).toHaveText("");
    expect(await white.page.evaluate(() => window.scrollY)).toBe(0);
    for (const side of sides) await side.context.close();
  });
});

test.describe("taps", () => {
  test("a finger's tap, tap plays a move (a touch's late click is not a second tap)", async ({ browser, browserName }) => {
    const { white, black, sides } = await chatPair(browser, "top", { viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: browserName === "chromium" });
    await expect(white.frame.locator(".status")).toHaveText(/^Your move/);
    const e2 = await squareCenter(white, "e2");
    await white.page.touchscreen.tap(e2.x, e2.y);
    await expect(white.frame.locator('[data-square="e2"]')).toHaveClass(/\bselected\b/);
    const e4 = await squareCenter(white, "e4");
    await white.page.touchscreen.tap(e4.x, e4.y);
    for (const side of [white, black]) {
      await expect(side.frame.locator('[data-square="e4"]')).toHaveText(/♟/);
      await expect(side.frame.locator('[data-square="e2"]')).toHaveText("");
    }
    for (const side of sides) await side.context.close();
  });
});

test.describe("layout", () => {
  for (const [width, height] of [[320, 568], [375, 667], [420, 640], [560, 640], [1280, 800]] as const) {
    test(`at ${width}x${height} the whole board shows, nothing scrolls sideways, and squares are at least 24 px`, async ({ browser }) => {
      const side = await openSide(browser, { name: "solo", inChat: false, contextOptions: { viewport: { width, height } } });
      const page = side.page;
      await expect(page.locator(".status")).toHaveText("White to move");
      const fit = await page.evaluate(() => {
        const board = document.querySelector(".board")!.getBoundingClientRect();
        const squares = [...document.querySelectorAll(".sq")].map((s) => s.getBoundingClientRect());
        return {
          board: { left: board.left, top: board.top, right: board.right, bottom: board.bottom },
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          smallest: Math.min(...squares.map((r) => Math.min(r.width, r.height))),
          squares: squares.length,
        };
      });
      expect(fit.squares).toBe(64);
      expect(fit.board.left).toBeGreaterThanOrEqual(0);
      expect(fit.board.top).toBeGreaterThanOrEqual(0);
      expect(fit.board.right).toBeLessThanOrEqual(width);
      expect(fit.board.bottom).toBeLessThanOrEqual(height);
      expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
      expect(fit.smallest).toBeGreaterThanOrEqual(24);
      await side.context.close();
    });
  }
});

test.describe("a board that keeps its size", () => {
  for (const [width, height] of [[320, 568], [560, 640]] as const) {
    test(`in a chat at ${width}x${height}, the first move, a draw offer and a notice leave the board as it was`, async ({ browser }) => {
      const { white, black, sides } = await chatPair(browser, "top", { viewport: { width, height } });
      const box = async () => {
        await white.page.waitForTimeout(100); // a layout pass after the change
        return white.frame.locator(".board").boundingBox();
      };
      await expect(white.frame.locator(".status")).toHaveText(/^Your move/);
      const start = await box();
      expect(start).not.toBeNull();
      await mouseDrag(white, "e2", "e4");
      await expect(white.frame.locator(".moves")).toBeVisible();
      expect(await box(), "after the first move").toEqual(start);
      await expect(black.frame.locator(".status")).toHaveText(/^Your move/);
      await black.frame.getByRole("button", { name: "Offer draw" }).click();
      const accept = white.frame.getByRole("button", { name: "Accept" });
      await expect(accept).toBeVisible();
      expect(await box(), "with the contact's draw offer").toEqual(start);
      // The offer's buttons are on the screen and not under anything.
      const acceptBox = (await accept.boundingBox())!;
      expect(acceptBox.y + acceptBox.height).toBeLessThanOrEqual(height);
      await accept.click();
      await expect(white.frame.locator(".status")).toHaveText(/^Draw/);
      expect(await box(), "after the draw").toEqual(start);
      await white.page.evaluate(() => (window as unknown as { __deliver: (d: unknown) => void }).__deliver({ k: 42 }));
      await expect(white.frame.locator(".notice:not(.info)")).not.toBeEmpty();
      expect(await box(), "with a notice").toEqual(start);
      for (const side of sides) await side.context.close();
    });
  }

  test("before the first move, the empty move list has no box and no tab stop", async ({ browser }) => {
    const side = await openSide(browser, { name: "solo", inChat: false, contextOptions: { viewport: { width: 375, height: 667 } } });
    await expect(side.page.locator(".status")).toHaveText("White to move");
    const moves = await side.page.locator(".moves").evaluate((list) => {
      const rect = list.getBoundingClientRect();
      return { display: getComputedStyle(list).display, width: rect.width, height: rect.height };
    });
    expect(moves).toEqual({ display: "none", width: 0, height: 0 });
    // Tab from the board goes past the list: to the controls.
    await side.page.locator('[data-square="e2"]').focus();
    await side.page.keyboard.press("Tab");
    expect(await side.page.evaluate(() => document.activeElement?.classList.contains("moves"))).toBe(false);
    await side.context.close();
  });
});

test.describe("forced colours (Windows high contrast)", () => {
  test("a dark high-contrast theme keeps the checkerboard and both sides' pieces", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "Playwright emulates forced colours in Chromium only");
    for (const pieces of ["cburnett", "classic"] as const) {
      const side = await openSide(browser, { name: "solo", inChat: false, contextOptions: { viewport: { width: 560, height: 640 }, forcedColors: "active", colorScheme: "dark" } });
      const page = side.page;
      await expect(page.locator(".status")).toHaveText("White to move");
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
      if (pieces === "classic") {
        await page.locator(".settings-btn").click();
        await page.locator('input[value="classic"]').check();
        await page.keyboard.press("Escape");
        await expect(page.locator(".board-wrap")).toHaveClass(/\bclassic\b/);
      }
      const colours = await page.evaluate(() => {
        const bg = (s: string) => getComputedStyle(document.querySelector(`[data-square="${s}"]`)!).backgroundColor;
        const ink = (s: string) => {
          const square = document.querySelector(`[data-square="${s}"]`)!;
          const path = square.querySelector("svg.piece path");
          return path ? getComputedStyle(path).fill : getComputedStyle(square.querySelector(".glyph")!).color;
        };
        // e2 and d7 are light squares, d2 and e7 dark ones.
        return { light: bg("e2"), dark: bg("d2"), e7: bg("e7"), d7: bg("d7"), black: ink("e7"), blackOnDark: ink("d7"), white: ink("e2") };
      });
      expect(colours.light, pieces).not.toBe(colours.dark);
      expect(colours.black, pieces).not.toBe(colours.e7);
      expect(colours.blackOnDark, pieces).not.toBe(colours.d7);
      expect(colours.black, pieces).not.toBe(colours.white);
      await side.context.close();
    }
  });
});

test.describe("in the runner's sandbox", () => {
  test("the pieces render under the runner's CSP, with no violation, and a drag plays", async ({ browser }) => {
    const side = await openSide(browser, { name: "solo", inChat: false, mode: "frame", contextOptions: { viewport: { width: 560, height: 640 } } });
    const frame = side.frame;
    expect(frame.parentFrame()).not.toBeNull();
    await expect(frame.locator(".status")).toHaveText("White to move");
    const box = await frame.locator('[data-square="e2"] svg.piece').boundingBox();
    expect(box?.width).toBeGreaterThan(0);
    expect(box?.height).toBeGreaterThan(0);
    await mouseDrag(side, "e2", "e4");
    await expect(frame.locator('[data-square="e4"]')).toHaveText(/♟/);
    await expect(frame.locator(".status")).toHaveText("Black to move");
    expect(await frame.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
    expect(await side.page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
    await side.context.close();
  });

  test("two framed sides play over the relay", async ({ browser }) => {
    const { white, black, sides } = await chatPair(browser, "frame");
    await mouseDrag(white, "e2", "e4");
    await expect(black.frame.locator('[data-square="e4"]')).toHaveText(/♟/);
    await mouseDrag(await mover(white, black), "c7", "c5");
    await expect(white.frame.locator('[data-square="c5"]')).toHaveText(/♟/);
    for (const side of sides) expect(await side.frame.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
    for (const side of sides) await side.context.close();
  });
});
