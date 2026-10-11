import { defineConfig } from "vite";

/**
 * The bot as one file for Node, `bot/dist/main.mjs`: the app's sources are TypeScript that Node does not run as it is
 * (parameter properties), so `npm run bot` builds this first. Nothing of it goes into the app: the app's build is
 * vite.config.ts at the root, from index.html.
 */
export default defineConfig({
  build: {
    ssr: "bot/main.ts",
    outDir: "bot/dist",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: { output: { entryFileNames: "main.mjs" } },
  },
  // One file: chess.js and the hashes go in, so the built bot runs from any folder.
  ssr: { noExternal: true },
});
