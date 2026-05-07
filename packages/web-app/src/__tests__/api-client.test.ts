import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApiClient } from '../api-client';

describe('api-client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('health()', () => {
    it('returns parsed JSON on 200', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });
      const client = createApiClient('http://localhost:3000');
      const result = await client.health();
      expect(result).toEqual({ status: 'ok' });
      expect(globalThis.fetch).toHaveBeenCalledWith('http://localhost:3000/health');
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server Error' }),
      });
      const client = createApiClient('http://localhost:3000');
      await expect(client.health()).rejects.toThrow('Server Error');
    });
  });

  describe('hello()', () => {
    it('returns parsed JSON on 200', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: 'hello' }),
      });
      const client = createApiClient('http://localhost:3000');
      const result = await client.hello();
      expect(result).toEqual({ message: 'hello' });
      expect(globalThis.fetch).toHaveBeenCalledWith('http://localhost:3000/hello');
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Not Found' }),
      });
      const client = createApiClient('http://localhost:3000');
      await expect(client.hello()).rejects.toThrow('Not Found');
    });

    it('throws on network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
      const client = createApiClient('http://localhost:3000');
      await expect(client.hello()).rejects.toThrow('fetch failed');
    });
  });

  describe('defaults', () => {
    it('uses /api as default base URL', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: 'hello' }),
      });
      const client = createApiClient();
      await client.hello();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/hello');
    });
  });

  describe('error edge cases', () => {
    it('handles non-JSON error response body', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error('invalid json')),
      });
      const client = createApiClient('http://localhost:3000');
      await expect(client.health()).rejects.toThrow('Unknown error');
    });
  });
});
