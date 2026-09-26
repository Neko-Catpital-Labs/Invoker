import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function localVitestBin() {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve("vitest/package.json");
    const pkg = require(pkgJsonPath);
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vitest;
    return binRel ? join(dirname(pkgJsonPath), binRel) : null;
  } catch {
    return null;
  }
}

export function resolveVitestCommand() {
  const bin = localVitestBin();
  if (bin) {
    return { command: process.execPath, args: [bin], usesShell: false };
  }
  return { command: "vitest", args: [], usesShell: process.platform === "win32" };
}

function main() {
  const forwardedArgs = process.argv.slice(2);
  const vitestArgs = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;
  const { command, args, usesShell } = resolveVitestCommand();

  const child = spawn(command, [...args, "run", ...vitestArgs], {
    stdio: "inherit",
    shell: usesShell,
  });

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
