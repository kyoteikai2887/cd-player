import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**", "**/.native-runtime/**", "**/.cache/**", "**/.local-data/**"],
    },
  },
  build: {
    rollupOptions: {
      input: {
        player: "index.html",
        desktop: "desktop.html",
        preview: "preview/index.html",
      },
    },
  },
});
