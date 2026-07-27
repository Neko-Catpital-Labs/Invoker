import { spawn } from "node:child_process";

const forwardedArgs = process.argv.slice(2);
const vitestArgs = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;

const child = spawn("vitest", ["run", ...vitestArgs], {
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
