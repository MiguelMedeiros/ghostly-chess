// Puts what `ghostly app publish` bundles into one folder: the built dist/index.html and the manifest, with
// `sources` set to where the store serves the bundle. `ghostly app publish` takes every file in the folder it is
// given, so it must never be run on the repository itself.
//
//   npm run build && npm run stage [-- <folder>]    (default: release/)
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCES = ["https://raw.githubusercontent.com/MiguelMedeiros/ghostly-store/HEAD/apps/chess.odcgw6wjw8dynqop/app.ghostlyapp"];

const root = new URL("..", import.meta.url).pathname;
const out = resolve(process.argv[2] ?? resolve(root, "release"));
const manifest = JSON.parse(readFileSync(resolve(root, "ghostly-app.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(resolve(root, "dist/index.html"), resolve(out, "index.html"));
writeFileSync(resolve(out, "ghostly-app.json"), `${JSON.stringify({ ...manifest, sources: SOURCES }, null, 2)}\n`);
console.log(`staged Chess ${manifest.version} in ${out}`);
