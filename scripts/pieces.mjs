// Turns the vendored piece SVGs (assets/pieces/<set>/Chess_<piece><l|d>t45.svg) into src/generated/pieces.ts: data,
// not markup. Each piece is a tree of [tag, attributes, children?] that src/pieces.ts builds with createElementNS, so
// no markup is ever parsed in the page (no innerHTML, no <template>, no data: URL).
//
//   npm run gen:pieces            writes src/generated/pieces.ts
//   node scripts/pieces.mjs --check   fails when the file differs from what the SVGs give
//
// Only svg, g, path and circle pass, with the attributes in ATTRIBUTES. A `style` declaration becomes a presentation
// attribute (the declaration wins over an attribute of the same name, as in CSS). Dropped: the XML declaration, the
// DOCTYPE, comments, <style>/<defs>/<title>/<desc>/<metadata> with what they hold, ids, xmlns, xlink and `version`;
// the root's width and height become its viewBox. A declaration that changes nothing is dropped too: one that sets an
// inherited property to the value it already inherits, `opacity: 1`, and the defaults in NO_OP_DEFAULTS while nothing
// above set them otherwise. Anything else (another tag, another attribute, text) fails the build.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(import.meta.dirname, "..");
export const SETS = { cburnett: "assets/pieces/cburnett" };
export const OUT = "src/generated/pieces.ts";

export const TAGS = ["svg", "g", "path", "circle"];
export const ATTRIBUTES = [
  "viewBox", "d", "fill", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "opacity", "transform", "cx", "cy", "r",
];
const SKIPPED_TAGS = ["style", "defs", "title", "desc", "metadata"];

