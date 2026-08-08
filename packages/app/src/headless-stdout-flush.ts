// stdout writes to a pipe are async; wait for the callback before allowing process exit.
export async function writeStdoutAndFlush(text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write(text, () => resolve());
  });
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
