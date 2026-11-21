import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

declare const process: { env: Record<string, string | undefined> };
// GAME_PROXY (dev only): forward /game/* to the real game's dev server so both run on one origin.
const gameProxy = process.env.GAME_PROXY;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: gameProxy ? { '/game': { target: gameProxy, ws: true } } : undefined,
  },
});
