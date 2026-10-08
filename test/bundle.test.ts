// covers: apps.chess
// The built app: one self-contained HTML file that loads nothing by URL, carries the notices of what it bundles,
// and stays small.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
let out: string;
let page: string;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "mini-chess-"));
  await build({ configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  page = readFileSync(join(out, "index.html"), "utf8");
}, 60_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("the Chess bundle", () => {
  it("is one HTML file with its script and styles inline", () => {
    expect(readdirSync(out)).toEqual(["index.html"]);
    expect(page).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(page).not.toMatch(/<link\b/i);
    expect(page).not.toMatch(/\b(?:src|href|srcset|action|poster)\s*=/i);
    expect(page).not.toMatch(/type="module"/);
    expect(page.match(/<script\b/g)).toHaveLength(1);
    expect(page.match(/<style\b/g)).toHaveLength(1);
    expect(page.match(/<\/head>/g)).toHaveLength(1);
    expect(page.match(/<\/body>/g)).toHaveLength(1);
  });

  it("keeps the license notices of chess.js, @noble/hashes and the cburnett pieces", () => {
    const notice = page.slice(page.indexOf("/*!"), page.indexOf("*/", page.indexOf("/*!")) + 2);
    expect(notice).toContain("chess.js 1.4.0 (BSD-2-Clause)");
    expect(notice).toContain("Copyright (c) 2025, Jeff Hlywa");
    expect(notice).toContain("Redistributions of source code must retain the above copyright notice");
    expect(notice).toContain("@noble/hashes 2.4.0 (MIT)");
    expect(notice).toContain("Copyright (c) 2022 Paul Miller");
    // The pieces: BSD-3-Clause, with its copyright line and all three clauses.
    expect(notice).toContain('Chess pieces "cburnett" (BSD-3-Clause)');
    expect(notice).toContain("Copyright (c) The author, Cburnett");
    expect(notice).toContain("1. Redistributions of source code must retain the above copyright notice");
    expect(notice).toContain("2. Redistributions in binary form must reproduce the above copyright notice");
    expect(notice).toContain("3. Neither the name of The author nor the names of its contributors may be used");
    // A legal text kept in the repository beside vendored data (the CC0 deed of the openings) is not shipped.
    expect(notice).not.toMatch(/CC0|Creative Commons|Statement of Purpose/);
  });

  it("names no address and no way to reach the network", () => {
    const start = page.indexOf("/*!");
    const code = page.slice(0, start) + page.slice(page.indexOf("*/", start) + 2);
    // The one URI in the code is the SVG namespace, which createElementNS takes to make the pieces: a name for the
    // element type, never fetched. It may stand exactly once, and nothing else of its kind.
    const SVG_NS = "http://www.w3.org/2000/svg";
    expect(code.split(SVG_NS)).toHaveLength(2);
    expect(code.replace(SVG_NS, "")).not.toMatch(/\b(?:https?|wss?):\/\//i);
    expect(code).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|RTCPeerConnection)\b/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  // The web runner locks the page with a nonce once the entry is written (WISP 1200, "The runner and the broker"):
  // markup handlers and scripts made later never run there.
  it("runs under the runner's lock: no inline event handler, no script made after start", () => {
    expect(page).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/createElement\(\s*["'`]script["'`]/);
    expect(page).not.toMatch(/\b(?:insertAdjacentHTML|outerHTML|document\.write)\b|setAttribute\(\s*["'`]on/);
  });

  it("stays within its budget", () => {
    const notice = page.slice(page.indexOf("/*!"), page.indexOf("*/", page.indexOf("/*!")) + 2);
    expect(Buffer.byteLength(notice), "notice block").toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(readFileSync(join(root, "src/generated/pieces.ts"))), "pieces").toBeLessThanOrEqual(12 * 1024);
    const strings = ["src/strings.ts", "src/languages.ts"].reduce((n, f) => n + Buffer.byteLength(readFileSync(join(root, f))), 0);
    // Pinned near their size (about 27 KB and 122 KiB in 1.1.0): growing them is a choice made here, not by accident.
    expect(strings, "string tables").toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.byteLength(page), "page").toBeLessThanOrEqual(136 * 1024);
  });

  it("parses no markup at run time: the pieces are built with createElementNS", () => {
    expect(page).not.toMatch(/\binnerHTML\b|<template|data:image/);
    expect(page.match(/<svg\b/g) ?? []).toHaveLength(0);
  });
});
