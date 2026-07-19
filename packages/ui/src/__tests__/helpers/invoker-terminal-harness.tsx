import { useState } from 'react';
import { vi } from 'vitest';
import { InvokerTerminal, type InvokerTerminalLine } from '../../components/InvokerTerminal.js';

export interface SubmittedPlanningMessage {
  message: string;
  presetKey: string;
}

export interface TerminalHarnessController {
  onSubmit: ReturnType<typeof vi.fn>;
  onSubmitDraft: ReturnType<typeof vi.fn>;
  onPresetChange: ReturnType<typeof vi.fn>;
  submissions: SubmittedPlanningMessage[];
}

interface TerminalHarnessProps {
  controller?: TerminalHarnessController;
  initialPresetKey?: string;
  initialValue?: string;
  initialDraftPlanAvailable?: boolean;
  readOnly?: boolean;
  busy?: boolean;
  lines?: InvokerTerminalLine[];
}

export function createTerminalHarnessController(): TerminalHarnessController {
  return {
    onSubmit: vi.fn(),
    onSubmitDraft: vi.fn(),
    onPresetChange: vi.fn(),
    submissions: [],
  };
}

export function InvokerTerminalHarness({
  controller = createTerminalHarnessController(),
  initialPresetKey = 'codex',
  initialValue = '',
  initialDraftPlanAvailable = false,
  readOnly = false,
  busy = false,
  lines = [],
}: TerminalHarnessProps): JSX.Element {
  const [value, setValue] = useState(initialValue);
  const [presetKey, setPresetKey] = useState(initialPresetKey);
  const [draftPlanAvailable, setDraftPlanAvailable] = useState(initialDraftPlanAvailable);
  const [submitted, setSubmitted] = useState(readOnly);

  const effectiveReadOnly = readOnly || submitted;

  return (
    <InvokerTerminal
      activeConversationKey="planning-chat-1"
      lines={lines}
      busy={busy}
      value={value}
      selectedPresetKey={presetKey}
      presetOptions={[
        { key: 'codex', label: 'Codex' },
        { key: 'claude', label: 'Claude' },
        { key: 'omp+claude', label: 'OMP + Claude' },
      ]}
      draftPlanAvailable={draftPlanAvailable}
      draftPlanSummary={{ name: 'Mock Plan', taskCount: 2 }}
      readOnly={effectiveReadOnly}
      onValueChange={setValue}
      onSubmit={() => {
        controller.submissions.push({ message: value, presetKey });
        controller.onSubmit({ message: value, presetKey });
        setValue('');
      }}
      onSubmitDraft={() => {
        controller.onSubmitDraft();
        setDraftPlanAvailable(false);
        setSubmitted(true);
      }}
      onPresetChange={(nextPresetKey) => {
        setPresetKey(nextPresetKey);
        controller.onPresetChange(nextPresetKey);
      }}
      onExpand={() => {}}
    />
  );
}
