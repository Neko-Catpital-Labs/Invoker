import type { PlanningPresetSpec } from './prerequisites.js';

export const CURSOR_PLANNING_MODEL_ALIASES: Readonly<Record<string, string>> = {
  claude: 'claude-4.5-sonnet',
  codex: 'gpt-5.3-codex',
};

export function resolveCursorPlanningModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  return CURSOR_PLANNING_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export interface BuiltinPlanningPresetEntry extends PlanningPresetSpec {
  label: string;
}

export const BUILTIN_PLANNING_PRESET_ENTRIES: Record<string, BuiltinPlanningPresetEntry> = {
  'cursor+auto': { tool: 'cursor', model: 'auto', label: 'Auto' },
  'cursor+composer-2.5': { tool: 'cursor', model: 'composer-2.5', label: 'Composer 2.5' },
  'cursor+claude': { tool: 'cursor', model: 'claude-4.5-sonnet', label: 'Claude Sonnet 4.5' },
  'cursor+claude-thinking': {
    tool: 'cursor',
    model: 'claude-4.5-sonnet-thinking',
    label: 'Claude Sonnet 4.5 Thinking',
  },
  'cursor+claude-4.6': {
    tool: 'cursor',
    model: 'claude-4.6-sonnet-medium',
    label: 'Claude Sonnet 4.6',
  },
  'cursor+opus': { tool: 'cursor', model: 'claude-4.6-opus-high', label: 'Claude Opus 4.6' },
  'cursor+codex': { tool: 'cursor', model: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  'cursor+gpt-5.2': { tool: 'cursor', model: 'gpt-5.2', label: 'GPT-5.2' },
  'cursor+grok': { tool: 'cursor', model: 'cursor-grok-4.5-high', label: 'Grok 4.5' },
  'cursor+gemini': { tool: 'cursor', model: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
  'omp+claude': { tool: 'omp', model: 'claude', label: 'Claude via OMP' },
  'omp+codex': { tool: 'omp', model: 'codex', label: 'Codex via OMP' },
  omp: { tool: 'omp', label: 'OMP' },
  codex: { tool: 'codex', label: 'Codex' },
  claude: { tool: 'claude', label: 'Claude' },
};

export const BUILTIN_PLANNING_PRESETS: Record<string, PlanningPresetSpec> = Object.fromEntries(
  Object.entries(BUILTIN_PLANNING_PRESET_ENTRIES).map(([key, entry]) => [
    key,
    entry.model !== undefined ? { tool: entry.tool, model: entry.model } : { tool: entry.tool },
  ]),
);

export const DEFAULT_PLANNING_PRESET = 'cursor+claude';

export function labelForBuiltinPlanningPreset(key: string): string | undefined {
  return BUILTIN_PLANNING_PRESET_ENTRIES[key]?.label;
}

export function curatedCursorPlanningModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const entry of Object.values(BUILTIN_PLANNING_PRESET_ENTRIES)) {
    if (entry.tool !== 'cursor' || !entry.model) continue;
    ids.add(entry.model.trim().toLowerCase());
  }
  return ids;
}

export function cursorMorePresetKey(modelId: string): string {
  return `cursor+${modelId.trim()}`;
}
