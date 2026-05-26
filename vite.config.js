// VelarFlow — vite.config.js
// ────────────────────────────────────────────────────────────────────────────
// MUST-3: Build-time flag __VELARFLOW_DEMO__ wycina dane DEMO z bundla
// produkcyjnego. W dev mode dane demo są dostępne; w prod — Terser je wycina.
//
// Sprawdź działanie:
//   npm run build && grep "Demo#2026" dist/assets/*.js
//   → powinno NIC nie zwrócić (bundle czysty)
// ────────────────────────────────────────────────────────────────────────────

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],

  // MUST-3: __VELARFLOW_DEMO__ jest podstawiany jako literał w czasie buildu.
  // W dev/preview = true, w production = false.
  // Terser/esbuild wytną wtedy cały blok `__DEMO_BUILD__ ? [...] : []` jako dead code.
  define: {
    __VELARFLOW_DEMO__: JSON.stringify(mode !== "production"),
  },

  build: {
    target: "es2020",
    minify: "esbuild",      // szybkie + dobre DCE; alternatywa: "terser"
    sourcemap: false,        // produkcja: bez sourcemap (mniej miejsca dla atakującego)
    rollupOptions: {
      output: {
        // Optional: rozdzielenie na chunki gdyby plik bardzo urósł
        manualChunks: undefined,
      },
    },
  },

  server: {
    port: 5173,
    host: true,              // dostępny w sieci lokalnej (testy mobile)
  },

  preview: {
    port: 4173,
    host: true,
  },
}));
