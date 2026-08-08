/**
 * Component test: "Add remote machines" step of the SystemSetupModal.
 *
 * Mirrors the existing Slack step's guided per-field form, but each machine
 * is checked and added immediately via onAddMachine instead of being batched
 * into the combined onRunSetup request.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SystemDiagnostics } from '@invoker/contracts';

import { SystemSetupModal } from '../components/SystemSetupModal.js';

function makeDiagnostics(): SystemDiagnostics {
  return {
    platform: 'darwin',
    arch: 'arm64',
    appVersion: '0.0.3',
    isPackaged: true,
    tools: [],
  };
}

function fillRequiredMachineFields(host: string, user: string, sshKeyPath: string): void {
  fireEvent.change(screen.getByLabelText('Host'), { target: { value: host } });
  fireEvent.change(screen.getByLabelText('User'), { target: { value: user } });
  fireEvent.change(screen.getByLabelText(/SSH key path/), { target: { value: sshKeyPath } });
}

describe('SystemSetupModal — Add remote machines step', () => {
  it('adds a machine to the list on a successful check', async () => {
    const onAddMachine = vi.fn().mockResolvedValue({ ok: true, message: 'Reachable' });
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics()}
        onAddMachine={onAddMachine}
        onClose={() => {}}
      />,
    );

    fillRequiredMachineFields('10.0.0.5', 'deploy', '~/.ssh/id_ed25519');
    fireEvent.click(screen.getByRole('button', { name: 'Check and add machine' }));

    await screen.findByText('deploy@10.0.0.5');
    expect(onAddMachine).toHaveBeenCalledWith({
      host: '10.0.0.5',
      user: 'deploy',
      sshKeyPath: '~/.ssh/id_ed25519',
    });
    expect(screen.getByText('Reachable')).toBeInTheDocument();
    expect(screen.queryByLabelText('Host')).not.toBeInTheDocument();
  });

  it('leaves the list unchanged and keeps the form on a failing check', async () => {
    const onAddMachine = vi.fn().mockResolvedValue({ ok: false, message: 'SSH auth failed' });
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics()}
        onAddMachine={onAddMachine}
        onClose={() => {}}
      />,
    );

    fillRequiredMachineFields('10.0.0.5', 'deploy', '~/.ssh/id_ed25519');
    fireEvent.click(screen.getByRole('button', { name: 'Check and add machine' }));

    await screen.findByText('SSH auth failed');
    expect(screen.queryByText('deploy@10.0.0.5')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Host')).toHaveValue('10.0.0.5');
    expect(screen.getByLabelText('User')).toHaveValue('deploy');
    expect(screen.getByLabelText(/SSH key path/)).toHaveValue('~/.ssh/id_ed25519');
  });

  it('adds only one entry when the submit button is double-clicked with the same fields', async () => {
    const onAddMachine = vi.fn().mockResolvedValue({ ok: true });
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics()}
        onAddMachine={onAddMachine}
        onClose={() => {}}
      />,
    );

    fillRequiredMachineFields('10.0.0.5', 'deploy', '~/.ssh/id_ed25519');
    const submitButton = screen.getByRole('button', { name: 'Check and add machine' });
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    await waitFor(() => expect(onAddMachine).toHaveBeenCalledTimes(1));
    await screen.findByText('deploy@10.0.0.5');
    expect(screen.getAllByText('deploy@10.0.0.5')).toHaveLength(1);
  });

  it('confirms before closing the modal while the machine form has unconfirmed values', () => {
    const onClose = vi.fn();
    render(
      <SystemSetupModal
        diagnostics={makeDiagnostics()}
        onAddMachine={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.0.0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Discard machine details?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText('Discard machine details?')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
