import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The Chrome extension: the side panel is the PersonalOS web app, plus the service worker.
// `npm run extension:build` writes a loadable folder to extension/dist (chrome://extensions → Load unpacked).
export default defineConfig({
  root: "extension",
  base: "./",
  publicDir: "public",
  plugins: [react()],
  // One React for the app and the extension code, whichever folder imports it.
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome116",
    rollupOptions: {
      input: { sidepanel: resolve("extension/sidepanel.html"), background: resolve("extension/src/background.ts") },
      output: { entryFileNames: (chunk) => (chunk.name === "background" ? "assets/background.js" : "assets/[name]-[hash].js") },
    },
  },
});
