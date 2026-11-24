// covers: apps.chess
// The colours of words on the page, in both themes, against WCAG 2.2 AA (1.4.3): at least 4.5:1 for text under
// 18.66 px bold or 24 px, which is all of Chess's text. Read from src/style.css, so a new colour is checked as it is.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

/** The custom properties of the first rule whose selector is exactly `selector`. */
function variables(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

/** A colour of a rule's declaration, for the rules that set a literal colour rather than a variable. */
function declared(selector: string, property: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const match = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(body);
  if (!match) throw new Error(`${selector} sets no ${property}`);
  return match[1]!.trim();
}

const light = variables(":root");
const dark = { ...light, ...variables(':root[data-theme="dark"]') };

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`not a #rgb or #rrggbb colour: ${hex}`);
  const digits = match[1]!.length === 3 ? [...match[1]!].map((d) => d + d).join("") : match[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(digits.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** A colour as a theme gives it: a variable's value, or the colour itself. */
const resolve = (theme: Record<string, string>, colour: string) => (colour.startsWith("--") ? theme[colour.slice(2)]! : colour);

/** [where, text, background], as style.css pairs them. */
const PAIRS: [string, string, string][] = [
  ["the page's text", "--fg", "--bg"],
  ["a button's text", "--fg", "--btn"],
  ["a card's text", "--fg", "--surface"],
  ["a player's name and hints", "--muted", "--bg"],
  ["a clock that is not running", "--muted", "--btn"],
  ["a hint on a card", "--muted", "--surface"],
  ["Resign and Abort (.act.danger)", "--danger", "--btn"],
  ["a low clock that is not running", "--danger", "--btn"],
  ["the name of a contact whose Chess is silent", "--danger", "--bg"],
  ["Back to live (.act.live)", "--accent", "--btn"],
  ["a drawn move's ½ in the move list", "--accent", "--bg"],
  ["a drawn move's ½ on the current move", "--accent", "--btn"],
  ["the info button", "--accent", "--bg"],
  ["a running clock", "--bg", "--fg"],
];

describe("text contrast (WCAG AA, 4.5:1)", () => {
  for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
    for (const [where, text, background] of PAIRS) {
      it(`${where}, ${name} theme`, () => {
        expect(contrast(resolve(theme, text), resolve(theme, background))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("a primary button's text, light theme", () => {
    expect(contrast(declared(".act.primary", "color"), light.accent!)).toBeGreaterThanOrEqual(4.5);
  });

  it("a primary button's text, dark theme", () => {
    expect(contrast(declared(':root[data-theme="dark"] .act.primary', "color"), dark.accent!)).toBeGreaterThanOrEqual(4.5);
  });

  it("a low clock that is running, light theme", () => {
    expect(contrast(declared(".strip .clock.low.running", "color"), light.danger!)).toBeGreaterThanOrEqual(4.5);
  });

  it("a low clock that is running, dark theme", () => {
    expect(contrast(declared(':root[data-theme="dark"] .strip .clock.low.running', "color"), dark.danger!)).toBeGreaterThanOrEqual(4.5);
  });
});
