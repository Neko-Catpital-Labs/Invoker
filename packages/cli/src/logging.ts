export function formatCaughtException(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function logCaughtException(context: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[invoker-cli] ${context}: ${detail}\n`);
}