/** Inherited properties and their initial values (SVG 1.1 and CSS). */
const INHERITED = {
  fill: "#000", "fill-rule": "nonzero", stroke: "none", "stroke-width": "1", "stroke-linecap": "butt",
  "stroke-linejoin": "miter", "stroke-miterlimit": "4", "fill-opacity": "1", "stroke-opacity": "1",
  "stroke-dasharray": "none", "stroke-dashoffset": "0",
};
/** Properties outside the allowlist that may appear at their default, where they change nothing. */
const NO_OP_DEFAULTS = ["fill-opacity", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset"];

/** A tiny strict XML reader: elements, attributes, whitespace; the prolog and comments skipped. */
function parseXml(text, file) {
  let i = 0;
  const fail = (why) => {
    throw new Error(`${file}: ${why} at offset ${i}`);
  };
  const stack = [{ tag: "#root", attrs: {}, children: [] }];
  while (i < text.length) {
    if (text.startsWith("<?", i)) {
      i = text.indexOf("?>", i) + 2;
      if (i < 2) fail("unterminated declaration");
    } else if (text.startsWith("<!--", i)) {
      i = text.indexOf("-->", i) + 3;
      if (i < 3) fail("unterminated comment");
    } else if (text.startsWith("<!DOCTYPE", i)) {
      i = text.indexOf(">", i) + 1;
      if (i < 1) fail("unterminated DOCTYPE");
    } else if (text.startsWith("</", i)) {
      const m = /^<\/([A-Za-z][\w:.-]*)\s*>/.exec(text.slice(i));
      if (!m) fail("bad closing tag");
      const open = stack.pop();
      if (open.tag !== m[1]) fail(`</${m[1]}> closes <${open.tag}>`);
      i += m[0].length;
    } else if (text[i] === "<") {
      const m = /^<([A-Za-z][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(text.slice(i));
      if (!m) fail("bad tag");
      const attrs = {};
      for (const a of m[2].matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        if (a[1] in attrs) fail(`attribute ${a[1]} twice`);
        attrs[a[1]] = a[2] ?? a[3];
      }
      const node = { tag: m[1], attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!m[3]) stack.push(node);
      i += m[0].length;
    } else {
      const next = text.indexOf("<", i);
      const chunk = text.slice(i, next < 0 ? text.length : next);
      // Text inside a skipped element (a <title>) goes with it; anywhere else only whitespace may stand.
      const inSkipped = stack.some((n) => SKIPPED_TAGS.includes(n.tag));
      if (chunk.trim() && !inSkipped) fail(`text "${chunk.trim().slice(0, 20)}"`);
      i += chunk.length;
    }
  }
  if (stack.length !== 1) fail(`<${stack[stack.length - 1].tag}> is not closed`);
  const elements = stack[0].children;
  if (elements.length !== 1 || elements[0].tag !== "svg") fail("expected one <svg> root");
  return elements[0];
}

const COLOURS = { white: "#fff", black: "#000" };
function colour(value) {
  const v = value.trim().toLowerCase();
  if (COLOURS[v]) return COLOURS[v];
  const m = /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/.exec(v);
  return m ? `#${m[1]}${m[2]}${m[3]}` : v;
}

/** Path data with the least whitespace that reads the same. */
const pathData = (d) => d.replace(/,/g, " ").replace(/\s+/g, " ").replace(/ ?([A-Za-z]) ?/g, "$1").replace(/ -/g, "-").trim();

function normalise(name, value) {
  const v = value.trim().replace(/\s+/g, " ");
  if (name === "fill" || name === "stroke") return colour(v);
  if (name === "d") return pathData(v);
  if (name === "transform") return v.replace(/\s*,\s*/g, ",").replace(/\s*\(\s*/g, "(").replace(/\s*\)/g, ")");
  return v;
}

function convert(node, inherited, file) {
  if (!TAGS.includes(node.tag)) throw new Error(`${file}: <${node.tag}> is not allowed`);
  const declared = {};
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name === "style" || name === "id" || name === "version" || name === "xmlns" || name.startsWith("xmlns:") || name.startsWith("xlink:")) continue;
    if (node.tag === "svg" && (name === "width" || name === "height")) continue;
    declared[name] = value;
  }
  if (node.attrs.style) {
    for (const part of node.attrs.style.split(";")) {
      if (!part.trim()) continue;
      const colon = part.indexOf(":");
      if (colon < 0) throw new Error(`${file}: bad style declaration "${part}"`);
      declared[part.slice(0, colon).trim()] = part.slice(colon + 1);
    }
  }
  if (node.tag === "svg") {
    const w = node.attrs.width ?? node.attrs.height;
    const h = node.attrs.height ?? node.attrs.width;
    if (!declared.viewBox) {
      if (!w || !/^\d+(\.\d+)?$/.test(w) || !/^\d+(\.\d+)?$/.test(h)) throw new Error(`${file}: the root has no viewBox and no size`);
      declared.viewBox = `0 0 ${w} ${h}`;
    }
  }
  const attrs = {};
  const passOn = { ...inherited };
  for (const [name, raw] of Object.entries(declared)) {
    const value = normalise(name, raw);
    if (name in INHERITED) {
      passOn[name] = value;
      if (inherited[name] === value) continue; // inherits it already
    }
    if (name === "opacity" && Number(value) === 1) continue;
    if (!ATTRIBUTES.includes(name)) {
      if (NO_OP_DEFAULTS.includes(name)) throw new Error(`${file}: ${name}: ${value} on <${node.tag}> would change the drawing`);
      throw new Error(`${file}: attribute ${name} on <${node.tag}> is not allowed`);
    }
    attrs[name] = value;
  }
  const children = node.children.filter((c) => !SKIPPED_TAGS.includes(c.tag)).map((c) => convert(c, passOn, file));
  const ordered = Object.fromEntries(ATTRIBUTES.filter((a) => a in attrs).map((a) => [a, attrs[a]]));
  return children.length ? [node.tag, ordered, children] : [node.tag, ordered];
}

/** One SVG file's text as a piece tree; throws on anything outside the allowlist. */
export function pieceTree(text, file = "piece.svg") {
  return convert(parseXml(text, file), INHERITED, file);
}

const PIECES = ["k", "q", "r", "b", "n", "p"];

/** The text of src/generated/pieces.ts for the sets on disk. */
export function generate() {
  const lines = [
    "// Generated by scripts/pieces.mjs (npm run gen:pieces) from assets/pieces. Do not edit by hand.",
    "// Each piece is [tag, attributes, children?], built by src/pieces.ts with createElementNS.",
    "export type PieceTag = \"svg\" | \"g\" | \"path\" | \"circle\";",
    "export type PieceTree = [PieceTag, Record<string, string>, PieceTree[]?];",
    "",
  ];
  for (const [name, dir] of Object.entries(SETS)) {
    lines.push(`/** The "${name}" set, keyed by colour and piece ("wq"). License: ${dir}/LICENSE. */`);
    lines.push(`export const ${name.toUpperCase()}: Record<string, PieceTree> = {`);
    for (const colour of ["w", "b"]) {
      for (const piece of PIECES) {
        const file = join(dir, `Chess_${piece}${colour === "w" ? "l" : "d"}t45.svg`);
        const tree = pieceTree(readFileSync(join(root, file), "utf8"), file);
        lines.push(`  ${colour}${piece}: ${JSON.stringify(tree)},`);
      }
    }
    lines.push("};");
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const text = generate();
  const out = join(root, OUT);
  if (process.argv.includes("--check")) {
    if (readFileSync(out, "utf8") !== text) {
      console.error(`${OUT} is out of date: run npm run gen:pieces`);
      process.exit(1);
    }
  } else {
    writeFileSync(out, text);
    console.log(`wrote ${OUT} (${Buffer.byteLength(text)} bytes)`);
  }
}
