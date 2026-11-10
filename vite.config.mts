import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import electron from 'vite-plugin-electron/simple';

/** The packaged app loads only its own files: no remote scripts, styles, fonts or requests. */
const CSP_PRODUCTION = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** The dev server needs inline scripts and styles plus a WebSocket for hot reload. */
const CSP_DEVELOPMENT = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  let isServe = false;
  return {
    name: 'token-tracker:csp',
    configResolved(config) {
      isServe = config.command === 'serve';
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: isServe ? CSP_DEVELOPMENT : CSP_PRODUCTION,
          },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

// Editors built on Electron (VS Code and others) set this variable for their child processes.
// When it leaks into `npm run dev`, Electron starts as plain Node and the app cannot open.
delete process.env.ELECTRON_RUN_AS_NODE;

export default defineConfig({
  // Relative asset paths, because the packaged app loads index.html from disk.
  base: './',
  clearScreen: false,
  build: {
    // Keep every asset a file: an inlined `data:` font would be blocked by the CSP.
    assetsInlineLimit: 0,
  },
  plugins: [
    react(),
    contentSecurityPolicy(),
    electron({
      main: {
        entry: 'electron/main.ts',
        // Start Electron without the plugin's default `--no-sandbox` flag.
        onstart: ({ startup }) => {
          void startup(['.']);
        },
      },
      preload: {
        input: 'electron/preload.ts',
      },
    }),
  ],
});
