import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

// The gateway serves dist/ in production and runs this config as middleware under `dev` (TRINITY_WEB=dev).
export default defineConfig({
  plugins: [solid()],
  // The SDK is Flower's own checkout, linked from outside this directory.
  server: { fs: { allow: ["../../.."] } },
  // KaTeX, highlight.js and Mermaid load with the first message that needs them; the largest chunk
  // is Mermaid's ELK layout engine, for the diagrams that ask for it.
  build: { target: "es2023", outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
