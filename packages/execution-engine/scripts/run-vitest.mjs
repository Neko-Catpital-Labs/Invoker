import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const forwardedArgs = process.argv.slice(2);
const vitestArgs = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;

const child = spawn("vitest", ["run", ...vitestArgs], {
  env: {
    ...process.env,
    INVOKER_AUTO_FIX_PAUSE_FILE:
      process.env.INVOKER_AUTO_FIX_PAUSE_FILE
      ?? join(tmpdir(), `invoker-vitest-${process.pid}-auto-fix-pause.json`),
  },
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
