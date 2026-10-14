
export interface CursorDiscoveredModel {
  id: string;
  label: string;
}

export type CursorListModelsParse =
  | { kind: 'ok'; models: CursorDiscoveredModel[] }
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: string };

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const MODEL_LINE_RE = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s+-\s+(.+)$/;
const DEFAULT_SUFFIX_RE = /\s*\(default\)\s*$/i;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}

export function parseCursorListModelsOutput(stdout: string): CursorListModelsParse {
  const cleaned = stripAnsi(stdout).replace(/\r/g, '');
  const models: CursorDiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^loading models/i.test(line) || /^available models$/i.test(line)) continue;
    const match = MODEL_LINE_RE.exec(line);
    if (!match) continue;
    const id = match[1].trim();
    const label = match[2].replace(DEFAULT_SUFFIX_RE, '').trim();
    if (!id || !label) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ id, label });
  }

  if (models.length === 0) {
    if (/available models/i.test(cleaned) || /loading models/i.test(cleaned)) {
      return { kind: 'empty' };
    }
    return { kind: 'invalid', reason: 'no model lines found' };
  }
  return { kind: 'ok', models };
}
