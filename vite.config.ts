import { daintreePlugin } from "@daintreehq/plugin-vite";
import { defineConfig } from "vite";

// The entry runs in Daintree's plugin worker, a Node process: built-ins stay
// imports. `node:sqlite` is prefix-only, so Node 22's `builtinModules` (which
// the preset externalizes) doesn't list it.
export default defineConfig({
  plugins: [daintreePlugin({ target: "node", externals: [/^node:/] })],
  build: {
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: { index: "main/index.ts" },
      formats: ["es"],
      // `.mjs` is ESM wherever it lands: the archive carries no package.json,
      // and a `.js` file is CommonJS under an ancestor that says so.
      fileName: (_format, name) => `${name}.mjs`,
    },
  },
});
