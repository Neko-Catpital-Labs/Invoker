import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Pattern → chunk name. Each pattern matches a node_modules path that should
// be hoisted into its own dependency-aware vendor chunk. The patterns must
// only fire when the matched module is actually pulled into the graph,
// otherwise Rollup emits an empty-chunk warning.
const VENDOR_CHUNK_PATTERNS: Array<readonly [RegExp, string]> = [
  [/[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]*[\\/]node_modules[\\/])?elkjs[\\/]/, 'vendor-elkjs'],
  [/[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]*[\\/]node_modules[\\/])?@xyflow[\\/]/, 'vendor-xyflow'],
  [/[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]*[\\/]node_modules[\\/])?(?:react|react-dom|scheduler)[\\/]/, 'vendor-react'],
];

export default defineConfig({
  plugins: [react()],
  base: './', // relative paths for Electron
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Reduce memory usage in constrained environments (SSH worktrees)
    sourcemap: false, // Disable source maps to save memory
    minify: 'esbuild', // esbuild is faster and uses less memory than terser
    // elkjs/lib/elk.bundled.js is a single ~1.5 MB Java→JS compiled artifact
    // with no smaller distribution; once isolated to its own async chunk it
    // is the only chunk that legitimately exceeds Rollup's 500 KB ceiling.
    chunkSizeWarningLimit: 1700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          for (const [pattern, name] of VENDOR_CHUNK_PATTERNS) {
            if (pattern.test(id)) return name;
          }
          return undefined;
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
