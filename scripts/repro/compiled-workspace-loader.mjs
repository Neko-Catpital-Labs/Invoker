import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolvePath(__dirname, '../..');

const redirects = new Map([
  ['@invoker/workflow-graph', join(root, 'packages/workflow-graph/dist/index.js')],
  ['@invoker/contracts', join(root, 'packages/contracts/dist/index.js')],
  ['@invoker/workflow-core', join(root, 'packages/workflow-core/dist/index.js')],
]);

export async function resolve(specifier, context, nextResolve) {
  const redirected = redirects.get(specifier);
  if (redirected) {
    return {
      url: pathToFileURL(redirected).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
