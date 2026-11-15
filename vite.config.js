import { defineConfig } from 'vite';

// Relative paths, because GitHub Pages serves this from a subfolder
// (/apple-skp-viewer/) rather than the root of the domain.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2020', chunkSizeWarningLimit: 4000 },
});
