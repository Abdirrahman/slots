import { defineConfig } from "vite";

export default defineConfig({
  // Three.js and its addons must resolve to one instance, or materials silently mismatch.
  resolve: { dedupe: ["three"] },
  server: {
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:3000",
        ws: true,
      },
    },
  },
});
