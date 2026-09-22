import { describe, expect, it } from 'vitest';
import { assertHeadlessDisplay } from '../../e2e/global-setup.js';

describe('assertHeadlessDisplay', () => {
  it('allows Linux CI runners, which have no interactive desktop', () => {
    expect(() => assertHeadlessDisplay('linux', {})).not.toThrow();
  });

  it('refuses macOS so Electron cannot open windows on a developer desktop', () => {
    expect(() => assertHeadlessDisplay('darwin', {})).toThrow(/Refusing to run Electron e2e on darwin/);
  });

  it('refuses Windows for the same reason', () => {
    expect(() => assertHeadlessDisplay('win32', {})).toThrow(/Refusing to run Electron e2e on win32/);
  });

  it('names the opt-in so the refusal is actionable', () => {
    expect(() => assertHeadlessDisplay('darwin', {})).toThrow(/INVOKER_ALLOW_HEADED_E2E=1/);
  });

  it('honours the explicit opt-in used by visual-proof captures', () => {
    expect(() => assertHeadlessDisplay('darwin', { INVOKER_ALLOW_HEADED_E2E: '1' })).not.toThrow();
  });
});
