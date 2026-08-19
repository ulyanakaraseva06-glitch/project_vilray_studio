/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const config = {
  plugins: [
    react({
      // App.tsx is large enough that the esbuild-only path can fail silently in dev
      // and produce an empty module (white screen). Always run Babel for TS/TSX.
      babel: {
        plugins: [
          {
            name: 'force-tsx-babel-transform',
            visitor: {},
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app/index.html'),
      },
      output: {
        manualChunks: {
          canvas: ['konva', 'react-konva'],
          icons: ['lucide-react'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
};

export default defineConfig(config);
