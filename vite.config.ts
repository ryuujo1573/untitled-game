import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import solidPlugin from "vite-plugin-solid";

const host = process.env.TAURI_DEV_HOST;
const isTauri =
  !!(process.env.TAURI_ENV_PLATFORM ||
  process.env.TAURI_ENV_DEBUG ||
  process.env.TAURI_ENV_ARCH ||
  process.env.TAURI_ENV_FAMILY);

export default defineConfig({
  clearScreen: false,
  plugins: [
    {
      name: 'tauri-meta',
      resolveImportMeta(property) {
        if (property === 'isTauri') {
          console.log("# isTauri:", isTauri);
          return JSON.stringify(isTauri);
        }
        return null;
      }
    },
    solidPlugin(),
    tailwindcss(),
  ],
  server: {
    port: 2556,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
