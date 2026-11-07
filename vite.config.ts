import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Tauri-friendly setup: fixed port, errors are not hidden by a cleared screen.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  resolve: {
    // Mermaid's ELK layout engine (elkjs: EPL-2.0 or GPL-3.0, 1.5 MB) is left out:
    // diagrams use the dagre layout (MIT). See src/vendor/elk-stub.ts.
    alias: [{ find: /^elkjs\/lib\/elk\.bundled\.js$/, replacement: fileURLToPath(new URL("./src/vendor/elk-stub.ts", import.meta.url)) }],
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    target: "es2022",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 1200,
  },
});
