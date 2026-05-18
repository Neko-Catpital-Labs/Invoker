import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Production chunking strategy.
//
// We split heavy vendor dependencies into their own chunks so the entry chunk
// stays small and downstream caches stay stable across UI-only changes. The
// previous object-style `manualChunks` matched only bare specifiers, so the
// `react` key produced an empty chunk while `react`/`react-dom` (and the d3
// dependencies of @xyflow) ended up in the main entry chunk.
//
// The function form below matches resolved module paths instead, so each
// vendor lands in the correct chunk regardless of how it is reached in the
// dependency graph.
function vendorChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  // Normalize path separators so the matcher works on Windows too.
  const path = id.replace(/\\/g, '/');

  if (/\/node_modules\/(react|react-dom|scheduler)\//.test(path)) {
    return 'react-vendor';
  }

  // @xyflow/react pulls in @xyflow/system and several d3 packages; keep them
  // together so the graph view loads as a single network request.
  if (/\/node_modules\/@xyflow\//.test(path) || /\/node_modules\/d3-[a-z]+\//.test(path)) {
    return 'xyflow';
  }

  if (/\/node_modules\/(xterm|xterm-addon-fit)\//.test(path)) {
    return 'xterm';
  }

  if (/\/node_modules\/js-yaml\//.test(path)) {
    return 'yaml';
  }

  // elkjs is loaded via dynamic import from src/lib/layout.ts so Rollup
  // already gives it its own chunk; no explicit mapping is needed here.
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  base: './', // relative paths for Electron
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Reduce memory usage in constrained environments (SSH worktrees)
    sourcemap: false, // Disable source maps to save memory
    minify: 'esbuild', // esbuild is faster and uses less memory than terser
    // elkjs ships pre-bundled as a ~1.5 MB UMD module (elk.bundled.js) and is
    // loaded lazily by layoutTaskGraph(). Even after esbuild minification it
    // exceeds Vite's default 500 kB warning ceiling; this limit acknowledges
    // the lazy elkjs chunk as an intentional outlier without hiding a
    // regression in the eagerly loaded entry chunk, which is well below 500 kB.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
