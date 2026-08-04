/**
 * A pending `process.stdout`/`process.stderr` write to a pipe is asynchronous
 * in Node; `process.exit()` does not wait for it to drain. Await this before
 * exiting after writing output that a parent process captures (e.g. via
 * `execSync`), or large payloads silently truncate at the OS pipe buffer size.
 */
export async function flushOutputStream(stream: NodeJS.WriteStream): Promise<void> {
  await new Promise<void>((resolve) => {
    stream.write('', () => resolve());
  });
}
