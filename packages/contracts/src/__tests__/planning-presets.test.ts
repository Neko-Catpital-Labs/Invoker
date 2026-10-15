import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PLANNING_PRESETS,
  CURSOR_PLANNING_MODEL_ALIASES,
  cursorMorePresetKey,
  labelForBuiltinPlanningPreset,
  resolveCursorPlanningModel,
  resolvePlanningPresetByKey,
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

  it('resolves known presets before synthesizing cursor+ More… keys', () => {
    expect(resolvePlanningPresetByKey(BUILTIN_PLANNING_PRESETS, 'cursor+claude')).toEqual({
      tool: 'cursor',
      model: 'claude-4.5-sonnet',
    });
    expect(resolvePlanningPresetByKey(BUILTIN_PLANNING_PRESETS, cursorMorePresetKey('brand-new-model'))).toEqual({
      tool: 'cursor',
      model: 'brand-new-model',
    });
    expect(resolvePlanningPresetByKey(BUILTIN_PLANNING_PRESETS, 'codex+something')).toBeUndefined();
    expect(resolvePlanningPresetByKey(BUILTIN_PLANNING_PRESETS, 'cursor+')).toBeUndefined();
    expect(resolvePlanningPresetByKey(BUILTIN_PLANNING_PRESETS, 'bad')).toBeUndefined();
  });

  it('lets config presets win over cursor+ synthesis for the same key', () => {
    const presets = {
      ...BUILTIN_PLANNING_PRESETS,
      'cursor+brand-new-model': { tool: 'cursor' as const, model: 'configured-override' },
    };
    expect(resolvePlanningPresetByKey(presets, 'cursor+brand-new-model')).toEqual({
      tool: 'cursor',
      model: 'configured-override',
    });
  });
});
