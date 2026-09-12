import { readFile, writeFile } from 'node:fs/promises';

export const NODE_BUILTINS_WITHOUT_BARE_ALIAS = ['sea'];

export function patchStrippedNodeBuiltinPrefixes(code) {
  let patched = code;
  for (const builtin of NODE_BUILTINS_WITHOUT_BARE_ALIAS) {
    const bareRequire = new RegExp(`require\\((["'])${builtin}\\1\\)`, 'g');
    patched = patched.replace(bareRequire, `require("node:${builtin}")`);
  }
  return patched;
}

export async function patchStrippedNodeBuiltinPrefixesInFile(bundlePath) {
  const code = await readFile(bundlePath, 'utf8');
  await writeFile(bundlePath, patchStrippedNodeBuiltinPrefixes(code));
}
