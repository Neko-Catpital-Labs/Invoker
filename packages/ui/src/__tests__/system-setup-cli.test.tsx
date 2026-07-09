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

function makeDiagnostics(
  cliInstaller: CliInstallerStatus | undefined,
  bundledSkills?: BundledSkillsStatus,
  toolsOrReadiness: SystemDiagnostics['tools'] | SystemDiagnostics['readiness'] = [],
): SystemDiagnostics {
  const tools = Array.isArray(toolsOrReadiness) ? toolsOrReadiness : [];
  const readiness = Array.isArray(toolsOrReadiness) ? undefined : toolsOrReadiness;
  return {
    platform: 'darwin',
    arch: 'arm64',
    appVersion: '0.0.3',
    isPackaged: true,
    tools,
    cliInstaller,
    bundledSkills,
    readiness,
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

  it('reinstalls helpers when installed helper targets are already up to date', () => {
    const onInstallBundledSkills = vi.fn();
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics(undefined, {
          available: true,
          promptRecommended: false,
          managedPrefix: 'invoker-',
          bundledSkillNames: ['plan-to-invoker'],
          targets: [
            { id: 'codex', name: 'Codex', path: '/tmp/.codex/skills', available: true, installed: true, upToDate: true, installedSkillNames: ['invoker-plan-to-invoker'] },
          ],
          commandTargets: [],
          mcpTargets: [],
        })}
        onInstallBundledSkills={onInstallBundledSkills}
        onClose={() => {}}
      />,
    );

    const buttons = screen.getAllByRole('button', { name: 'Reinstall Helpers' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(onInstallBundledSkills).toHaveBeenCalledWith('reinstall');
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

  it('renders readiness checks from the shared diagnostics contract', () => {
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics(undefined, undefined, {
          ok: false,
          checks: [
            {
              id: 'default-preset',
              name: 'Default planning preset',
              status: 'error',
              detail: 'Default preset needs codex',
              remediation: 'Install codex or choose an installed preset',
            },
          ],
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Readiness')).toBeInTheDocument();
    expect(screen.getByText('Default planning preset')).toBeInTheDocument();
    expect(screen.getByText('Default preset needs codex')).toBeInTheDocument();
    expect(screen.getByText('Install codex or choose an installed preset')).toBeInTheDocument();
  });

  it('hides readiness when diagnostics has no checks', () => {
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics(undefined, undefined, {
          ok: true,
          checks: [],
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText('Readiness')).not.toBeInTheDocument();
  });

  it('keeps system checks visible and adds guided setup status', () => {
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics(
          { supported: true, bundledVersion: '0.0.3', upToDate: false },
          undefined,
          [
            { id: 'git', name: 'Git', installed: false, required: true, installHint: 'Install Git' },
            { id: 'cursor', name: 'Cursor Agent', installed: false, required: false, installHint: 'Enable Cursor CLI' },
          ],
        )}
        onRunSetup={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Choose setup items')).toBeInTheDocument();
    expect(screen.getByText('Missing required: Git')).toBeInTheDocument();
    expect(screen.getByText('System check details')).toBeInTheDocument();
    expect(screen.queryByText('Enable Cursor CLI')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /System check details/ }));
    expect(screen.getByText('Enable Cursor CLI')).toBeInTheDocument();
  });
  it('reviews selected setup items before running Slack checked by default', () => {
    const onRunSetup = vi.fn();
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics({ supported: true, bundledVersion: '0.0.3', upToDate: true })}
        onRunSetup={onRunSetup}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole('checkbox', { name: /Set up Slack integration/ })).toBeChecked();
    expect(screen.queryByText(/Next: add Bot token/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set it up for me' }));
    expect(screen.getByText('Review setup plan')).toBeInTheDocument();
    expect(screen.getByText(/Next: add Bot token/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Bot token/), { target: { value: 'xoxb-token' } });
    fireEvent.change(screen.getByLabelText(/App token/), { target: { value: 'xapp-token' } });
    fireEvent.change(screen.getByLabelText(/Signing secret/), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText(/Lobby channel ID/), { target: { value: 'C123' } });

    fireEvent.click(screen.getByRole('button', { name: 'Approve and run setup' }));
    expect(onRunSetup).toHaveBeenCalledWith({
      updateCli: true,
      installHelpers: true,
      fixTools: true,
      slack: {
        botToken: 'xoxb-token',
        appToken: 'xapp-token',
        signingSecret: 'secret',
        channelId: 'C123',
      },
    });
  });

  it('runs safe selected setup first when Slack still needs fields', () => {
    const onRunSetup = vi.fn();
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics({ supported: true, bundledVersion: '0.0.3', upToDate: true })}
        onRunSetup={onRunSetup}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set it up for me' }));
    expect(screen.getByText('Slack waits for Bot token. The rest can run now.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and run setup' }));
    expect(onRunSetup).toHaveBeenCalledWith({
      updateCli: true,
      installHelpers: true,
      fixTools: true,
      slack: false,
    });
  });

  it('shows setup output after the one-step setup command finishes', () => {
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics({ supported: true, bundledVersion: '0.0.3', upToDate: true })}
        setupResult={{ ok: true, steps: [{ id: 'tools', name: 'Install missing tools', ok: true, output: 'ok  Git: git found' }] }}
        onRunSetup={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Setup completed')).toBeInTheDocument();
    expect(screen.getByText(/Git: git found/)).toBeInTheDocument();
  });
});
