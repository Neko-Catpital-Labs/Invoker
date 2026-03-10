/**
 * Plan text parser — validates YAML/JSON plan input.
 *
 * Extracted from PlanLoader for reuse in TopBar.
 */

import yaml from 'js-yaml';

/**
 * Parse text as YAML first, then fall back to JSON.
 * Returns the parsed object or throws with a descriptive message.
 */
export function parsePlanText(text: string, fileExtension?: string): unknown {
  if (fileExtension === '.yaml' || fileExtension === '.yml') {
    const result = yaml.load(text);
    if (result === undefined || result === null) {
      throw new Error('YAML file parsed to empty value.');
    }
    return result;
  }

  if (fileExtension === '.json') {
    return JSON.parse(text);
  }

  // No extension hint (pasted text): try YAML first (superset of JSON)
  try {
    const result = yaml.load(text);
    if (result !== undefined && result !== null && typeof result === 'object') {
      return result;
    }
  } catch {
    // YAML parse failed — try JSON below.
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid plan. Provide valid YAML or JSON.');
  }
}
