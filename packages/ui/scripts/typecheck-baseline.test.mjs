import { describe, expect, it } from "vitest";
import {
  evaluateTypecheck,
  parseBaseline,
  parseTypecheckOutput,
} from "./typecheck-baseline.mjs";

const packageDir = "/repo/packages/ui";
const repoDir = "/repo";

function evaluate({ launchError = null, status = 0, output = "", baselineText = "" }) {
  const { counts, projectErrors } = parseTypecheckOutput(output, { packageDir, repoDir });
  return evaluateTypecheck({
    launchError,
    status,
    counts,
    projectErrors,
    baseline: parseBaseline(baselineText),
  });
}

describe("typecheck baseline gate", () => {
  it("fails when tsc cannot be launched", () => {
    const result = evaluate({ launchError: "spawn tsc ENOENT", status: null });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain("failed to run tsc");
  });

  it("fails on a project-level error that carries no source location", () => {
    const result = evaluate({
      status: 1,
      output: "error TS18003: No inputs were found in config file 'tsconfig.json'.\n",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("TS18003");
  });

  it("fails when tsc exits non-zero with no parseable diagnostics", () => {
    const result = evaluate({ status: 127, output: "sh: 1: tsc: not found\n" });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("no parseable diagnostics");
  });

  it("passes when every source diagnostic is at or under baseline", () => {
    const result = evaluate({
      status: 1,
      output: "src/App.tsx(1,1): error TS2503: Cannot find namespace.\n",
      baselineText: "packages/ui/src/App.tsx\tTS2503\t1\n",
    });
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it("fails when a source diagnostic exceeds baseline", () => {
    const result = evaluate({
      status: 1,
      output: [
        "src/App.tsx(1,1): error TS2503: Cannot find namespace.",
        "src/App.tsx(2,1): error TS2503: Cannot find namespace.",
        "",
      ].join("\n"),
      baselineText: "packages/ui/src/App.tsx\tTS2503\t1\n",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("unbaselined error packages/ui/src/App.tsx\tTS2503");
  });

  it("passes a clean run", () => {
    expect(evaluate({ status: 0, output: "" })).toEqual({ ok: true, failures: [] });
  });

  it("still reports baseline regressions alongside a project-level error", () => {
    const result = evaluate({
      status: 1,
      output: [
        "error TS5083: Cannot read file 'missing.json'.",
        "src/App.tsx(1,1): error TS2503: Cannot find namespace.",
        "",
      ].join("\n"),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("TS5083");
    expect(result.failures.join("\n")).toContain("unbaselined error");
  });
});
