import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveVitestCommand } from "../../scripts/run-vitest.mjs";

describe("run-vitest resolveVitestCommand", () => {
  it("resolves the local vitest bin via node rather than a bare PATH lookup", () => {
    const { command, args, usesShell } = resolveVitestCommand();

    expect(command).toBe(process.execPath);
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/vitest\.mjs$/);
    expect(existsSync(args[0])).toBe(true);
    expect(usesShell).toBe(false);
  });
});
