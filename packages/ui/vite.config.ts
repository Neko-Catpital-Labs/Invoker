import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // relative paths for Electron
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Reduce memory usage in constrained environments (SSH worktrees)
    sourcemap: false, // Disable source maps to save memory
    minify: 'esbuild', // esbuild is faster and uses less memory than terser
    // elkjs ships as a single GWT-compiled monolith (`elk.bundled.js`,
    // ~1.4 MB minified) that cannot be tree-shaken or split further. It is
    // already isolated to its own lazily-imported async chunk; every other
    // chunk is well under 500 kB. Raise the warning ceiling just enough to
    // accommodate the elk chunk without masking real regressions elsewhere.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Dependency-aware chunking — assigns each node_modules import to a
        // named vendor group based on the source path. Returning `undefined`
        // for application code lets Rollup keep its default entry/dynamic-chunk
        // routing, which is what allows the lazy elkjs import in
        // `lib/layout.ts` to land in its own async chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // elkjs is loaded lazily via dynamic import in lib/layout.ts.
          // Returning `undefined` here lets Rollup keep it in its own async
          // chunk rather than pulling it into the synchronous vendor chunk.
          if (id.includes('/elkjs/')) return undefined;
          if (id.includes('/@xyflow/') || /\/d3-[a-z]+\//.test(id)) return 'xyflow';
          if (/\/xterm(?:-addon-[a-z]+)?\//.test(id)) return 'xterm';
          if (/\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          if (id.includes('/js-yaml/')) return 'yaml';
          return 'vendor';
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
