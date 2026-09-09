import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Plugin order matters: the Cloudflare plugin must come first so the SSR
// environment is the workerd runtime rather than Node.
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart({
      // Route the bundled server entry through src/server.ts (our SSR error wrapper).
      server: { entry: "server" },
    }),
    react(),
  ],
  resolve: {
    // Vite 8 resolves the "@/*" alias from tsconfig itself, so the
    // vite-tsconfig-paths plugin is no longer needed.
    tsconfigPaths: true,
    // Keep a single copy of React and the router in the graph; two copies break hooks.
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-store"],
  },
});
