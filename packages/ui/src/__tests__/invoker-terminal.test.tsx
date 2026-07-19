import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { InvokerTerminal } from '../components/InvokerTerminal.js';

function terminalProps(overrides: Partial<Parameters<typeof InvokerTerminal>[0]> = {}) {
  return {
    activeConversationKey: 'chat-1',
    lines: [{ id: 1, text: 'First line', role: 'system' as const }],
    busy: false,
    value: 'draft a plan',
    selectedPresetKey: 'codex',
    presetOptions: [{ key: 'codex', label: 'Codex' }],
    draftPlanAvailable: false,
    onValueChange: vi.fn(),
    onSubmit: vi.fn(),
    onSubmitDraft: vi.fn(),
    onPresetChange: vi.fn(),
    onExpand: vi.fn(),
    ...overrides,
  };
}

describe('Invoker terminal composer', () => {
  it('keeps the submit button accessible as Send while rendering a right-pointing send icon', () => {
    render(<InvokerTerminal {...terminalProps()} />);

    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toBeEnabled();
    expect(sendButton).not.toHaveTextContent('Send');
    expect(within(sendButton).getByTestId('invoker-terminal-send-icon')).toBeInTheDocument();
  });

  it('uses the yellow send-button styling with a white icon in the enabled state', () => {
    render(<InvokerTerminal {...terminalProps()} />);

    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toHaveClass('bg-amber-400');
    expect(sendButton).toHaveClass('text-white');
    expect(sendButton).toHaveClass('hover:bg-amber-300');
  });

  it('keeps submit disabled for empty input, busy state, and read-only sessions', () => {
    const { rerender } = render(<InvokerTerminal {...terminalProps({ value: '' })} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    rerender(<InvokerTerminal {...terminalProps({ busy: true, value: 'draft a plan' })} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    rerender(<InvokerTerminal {...terminalProps({ readOnly: true, value: 'draft a plan' })} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('preserves the form and Enter-to-send guards', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<InvokerTerminal {...terminalProps({ onSubmit, value: '   ' })} />);

    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(<InvokerTerminal {...terminalProps({ onSubmit, value: 'draft a plan' })} />);
    fireEvent.keyDown(screen.getByTestId('invoker-terminal-input'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(<InvokerTerminal {...terminalProps({ onSubmit, value: 'draft a plan', busy: true })} />);
    fireEvent.keyDown(screen.getByTestId('invoker-terminal-input'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(<InvokerTerminal {...terminalProps({ onSubmit, value: 'draft a plan', readOnly: true })} />);
    fireEvent.keyDown(screen.getByTestId('invoker-terminal-input'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
