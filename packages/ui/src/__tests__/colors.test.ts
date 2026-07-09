/**
 * Tests for getStatusColor — status to color mapping.
 */

import { describe, it, expect } from 'vitest';
import { getStatusColor, getStatusInlineColors, matchesStatusFilter, formatStatusLabel } from '../lib/colors.js';
import { getStatusVisual, STATUS_VISUALS } from '../lib/status-colors.js';
import type { TaskStatus } from '../types.js';

describe('getStatusColor', () => {
  const allStatuses: TaskStatus[] = [
    'pending',
    'running',
    'fixing_with_ai',
    'completed',
    'failed',
    'closed',
    'blocked',
    'needs_input',
    'awaiting_approval',
    'stale',
  ];

  it('returns correct color for each status', () => {
    for (const status of allStatuses) {
      const colors = getStatusColor(status);

      // Each must have all four fields
      expect(colors).toHaveProperty('bg');
      expect(colors).toHaveProperty('border');
      expect(colors).toHaveProperty('text');
      expect(colors).toHaveProperty('dot');

      // Each field must be a non-empty string
      expect(typeof colors.bg).toBe('string');
      expect(colors.bg.length).toBeGreaterThan(0);
    }
  });

  it('keeps task color helpers backed by the canonical status visuals', () => {
    for (const status of Object.keys(STATUS_VISUALS)) {
      const visual = getStatusVisual(status);
      expect(getStatusColor(status)).toEqual({
        bg: visual.bg,
        border: visual.border,
        text: visual.text,
        dot: visual.dot,
      });
      expect(getStatusInlineColors(status)).toEqual(visual.inline);
    }
  });

  it('returns unique colors for distinguishable statuses', () => {
    const running = getStatusColor('running');
    const completed = getStatusColor('completed');
    const failed = getStatusColor('failed');

    // In dark card mode, background can be shared; accents must still be distinct
    expect(running.border).not.toBe(completed.border);
    expect(completed.border).not.toBe(failed.border);
    expect(running.border).not.toBe(failed.border);
    expect(running.dot).not.toBe(completed.dot);
    expect(completed.dot).not.toBe(failed.dot);
    expect(running.dot).not.toBe(failed.dot);
  });

  it('returns default for unknown status', () => {
    const colors = getStatusColor('nonexistent_status');

    expect(colors).toHaveProperty('bg');
    expect(colors).toHaveProperty('border');
    expect(colors).toHaveProperty('text');
    expect(colors).toHaveProperty('dot');

    // Should match the pending/default colors
    const defaultColors = getStatusColor('pending');
    expect(colors.bg).toBe(defaultColors.bg);
  });

  it('includes closed in every status color map', () => {
    expect(STATUS_VISUALS).toHaveProperty('closed');

    const closed = getStatusColor('closed');
    expect(closed.bg.length).toBeGreaterThan(0);
    expect(closed.border.length).toBeGreaterThan(0);
    expect(closed.text.length).toBeGreaterThan(0);
    expect(closed.dot.length).toBeGreaterThan(0);

    // Closed must resolve to its own visual, not the pending/default fallback.
    const pending = getStatusColor('pending');
    expect(closed.dot).not.toBe(pending.dot);
    expect(getStatusInlineColors('closed')).toEqual(getStatusVisual('closed').inline);
  });

  it('keeps closed visually distinct from failed and review_ready', () => {
    const closed = getStatusColor('closed');
    const failed = getStatusColor('failed');
    const reviewReady = getStatusColor('review_ready');

    expect(closed.border).not.toBe(failed.border);
    expect(closed.dot).not.toBe(failed.dot);
    expect(closed.border).not.toBe(reviewReady.border);
    expect(closed.dot).not.toBe(reviewReady.dot);
  });

  it('uses shared urgency color for fix and input states while keeping approval distinct', () => {
    const fixingWithAI = getStatusColor('fixing_with_ai');
    const needsInput = getStatusColor('needs_input');
    const awaitingApproval = getStatusColor('awaiting_approval');

    expect(fixingWithAI.dot).toBe(needsInput.dot);
    expect(fixingWithAI.border).toBe(needsInput.border);
    expect(awaitingApproval.dot).not.toBe(needsInput.dot);
    expect(awaitingApproval.border).not.toBe(needsInput.border);
  });
});

describe('formatStatusLabel', () => {
  it('formats closed as "Closed"', () => {
    expect(formatStatusLabel('closed')).toBe('Closed');
  });

  it('keeps closed label distinct from failed and review_ready labels', () => {
    expect(formatStatusLabel('closed')).not.toBe(formatStatusLabel('failed'));
    expect(formatStatusLabel('closed')).not.toBe(formatStatusLabel('review_ready'));
    expect(formatStatusLabel('failed')).toBe('Failed');
    expect(formatStatusLabel('review_ready')).toBe('Review Ready');
  });
});

describe('matchesStatusFilter', () => {
  it('keeps assigning separate from the running filter', () => {
    expect(matchesStatusFilter('running', 'assigning')).toBe(false);
    expect(matchesStatusFilter('assigning', 'assigning')).toBe(true);
    expect(matchesStatusFilter('running', 'running_executing')).toBe(true);
    expect(matchesStatusFilter('running', 'running')).toBe(true);
  });

  it('matches awaiting approval against fix approval', () => {
    expect(matchesStatusFilter('awaiting_approval', 'awaiting_approval')).toBe(true);
    expect(matchesStatusFilter('awaiting_approval', 'fix_approval')).toBe(true);
  });

  it('does not cross-match unrelated statuses', () => {
    expect(matchesStatusFilter('running', 'completed')).toBe(false);
    expect(matchesStatusFilter('failed', 'running_executing')).toBe(false);
  });
});
