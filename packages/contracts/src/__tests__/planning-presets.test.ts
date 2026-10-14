import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PLANNING_PRESETS,
  CURSOR_PLANNING_MODEL_ALIASES,
  labelForBuiltinPlanningPreset,
  resolveCursorPlanningModel,
} from '../planning-presets.js';

describe('planning presets', () => {
  it('uses real Cursor CLI model ids for cursor presets', () => {
    expect(BUILTIN_PLANNING_PRESETS['cursor+claude']).toEqual({
      tool: 'cursor',
      model: 'claude-4.5-sonnet',
    });
    expect(BUILTIN_PLANNING_PRESETS['cursor+codex']).toEqual({
      tool: 'cursor',
      model: 'gpt-5.3-codex',
    });
    expect(BUILTIN_PLANNING_PRESETS['cursor+auto']?.model).toBe('auto');
    expect(Object.values(BUILTIN_PLANNING_PRESETS).filter((preset) => preset.tool === 'cursor').length)
      .toBeGreaterThanOrEqual(8);
  });

  it('does not advertise invalid Cursor aliases as model ids', () => {
    for (const preset of Object.values(BUILTIN_PLANNING_PRESETS)) {
      if (preset.tool !== 'cursor' || !preset.model) continue;
      expect(preset.model).not.toBe('claude');
      expect(preset.model).not.toBe('codex');
    }
  });

  it('resolves legacy Cursor aliases', () => {
    expect(resolveCursorPlanningModel('claude')).toBe(CURSOR_PLANNING_MODEL_ALIASES.claude);
    expect(resolveCursorPlanningModel('codex')).toBe(CURSOR_PLANNING_MODEL_ALIASES.codex);
    expect(resolveCursorPlanningModel('claude-4.5-sonnet')).toBe('claude-4.5-sonnet');
    expect(resolveCursorPlanningModel(undefined)).toBeUndefined();
  });

  it('exposes human labels for builtin cursor models', () => {
    expect(labelForBuiltinPlanningPreset('cursor+claude')).toBe('Claude Sonnet 4.5');
    expect(labelForBuiltinPlanningPreset('cursor+auto')).toBe('Auto');
  });
});
