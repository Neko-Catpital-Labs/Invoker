// @invoker/runtime-adapters - Runtime infrastructure adapters

export { WorkspaceProbeAdapter, type WorkspacePersistence } from './workspace-probe.js';
export { ContainerProbeAdapter, type ContainerPersistence } from './container-probe.js';
export { SessionProbeAdapter, type SessionPersistence } from './session-probe.js';
export { TerminalLauncherAdapter } from './terminal-launcher.js';

// Low-level terminal launch utilities (re-exported for shell orchestration if needed)
export {
  shellSingleQuoteForPOSIX,
  buildTerminalShellCommand,
  appleScriptEscapeForDoubleQuotedString,
  buildMacOSOsascriptArgs,
  buildLinuxXTerminalBashScript,
  spawnDetachedTerminal,
  type InteractiveExecShell,
  type OpenTerminalResult,
} from './terminal-launch.js';
