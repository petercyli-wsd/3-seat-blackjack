import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The pipeline writes clips, masks and manifest.json to ../game_assets; serve that as the public dir.
export default defineConfig({
  plugins: [react()],
  publicDir: fileURLToPath(new URL("../game_assets", import.meta.url)),
  server: { port: 5183 },
});
