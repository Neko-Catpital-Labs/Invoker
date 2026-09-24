import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptDir);

const FILE_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/;
const PROJECT_DIAGNOSTIC = /^error (TS\d+):/;

export function findRepoRoot(startDir) {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, "pnpm-lock.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function parseTypecheckOutput(output, { packageDir, repoDir }) {
  const counts = {};
  const projectErrors = [];

  for (const rawLine of String(output).split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const fileMatch = line.match(FILE_DIAGNOSTIC);
    if (fileMatch) {
      const absolute = resolve(packageDir, fileMatch[1]);
      const relativePath = relative(repoDir, absolute).split(sep).join("/");
      const key = relativePath + "\t" + fileMatch[4];
      counts[key] = (counts[key] || 0) + 1;
      continue;
    }
    if (PROJECT_DIAGNOSTIC.test(line)) projectErrors.push(line);
  }

  return { counts, projectErrors };
}

export function parseBaseline(text) {
  const baseline = {};
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const count = Number.parseInt(parts[2], 10);
    baseline[parts[0] + "\t" + parts[1]] = Number.isNaN(count) ? 0 : count;
  }
  return baseline;
}

export function evaluateTypecheck({ launchError, status, counts, projectErrors, baseline }) {
  const failures = [];

  if (launchError) {
    failures.push("typecheck: failed to run tsc: " + launchError);
    return { ok: false, failures };
  }

  for (const line of projectErrors) {
    failures.push("typecheck: project-level compiler error: " + line);
  }

  const parsedDiagnostics = Object.keys(counts).length;
  if (status !== 0 && parsedDiagnostics === 0 && projectErrors.length === 0) {
    failures.push("typecheck: tsc exited with status " + status + " but produced no parseable diagnostics");
  }

  for (const key of Object.keys(counts).sort()) {
    const base = baseline[key] || 0;
    if (counts[key] > base) {
      failures.push("typecheck: unbaselined error " + key + " (actual " + counts[key] + ", baseline " + base + ")");
    }
  }

  return { ok: failures.length === 0, failures };
}

function resolveTscBin() {
  try {
    const packageJsonPath = require.resolve("typescript/package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const binPath = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.tsc;
    return join(dirname(packageJsonPath), binPath ?? "bin/tsc");
  } catch {
    return null;
  }
}

function main() {
  const repoRoot = findRepoRoot(packageRoot) ?? resolve(packageRoot, "../..");
  const baselinePath = join(packageRoot, "typecheck-baseline.txt");

  const tscBin = resolveTscBin();
  const command = tscBin ? process.execPath : "tsc";
  const args = tscBin
    ? [tscBin, "-p", "tsconfig.json", "--noEmit"]
    : ["-p", "tsconfig.json", "--noEmit"];

  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    shell: !tscBin && process.platform === "win32",
  });

  const output = (result.stdout || "") + (result.stderr || "");
  const { counts, projectErrors } = parseTypecheckOutput(output, {
    packageDir: packageRoot,
    repoDir: repoRoot,
  });
  const baseline = existsSync(baselinePath)
    ? parseBaseline(readFileSync(baselinePath, "utf8"))
    : {};

  const { ok, failures } = evaluateTypecheck({
    launchError: result.error ? result.error.message : null,
    status: result.status,
    counts,
    projectErrors,
    baseline,
  });

  if (!ok) {
    if (result.error || projectErrors.length > 0) process.stderr.write(output);
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }

  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
