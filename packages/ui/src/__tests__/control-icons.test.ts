import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '..', 'index.css'), 'utf-8');

describe('ReactFlow Controls icon visibility', () => {
  it('overrides control button icon colors to white', () => {
    expect(css).toContain('--xy-controls-button-color: #fff');
    expect(css).toContain('--xy-controls-button-color-hover: #fff');
    expect(css).toContain('.react-flow__controls-button');
  });
});
