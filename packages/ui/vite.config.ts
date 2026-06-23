import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Match a node_modules path segment for a given package name (handles both
// flat `node_modules/<pkg>` and pnpm's `node_modules/.pnpm/<pkg>@.../node_modules/<pkg>`).
function isFromPackage(id: string, pkg: string): boolean {
  return id.includes(`/node_modules/${pkg}/`);
}

const require = createRequire(import.meta.url);

function loadReporters() {
  const reporters = ['default'];

  try {
    const { default: MergifyReporter } = require(`${process.cwd()}/node_modules/@mergifyio/vitest`);
    reporters.push(new MergifyReporter());
  } catch {
    // Keep local package test runs working when the reporter is not visible
    // from this package's own node_modules resolution context.
  }

  return reporters;
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
    rollupOptions: {
      output: {
        // Dependency-aware vendor splitting: bin each node_modules file into
        // a named chunk based on its resolved path. This avoids the empty
        // chunks the previous bare-name map produced (Rollup never matched
        // `react` because consumers import `react/jsx-runtime` and friends,
        // not the bare package entry), and keeps elkjs — the bundled layout
        // algorithm — isolated from the rest of the app code.
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined;
          if (isFromPackage(id, 'elkjs')) return 'elkjs';
          if (
            isFromPackage(id, 'react') ||
            isFromPackage(id, 'react-dom') ||
            isFromPackage(id, 'scheduler')
          ) {
            return 'react';
          }
          if (isFromPackage(id, '@xyflow/react')) return 'xyflow';
          if (isFromPackage(id, 'xterm') || isFromPackage(id, 'xterm-addon-fit')) {
            return 'xterm';
          }
          return 'vendor';
        },
      },
    },
    // elkjs ships its layered layout algorithm as a single ~1.5 MB bundled
    // module that has no internal module boundaries to split further. The
    // only alternative shape is `elkjs/lib/elk-worker.min.js`, which has to
    // be loaded as a Web Worker — and the packaged app boots from a
    // `file://` origin via `mainWindow.loadFile(...)` in packages/app/src/main.ts,
    // where Worker construction is brittle (same-origin and module-worker
    // support diverge across Chromium versions on file://).
    //
    // After hoisting elkjs into its own chunk via manualChunks above, the
    // elkjs chunk itself is the only offender. Its minified size is ~1.42 MB,
    // so the ceiling is set just above that to cover it deliberately while
    // still catching regressions on any other vendor chunk (next-largest is
    // xterm at ~285 kB).
    chunkSizeWarningLimit: 1500,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    reporters: loadReporters(),
  },
});
