import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  publicDir: false,
  server: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    emptyOutDir: true,
  },
});
