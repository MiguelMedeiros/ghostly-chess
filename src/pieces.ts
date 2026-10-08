/**
 * The pieces on the board. Two sets:
 * - "cburnett" (the default): SVG drawings by Colin M.L. Burnett, BSD-3-Clause (assets/pieces/cburnett/LICENSE). The
 *   data in src/generated/pieces.ts is built into elements here with createElementNS, once per piece, and each square
 *   gets a clone. No markup is ever parsed (no HTML strings, no template element, no data: URL), so nothing meets
 *   the web runner's guard on HTML parsing or Desktop's content rules.
 * - "classic": the Unicode glyphs Chess 1.0.2 drew, coloured by CSS. They cost nothing: every square carries its glyph
 *   anyway (see glyph()).
 */
import { CBURNETT, type PieceTree } from "./generated/pieces.ts";

export type PieceSet = "cburnett" | "classic";
export const PIECE_SETS: readonly PieceSet[] = ["cburnett", "classic"];

/** The SVG namespace: a name for the element type, not an address; nothing is fetched from it. */
/** The SVG namespace: written once in the bundle (test/bundle.test.ts), for every drawn icon. */
export const SVG_NS = "http://www.w3.org/2000/svg";

// Solid glyphs for both sides, each with U+FE0E so no platform draws the pawn as an emoji (as in 1.0.2).
const GLYPHS: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

/** A piece's glyph, the text a square holds for it: "♛︎". */
export const glyph = (type: string): string => `${GLYPHS[type]}︎`;

function build(tree: PieceTree): Element {
  const [tag, attributes, children] = tree;
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  for (const child of children ?? []) node.append(build(child));
  return node;
}

const made = new Map<string, Element>();

/** A new drawing of a piece ("wq") in the SVG set, aria-hidden: the square's label says what stands there. */
export function pieceSvg(key: string): Element {
  let original = made.get(key);
  if (!original) {
    const tree = CBURNETT[key];
    if (!tree) throw new Error(`no piece ${key}`);
    original = build(tree);
    original.setAttribute("class", "piece");
    original.setAttribute("aria-hidden", "true");
    original.setAttribute("focusable", "false");
    made.set(key, original);
  }
  return original.cloneNode(true) as Element;
}
