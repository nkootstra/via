import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { stylexPlugin } from "@via/ui/stylex-plugin";
import { themePlugin } from "@via/ui/theme-plugin";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viaVersion } from "./via-version.ts";

// The admin UI: a static SPA that via serves at /ui. In dev, /admin goes to a
// running via, `VIA_DEV_ADMIN_URL` or the default port. The proxy keeps the
// browser's Host header, so the Origin via sees matches it and its CSRF check
// passes for cookie-signed changes.
export default defineConfig({
  base: "/ui/",
  define: viaVersion,
  plugins: [
    stylexPlugin(),
    themePlugin(),
    tanstackStart({ spa: { enabled: true }, router: { basepath: "/ui" } }),
    viteReact(),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/admin": { target: process.env["VIA_DEV_ADMIN_URL"] ?? "http://127.0.0.1:8317" } },
  },
  // Start prerenders the shell through a preview server it then fetches from.
  // On "localhost" that server and the fetch can each pick a different address,
  // as in a Docker build, and the fetch is refused; one address suits both.
  preview: { host: "127.0.0.1" },
});
