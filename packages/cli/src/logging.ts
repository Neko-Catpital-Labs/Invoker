export function formatCaughtException(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

export function logCaughtException(context: string, err: unknown): void {
  process.stderr.write(`[invoker-cli] ${context}: ${formatCaughtException(err)}\n`);
}
