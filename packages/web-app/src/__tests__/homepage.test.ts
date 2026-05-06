import { describe, it, expect, beforeEach } from 'vitest';

describe('homepage', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('renders "Hello, world!" into #app', async () => {
    await import('../main');
    const app = document.getElementById('app');
    expect(app).not.toBeNull();
    expect(app!.textContent).toBe('Hello, world!');
  });

  it('index.html contains a #app mount point', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const html = fs.readFileSync(
      path.resolve(__dirname, '../../index.html'),
      'utf-8',
    );
    expect(html).toContain('id="app"');
    expect(html).toContain('<script type="module"');
  });

  it('index.html has correct document structure', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const html = fs.readFileSync(
      path.resolve(__dirname, '../../index.html'),
      'utf-8',
    );
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="UTF-8"');
  });
});
