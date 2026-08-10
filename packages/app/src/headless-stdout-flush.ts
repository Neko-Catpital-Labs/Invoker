// stdout writes to a pipe are async; wait for the callback before allowing process exit.
export async function writeStdoutAndFlush(text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

/**
 * Wait for any writes already queued on stdout/stderr to actually drain
 * before the caller exits. Node's streams preserve write order, so an
 * empty-string write's callback only fires after every write queued ahead
 * of it has flushed -- this is a barrier, not a new write. Any output piped
 * into another process truncates silently at the OS pipe buffer size if
 * process.exit() runs before earlier writes finish flushing.
 */
export async function flushStdoutAndStderr(): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write('', () => resolve())),
    new Promise<void>((resolve) => process.stderr.write('', () => resolve())),
  ]);
}

export async function writeStdoutFlushAndExit(
  text: string,
  exit: (code: number | string) => void = (code) => process.exit(code),
): Promise<void> {
  await writeStdoutAndFlush(text);
  // Electron's main process never exits on event-loop drain, so after the
  // stdout flush resolves the client must force exit like main.ts's delegated
  // mutation path.
  exit(process.exitCode ?? 0);
}
