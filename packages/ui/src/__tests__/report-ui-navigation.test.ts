import { describe, it, expect, vi } from 'vitest';
import { reportUiNavigation } from '../lib/report-ui-navigation.js';

describe('reportUiNavigation', () => {
  it('reports ui_navigation via reportUiPerf', () => {
    const reportUiPerf = vi.fn();
    reportUiNavigation(reportUiPerf, {
      kind: 'sidebarSurface',
      from: 'home',
      to: 'workflows',
      viewMode: 'dag',
    });
    expect(reportUiPerf).toHaveBeenCalledWith('ui_navigation', {
      kind: 'sidebarSurface',
      from: 'home',
      to: 'workflows',
      viewMode: 'dag',
    });
  });

  it('no-ops when reportUiPerf is missing', () => {
    expect(() =>
      reportUiNavigation(undefined, {
        kind: 'viewMode',
        from: 'dag',
        to: 'queue',
      }),
    ).not.toThrow();
  });
});
