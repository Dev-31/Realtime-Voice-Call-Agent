import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5175,
    proxy: {
      "/api": "http://127.0.0.1:4176",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
