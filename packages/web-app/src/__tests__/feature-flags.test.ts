import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('feature-flags', () => {
  describe('default values', () => {
    it('AUTH_ENABLED is false by default', async () => {
      const { featureFlags } = await import('../feature-flags');
      expect(featureFlags.AUTH_ENABLED).toBe(false);
    });

    it('featureFlags object has only AUTH_ENABLED key', async () => {
      const { featureFlags } = await import('../feature-flags');
      expect(Object.keys(featureFlags)).toEqual(['AUTH_ENABLED']);
    });
  });

  describe('auth placeholder gate in init()', () => {
    beforeEach(() => {
      document.body.innerHTML = '<div id="app"></div>';
      vi.restoreAllMocks();
      vi.resetModules();
    });

    function getApp() {
      return document.getElementById('app')!;
    }

    it('shows auth placeholder when AUTH_ENABLED is true', async () => {
      vi.doMock('../feature-flags', () => ({
        featureFlags: { AUTH_ENABLED: true },
      }));
      const { init } = await import('../main');
      globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));

      init(getApp());

      const app = getApp();
      expect(app.textContent).toBe('Auth: not implemented');
      expect(app.dataset.state).toBe('auth-placeholder');
    });

    it('does not call fetch when AUTH_ENABLED is true', async () => {
      vi.doMock('../feature-flags', () => ({
        featureFlags: { AUTH_ENABLED: true },
      }));
      const { init } = await import('../main');
      globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));

      init(getApp());

      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('proceeds to hello-world flow when AUTH_ENABLED is false', async () => {
      vi.doMock('../feature-flags', () => ({
        featureFlags: { AUTH_ENABLED: false },
      }));
      const { init } = await import('../main');
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: 'hello' }),
      });

      init(getApp());

      const app = getApp();
      expect(app.textContent).toBe('Loading…');
      expect(app.dataset.state).toBe('loading');
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it('hello-world flow resolves to success when AUTH_ENABLED is false', async () => {
      vi.doMock('../feature-flags', () => ({
        featureFlags: { AUTH_ENABLED: false },
      }));
      const { init } = await import('../main');
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: 'hello' }),
      });

      init(getApp());
      await new Promise((r) => setTimeout(r, 0));

      const app = getApp();
      expect(app.textContent).toBe('hello');
      expect(app.dataset.state).toBe('success');
    });
  });
});
