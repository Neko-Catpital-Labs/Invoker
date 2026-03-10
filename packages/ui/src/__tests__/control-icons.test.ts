import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '..', 'index.css'), 'utf-8');

describe('ReactFlow Controls icon visibility', () => {
  it('overrides control button icon colors to black', () => {
    expect(css).toContain('--xy-controls-button-color: #000');
    expect(css).toContain('--xy-controls-button-color-hover: #000');
    expect(css).toContain('.react-flow__controls-button');
  });
});
