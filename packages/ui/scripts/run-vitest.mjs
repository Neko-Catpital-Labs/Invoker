import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));

const forwardedArgs = process.argv.slice(2);
const vitestArgs = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;

function findRepoRoot(startDir) {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, "pnpm-lock.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveVitestBin() {
  try {
    const packageJsonPath = require.resolve("vitest/package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const binPath = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.vitest;
    return join(dirname(packageJsonPath), binPath ?? "vitest.mjs");
  } catch {
    return null;
  }
}

function ensureVitestInstalled() {
  if (resolveVitestBin()) return;

  const repoRoot = findRepoRoot(scriptDir);
  if (!repoRoot) return;

  console.error("[run-vitest] Vitest is not installed; running pnpm install --frozen-lockfile...");
  const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (install.error) {
    console.error(install.error);
    process.exit(1);
  }

  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
}

ensureVitestInstalled();

const vitestBin = resolveVitestBin();
const command = vitestBin ? process.execPath : "vitest";
const args = vitestBin ? [vitestBin, "run", ...vitestArgs] : ["run", ...vitestArgs];
const child = spawn(command, args, {
  stdio: "inherit",
  shell: !vitestBin && process.platform === "win32",
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
