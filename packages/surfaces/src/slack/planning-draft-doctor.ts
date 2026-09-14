import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PlanningDraftDoctorResult {
  ok: boolean;
  diagnostics: string[];
  infrastructureError?: boolean;
}

export type PlanningDraftDoctor = (planText: string) => Promise<PlanningDraftDoctorResult>;

interface SkillDoctorCheck {
  stepId?: unknown;
  status?: unknown;
  message?: unknown;
  output?: unknown;
}

interface SkillDoctorReport {
  allPassed?: unknown;
  firstFailedStep?: unknown;
  checks?: unknown;
}

const DEFAULT_DOCTOR_TIMEOUT_MS = 120_000;
const DEFAULT_DOCTOR_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function runSkillDoctor(
  scriptPath: string,
  planPath: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: Error }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath, planPath],
      { timeout: timeoutMs, maxBuffer: DEFAULT_DOCTOR_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        const processError = error instanceof Error ? error : undefined;
        const exitCode = typeof (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code === 'number'
          ? (error as NodeJS.ErrnoException & { code: number }).code
          : error ? null : 0;
        resolve({ stdout, stderr, exitCode, error: processError });
      },
    );
  });
}

function diagnosticLines(report: SkillDoctorReport, stderr: string): string[] {
  const checks = Array.isArray(report.checks) ? report.checks as SkillDoctorCheck[] : [];
  const failed = checks.filter((check) => check.status === 'failed');
  const diagnostics = failed.flatMap((check) => {
    const step = typeof check.stepId === 'string' ? check.stepId : 'doctor';
    const message = typeof check.message === 'string' ? check.message.trim() : '';
    const output = typeof check.output === 'string' ? check.output.trim() : '';
    if (!output) return [`${step}: ${message || 'failed'}`];
    try {
      const parsed = JSON.parse(output) as unknown;
      if (Array.isArray(parsed)) {
        const structured = parsed.flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null) return [];
          const candidate = entry as { message?: unknown };
          return typeof candidate.message === 'string' ? [candidate.message] : [];
        });
        if (structured.length > 0) return [`${step}: ${message || 'failed'}`, ...structured];
      }
    } catch {
      // Non-JSON linter output is already human-readable.
    }
    return [`${step}: ${message || 'failed'}`, ...output.split(/\r?\n/).slice(0, 40)];
  });
  if (diagnostics.length > 0) return diagnostics;
  const stderrLines = stderr.trim().split(/\r?\n/).filter(Boolean);
  return stderrLines.length > 0 ? stderrLines.slice(-8) : ['skill-doctor rejected the candidate without diagnostics'];
}

/** Run the canonical full plan-to-invoker doctor against the exact candidate text. */
export function createPlanningDraftDoctor(
  scriptPath: string,
  options: { timeoutMs?: number } = {},
): PlanningDraftDoctor {
  return async (planText) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'invoker-planning-doctor-'));
    const planPath = join(tempDir, 'candidate.yaml');
    try {
      writeFileSync(planPath, planText, 'utf8');
      const result = await runSkillDoctor(scriptPath, planPath, options.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS);
      let report: SkillDoctorReport;
      try {
        report = JSON.parse(result.stdout) as SkillDoctorReport;
      } catch {
        return {
          ok: false,
          infrastructureError: true,
          diagnostics: [
            `skill-doctor did not return JSON (exit ${result.exitCode ?? 'unknown'})`,
            ...result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-8),
          ],
        };
      }

      if (result.exitCode === 0 && report.allPassed === true) {
        return { ok: true, diagnostics: [] };
      }
      if (report.allPassed === false) {
        return { ok: false, diagnostics: diagnosticLines(report, result.stderr) };
      }
      return {
        ok: false,
        infrastructureError: true,
        diagnostics: [result.error?.message ?? `skill-doctor exited ${result.exitCode ?? 'without an exit code'}`],
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
}
