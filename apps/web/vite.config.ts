import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@zenbar/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url))
    }
  },
  plugins: [react()],
  server: {
    // Vite's DNS-rebinding protection rejects any Host header it doesn't
    // recognize -- fine for the Tailscale IP (that's just the bind
    // address), but the MagicDNS hostname used to reach this dev server
    // over HTTPS via `tailscale serve` is a real Host header value that
    // needs explicit allow-listing, or every request 403s before it ever
    // reaches the app.
    allowedHosts: ["mac-studio.mandrill-frog.ts.net"]
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test-setup.ts"
  }
});
