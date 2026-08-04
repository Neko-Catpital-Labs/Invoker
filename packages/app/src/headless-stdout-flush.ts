// stdout writes to a pipe are async; wait for the callback before allowing process exit.
export async function writeStdoutAndFlush(text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}
