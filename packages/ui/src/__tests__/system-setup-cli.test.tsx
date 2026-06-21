/**
 * Component test: "Invoker CLI" section of the SystemSetupModal.
 *
 * The packaged desktop app installs/updates the bundled invoker-cli binary
 * onto the user's PATH; this section surfaces the installed-vs-app version
 * status and a manual Install/Update action.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SystemDiagnostics, CliInstallerStatus, BundledSkillsStatus } from '@invoker/contracts';

import { SystemSetupModal } from '../components/SystemSetupModal.js';

function makeDiagnostics(cliInstaller: CliInstallerStatus | undefined, bundledSkills?: BundledSkillsStatus): SystemDiagnostics {
  return {
    platform: 'darwin',
    arch: 'arm64',
    appVersion: '0.0.3',
    isPackaged: true,
    tools: [],
    cliInstaller,
    bundledSkills,
  };
}

describe('SystemSetupModal — Invoker CLI section', () => {
  it('shows an outdated install and fires onUpdateInvokerCli from the button', () => {
    const onUpdateInvokerCli = vi.fn();
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics({
          supported: true,
          bundledVersion: '0.0.3',
          installedVersion: '0.0.2',
          installedPath: '/usr/local/bin/invoker-cli',
          upToDate: false,
        })}
        onUpdateInvokerCli={onUpdateInvokerCli}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/Installed 0\.0\.2 at \/usr\/local\/bin\/invoker-cli — app version 0\.0\.3/)).toBeInTheDocument();
    expect(screen.getByText('Update available')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update invoker-cli' }));
    expect(onUpdateInvokerCli).toHaveBeenCalledTimes(1);
  });

  it('offers Install when invoker-cli is missing', () => {
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics({
          supported: true,
          bundledVersion: '0.0.3',
          upToDate: false,
        })}
        onUpdateInvokerCli={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Not installed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install invoker-cli' })).toBeInTheDocument();
  });

  it('hides the button when up to date and shows the PATH warning when present', () => {
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics({
          supported: true,
          bundledVersion: '0.0.3',
          installedVersion: '0.0.3',
          installedPath: '/Users/me/.local/bin/invoker-cli',
          upToDate: true,
          warning: '/Users/me/.local/bin is not on your PATH.',
        })}
        onUpdateInvokerCli={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Up to date')).toBeInTheDocument();
    expect(screen.getByText('/Users/me/.local/bin is not on your PATH.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invoker-cli/ })).not.toBeInTheDocument();
  });


  it('shows installed AI helper command and MCP targets', () => {
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics(undefined, {
          available: true,
          promptRecommended: true,
          managedPrefix: 'invoker-',
          bundledSkillNames: ['plan-to-invoker'],
          targets: [
            { id: 'codex', name: 'Codex', path: '/tmp/.codex/skills', available: true, installed: false, upToDate: false, installedSkillNames: [] },
          ],
          commandTargets: [
            { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/commands', available: true, installed: false, upToDate: false, installedCommandNames: [] },
          ],
          mcpTargets: [
            { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/mcp.json', available: true, installed: false, upToDate: false, serverName: 'invoker' },
          ],
        })}
        onInstallBundledSkills={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Invoker AI helpers')).toBeInTheDocument();
    expect(screen.getByText('/invoker-plan-to-invoker "help me plan <change>"')).toBeInTheDocument();
    expect(screen.getByText('/tmp/.omp/agent/commands')).toBeInTheDocument();
    expect(screen.getByText('/tmp/.omp/agent/mcp.json')).toBeInTheDocument();
  });

  it('updates helpers when only command or MCP config targets are outdated', () => {
    const onInstallBundledSkills = vi.fn();
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics(undefined, {
          available: true,
          promptRecommended: true,
          managedPrefix: 'invoker-',
          bundledSkillNames: ['plan-to-invoker'],
          targets: [],
          commandTargets: [
            { id: 'omp-command', name: 'OMP Commands', path: '/tmp/.omp/agent/commands', available: true, installed: true, upToDate: false, installedCommandNames: ['old-command'] },
          ],
          mcpTargets: [
            { id: 'omp-mcp', name: 'OMP MCP', path: '/tmp/.omp/agent/mcp.json', available: true, installed: false, upToDate: false, serverName: 'invoker' },
          ],
        })}
        onInstallBundledSkills={onInstallBundledSkills}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Update Helpers')).toBeInTheDocument();
    expect(screen.getByText('Installed, update available')).toBeInTheDocument();
    expect(screen.getByText('Not installed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Update Helpers' }));
    expect(onInstallBundledSkills).toHaveBeenCalledWith('update');
  });
  it('hides the section entirely when unsupported (dev mode)', () => {
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics({ supported: false, bundledVersion: '0.0.3', upToDate: false })}
        onUpdateInvokerCli={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText('Invoker CLI')).not.toBeInTheDocument();
  });
});
