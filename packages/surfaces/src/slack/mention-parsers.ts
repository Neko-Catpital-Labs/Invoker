export type LocalRequest =
  | { kind: 'command'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'change'; text: string };

export const PRESET_TOOL_HINTS = ['cursor', 'omp', 'codex', 'claude'];

export function parseWorkflowStatusQuery(text: string): { intent: 'command'; operation: 'status'; target: { all: true } } | null {
  const trimmed = text.trim();
  if (/\n/.test(trimmed)) return null;
  if (trimmed.split(/\s+/).length > 12) return null;
  if (!/\bworkflows?\b/i.test(trimmed)) return null;
  if (!/\b(status|how many|count|running|active|in progress|progress)\b/i.test(trimmed)) return null;
  return { intent: 'command', operation: 'status', target: { all: true } };
}

export function parseLocalRequest(text: string): LocalRequest | null {
  const trimmed = text.trim();
  const commandPatterns = [
    /^(?:exec|execute)\s+local(?:ly)?\s*:\s*/i,
    /^local\s+(?:command|cmd)\s*:\s*/i,
  ];
  for (const pattern of commandPatterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      return rest ? { kind: 'command', text: rest } : null;
    }
  }

  const agentPatterns = [
    /^run\s+local(?:ly)?\s*:\s*/i,
    /^local\s+run\s*:\s*/i,
  ];
  for (const pattern of agentPatterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      return rest ? { kind: 'agent', text: rest } : null;
    }
  }

  const changePatterns = [
    /^local\s*:\s*/i,
    /^local\s+(?:change|edit|patch)\s*:\s*/i,
    /^(?:change|edit|patch)\s+local(?:ly)?\s*:\s*/i,
    /^locally\s*:\s*/i,
  ];
  for (const pattern of changePatterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      return rest ? { kind: 'change', text: rest } : null;
    }
  }

  return null;
}
