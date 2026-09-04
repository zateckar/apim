import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin from the browser's point of view, so the session cookie and the Origin check
    // behave exactly as they do against the built bundle.
    // `/auth` is here as well as `/api` `[P2-04]`: `/auth/login` and `/auth/callback` are top-level
    // browser navigations that answer 302, not fetches. Without the entry Vite serves the SPA for
    // them with a 200 and the sign-in button appears to do nothing at all.
    proxy: { "/api": "http://localhost:8080", "/auth": "http://localhost:8080" },
    // `src/lib/*` imports the wire vocabulary from `shared/` — the attention codes, the release
    // states — rather than restating it here, which means the dev server has to be able to read
    // one directory above the project root.
    fs: { allow: [".."] },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
