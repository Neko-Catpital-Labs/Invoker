import type {
  EmbeddedTerminalBackendConfig,
  InvokerConfig,
} from './config.js';
import { resolveEmbeddedTerminalBackendConfig } from './config.js';
import {
  createBashTerminalBackend,
  createPtyTerminalBackend,
  type EmbeddedTerminalBackend,
} from './embedded-terminal-manager.js';

export function createEmbeddedTerminalBackendFromConfig(
  backend: EmbeddedTerminalBackendConfig,
): EmbeddedTerminalBackend {
  if (process.env.INVOKER_E2E_BREAK_TERMINAL_SPAWN === '1') {
    return {
      name: 'pty',
      spawn() {
        throw new Error(
          'posix_spawnp failed. (injected by INVOKER_E2E_BREAK_TERMINAL_SPAWN)',
        );
      },
    };
  }
  if (backend === 'bash') return createBashTerminalBackend();
  return createPtyTerminalBackend();
}

export function createEmbeddedTerminalBackend(
  config: InvokerConfig,
): EmbeddedTerminalBackend {
  return createEmbeddedTerminalBackendFromConfig(
    resolveEmbeddedTerminalBackendConfig(config),
  );
}
