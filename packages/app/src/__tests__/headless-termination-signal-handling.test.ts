import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const mainTsSource = readFileSync(resolve(__dirname, '../main.ts'), 'utf8');

function extractFunctionBody(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  let depth = 0;
  let i = source.indexOf('{', start);
  const bodyStart = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces after marker: ${startMarker}`);
}

describe('headless owner-serve SIGTERM/SIGINT handling', () => {
  it('registers explicit SIGTERM and SIGINT handlers, gated to the owner-serve process only', () => {
    const registrationBlock = extractFunctionBody(mainTsSource, 'if (ownsHeadlessShutdown) {\n      const handleHeadlessTerminationSignal');
    expect(registrationBlock).toContain("process.on('SIGTERM', handleHeadlessTerminationSignal)");
    expect(registrationBlock).toContain("process.on('SIGINT', handleHeadlessTerminationSignal)");
  });

  it('runs the shared shutdown cleanup and exits with a signal-appropriate code instead of relying on the default OS disposition', () => {
    const handlerBody = extractFunctionBody(mainTsSource, 'const handleHeadlessTerminationSignal = (signal: NodeJS.Signals): void =>');
    expect(handlerBody).toContain('runHeadlessShutdownCleanup(`Received ${signal}`)');
    expect(handlerBody).toContain("process.exit(signal === 'SIGINT' ? 130 : 143)");
    // Guards against double-invocation if a second signal arrives mid-shutdown.
    expect(handlerBody).toContain('if (headlessSignalShutdownInProgress) return;');
  });

  it('gives the signal-triggered shutdown a distinct reason from the existing graceful quit path', () => {
    const cleanupFnBody = extractFunctionBody(mainTsSource, 'const runHeadlessShutdownCleanup = async (forcedStopReason: string): Promise<void> =>');
    // The extracted cleanup function must use the caller-supplied reason
    // everywhere a task or diagnostic reason is recorded -- not a
    // hardcoded literal -- so the two call sites can stay distinguishable.
    expect(cleanupFnBody).not.toContain("'Application quit'");
    expect(cleanupFnBody).toContain('persistShutdownDiagnostic(task, persistence, { forcedStopReason });');
    expect(cleanupFnBody).toContain('outputs: { exitCode: 1, error: forcedStopReason }');

    // The existing graceful-exit path (headless CLI process finishing its
    // own work) is unchanged: it still reports the literal 'Application quit'.
    const finallyBlock = mainTsSource.slice(
      mainTsSource.indexOf("await runHeadless(cliArgs, headlessDeps);"),
      mainTsSource.indexOf('process.exit(exitCode);'),
    );
    expect(finallyBlock).toContain("await runHeadlessShutdownCleanup('Application quit');");
  });

  it('skips the normal-quit cleanup and exit when a signal handler already owns shutdown', () => {
    const finallyBlock = mainTsSource.slice(
      mainTsSource.indexOf('await runHeadless(cliArgs, headlessDeps);'),
      mainTsSource.indexOf('process.exit(exitCode);'),
    );
    expect(finallyBlock).toContain('if (!headlessSignalShutdownInProgress) {');
    expect(finallyBlock).toContain("headlessSignalShutdownInProgress = true;\n        await runHeadlessShutdownCleanup('Application quit');");
  });
});
