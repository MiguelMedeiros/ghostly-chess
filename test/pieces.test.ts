// @vitest-environment happy-dom
// covers: apps.chess
// The pieces: generated data, not markup, from the vendored SVGs, with only allowlisted tags and attributes, built
// with createElementNS (no innerHTML anywhere in src/).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate, OUT, pieceTree } from "../scripts/pieces.mjs";
import { CBURNETT, type PieceTree } from "../src/generated/pieces.ts";
import { glyph, pieceSvg } from "../src/pieces.ts";

const root = join(import.meta.dirname, "..");
// The allowlist, written out here rather than read from the generator: widening the generator's must fail this test.
const ALLOWED_TAGS = ["svg", "g", "path", "circle"];
const ALLOWED_ATTRIBUTES = [
  "viewBox", "d", "fill", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "opacity", "transform", "cx", "cy", "r",
];
const generated = readFileSync(join(root, OUT), "utf8");

function walk(tree: PieceTree, visit: (tag: string, attributes: Record<string, string>) => void): void {
  visit(tree[0], tree[1]);
  for (const child of tree[2] ?? []) walk(child, visit);
}

describe("the generated pieces", () => {
  it("are what scripts/pieces.mjs makes from the vendored SVGs (npm run gen:pieces)", () => {
    expect(generated).toBe(generate());
  });

  it("are 12, with only allowlisted tags and attributes", () => {
    expect(Object.keys(CBURNETT).sort()).toEqual(["bb", "bk", "bn", "bp", "bq", "br", "wb", "wk", "wn", "wp", "wq", "wr"]);
    for (const [key, tree] of Object.entries(CBURNETT)) {
      expect(tree[0], key).toBe("svg");
      expect(tree[1].viewBox, key).toBe("0 0 45 45");
      walk(tree, (tag, attributes) => {
        expect(ALLOWED_TAGS, key).toContain(tag);
        for (const name of Object.keys(attributes)) expect(ALLOWED_ATTRIBUTES, `${key} ${tag}`).toContain(name);
      });
    }
  });

  it("carry no namespace, address, link, style sheet or handler", () => {
    for (const bad of ["xmlns", "://", "href", "<style", "<script"]) expect(generated).not.toContain(bad);
    expect(generated).not.toMatch(/"on[a-z]+"\s*:/i);
  });

  it("leave src/ without innerHTML, insertAdjacentHTML or <template>", () => {
    const files: string[] = [];
    const list = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) list(path);
        else files.push(path);
      }
    };
    list(join(root, "src"));
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/innerHTML|insertAdjacentHTML|<template/);
  });
});

describe("the generator", () => {
  const svg = (inner: string, root = 'xmlns="http://www.w3.org/2000/svg" width="45" height="45"') =>
    `<?xml version="1.0"?>\n<!DOCTYPE svg>\n<svg ${root}>${inner}</svg>`;

  it("turns style into attributes, drops what draws nothing, and sizes the viewBox", () => {
    expect(pieceTree(svg('<title>x</title><!-- c --><g id="a" style="fill:#ffffff; stroke-opacity:1; opacity:1"><circle cx="1" cy="2" r="3" style="fill:#fff"/></g>'))).toEqual([
      "svg",
      { viewBox: "0 0 45 45" },
      [["g", { fill: "#fff" }, [["circle", { cx: "1", cy: "2", r: "3" }]]]],
    ]);
    expect(pieceTree(svg('<path d="M 1,2 L 3,4 z" fill="none" style="fill:#000000"/>'))).toEqual(["svg", { viewBox: "0 0 45 45" }, [["path", { d: "M1 2L3 4z" }]]]);
  });

  it("fails on another tag, a handler, a link, or a declaration that would change the drawing", () => {
    expect(() => pieceTree(svg('<rect width="1" height="1"/>'))).toThrow(/<rect> is not allowed/);
    expect(() => pieceTree(svg('<path d="M0 0" onclick="x()"/>'))).toThrow(/onclick/);
    expect(() => pieceTree(svg('<path d="M0 0" xlink:href="#a" href="#a"/>'))).toThrow(/href/);
    expect(() => pieceTree(svg('<path d="M0 0" style="fill-opacity:0.5"/>'))).toThrow(/fill-opacity/);
    expect(() => pieceTree(svg('<path d="M0 0" filter="url(#f)"/>'))).toThrow(/filter/);
    expect(() => pieceTree(svg("text<path d='M0 0'/>"))).toThrow(/text/);
    expect(() => pieceTree(svg('<image href="x.png"/>'))).toThrow(/<image>/);
  });
});

describe("the pieces in the page", () => {
  it("are built with createElementNS, aria-hidden, a fresh clone each time", () => {
    const a = pieceSvg("wq");
    const b = pieceSvg("wq");
    expect(a).not.toBe(b);
    expect(a.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(a.getAttribute("aria-hidden")).toBe("true");
    expect(a.getAttribute("viewBox")).toBe("0 0 45 45");
    expect(a.querySelectorAll("path").length + a.querySelectorAll("circle").length).toBeGreaterThan(3);
    expect(a.textContent).toBe("");
    expect(() => pieceSvg("xx")).toThrow();
  });

  it("keep 1.0.2's glyphs, with U+FE0E", () => {
    expect(glyph("q")).toBe("♛︎");
    expect(glyph("p")).toBe("♟︎");
  });
});
