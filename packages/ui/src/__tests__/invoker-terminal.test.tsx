import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InvokerTerminal } from '../components/InvokerTerminal.js';
import { makePlanningSessionSummary } from './helpers/mock-invoker.js';

describe('InvokerTerminal draft actions', () => {
  it('keeps review, submit, and graph navigation as explicit separate actions', () => {
    const readyDraftSession = makePlanningSessionSummary({
      id: 'session-1',
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First', 'Second'] },
      draftPlanText: 'name: Mock Plan\ntasks:\n  - id: first\n    description: First\n',
    });
    const onReviewDraft = vi.fn();
    const onCreateWorkflow = vi.fn();
    const onOpenGraph = vi.fn();

    render(
      <InvokerTerminal
        collapsed
        onToggle={() => {}}
        readyDraftSession={readyDraftSession}
        submittingSessionId={null}
        planningError={null}
        submitError={null}
        onReviewDraft={onReviewDraft}
        onCreateWorkflow={onCreateWorkflow}
        onOpenGraph={onOpenGraph}
        onRefreshPlanningSessions={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('ready-bar-review-draft'));

    expect(onReviewDraft).toHaveBeenCalledWith(readyDraftSession);
    expect(onCreateWorkflow).not.toHaveBeenCalled();
    expect(onOpenGraph).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('ready-bar-open-graph'));
    expect(onOpenGraph).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('ready-bar-create-workflow'));
    expect(onCreateWorkflow).toHaveBeenCalledWith(readyDraftSession);
  });

  it('disables only the Create workflow submit path while the draft is submitting', () => {
    render(
      <InvokerTerminal
        collapsed
        onToggle={() => {}}
        readyDraftSession={makePlanningSessionSummary({ id: 'session-1' })}
        submittingSessionId="session-1"
        planningError={null}
        submitError={null}
        onReviewDraft={() => {}}
        onCreateWorkflow={() => {}}
        onOpenGraph={() => {}}
        onRefreshPlanningSessions={() => {}}
      />,
    );

    expect(screen.getByTestId('ready-bar-create-workflow')).toBeDisabled();
    expect(screen.getByTestId('ready-bar-review-draft')).not.toBeDisabled();
    expect(screen.getByTestId('ready-bar-open-graph')).not.toBeDisabled();
  });
});
