import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function packageNameFromModuleId(id: string): string | undefined {
  const normalizedId = id.replaceAll('\\', '/');
  const nodeModulesPath = '/node_modules/';
  const nodeModulesIndex = normalizedId.lastIndexOf(nodeModulesPath);

  if (nodeModulesIndex === -1) return undefined;

  let packagePath = normalizedId.slice(nodeModulesIndex + nodeModulesPath.length);

  if (packagePath.startsWith('.pnpm/')) {
    const nestedNodeModulesIndex = packagePath.indexOf(nodeModulesPath);
    if (nestedNodeModulesIndex === -1) return undefined;
    packagePath = packagePath.slice(nestedNodeModulesIndex + nodeModulesPath.length);
  }

  const [firstPart, secondPart] = packagePath.split('/');
  if (!firstPart) return undefined;
  return firstPart.startsWith('@') && secondPart ? `${firstPart}/${secondPart}` : firstPart;
}

function manualChunks(id: string): string | undefined {
  const packageName = packageNameFromModuleId(id);

  if (!packageName) return undefined;

  if (packageName === 'react' || packageName === 'react-dom' || packageName === 'scheduler') {
    return 'vendor-react';
  }

  if (packageName === '@xyflow/react' || packageName === '@xyflow/system' || packageName.startsWith('d3-')) {
    return 'vendor-xyflow';
  }

  if (packageName === 'xterm' || packageName === 'xterm-addon-fit') {
    return 'vendor-xterm';
  }

  if (packageName === 'elkjs') {
    return 'vendor-elk';
  }

  if (packageName === 'js-yaml') {
    return 'vendor-yaml';
  }

  return 'vendor';
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
        // Assign chunks from resolved module ids so Rollup only emits chunks for
        // dependencies that are actually present in the production graph.
        manualChunks,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
