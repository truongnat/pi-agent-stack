import { homedir } from "node:os";
import { resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  plugins: [vue()],
  build: {
    outDir: resolve(
      homedir(),
      ".agents/outputs/pi-agent-stack/artifacts/dashboard",
    ),
    emptyOutDir: true,
  },
});
