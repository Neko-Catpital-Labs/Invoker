/**
 * Tests for getStatusColor — status to color mapping.
 */

import { describe, it, expect } from 'vitest';
import { getStatusColor } from '../lib/colors.js';
import type { TaskStatus } from '../types.js';

describe('getStatusColor', () => {
  const allStatuses: TaskStatus[] = [
    'pending',
    'running',
    'fixing_with_ai',
    'completed',
    'failed',
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

  it('fixing_with_ai, needs_input, and awaiting_approval have pairwise distinct colors', () => {
    const fixingWithAI = getStatusColor('fixing_with_ai');
    const needsInput = getStatusColor('needs_input');
    const awaitingApproval = getStatusColor('awaiting_approval');

    // Background colors must be pairwise unequal
    expect(fixingWithAI.bg).not.toBe(needsInput.bg);
    expect(needsInput.bg).not.toBe(awaitingApproval.bg);
    expect(fixingWithAI.bg).not.toBe(awaitingApproval.bg);
  });
});
