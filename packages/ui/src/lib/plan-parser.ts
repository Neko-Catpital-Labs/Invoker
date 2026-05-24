/**
 * Plan text parser — validates YAML/JSON plan input.
 *
 * Shared by plan loading controls.
 *
 * js-yaml is dynamically imported so it does not ship in the cold-start
 * entry chunk; it only loads the first time the user opens a plan file.
 */

export async function parsePlanText(text: string, fileExtension?: string): Promise<unknown> {
  if (fileExtension === '.json') {
    return JSON.parse(text);
  }

  const { default: yaml } = await import('js-yaml');

  if (fileExtension === '.yaml' || fileExtension === '.yml') {
    const result = yaml.load(text);
    if (result === undefined || result === null) {
      throw new Error('YAML file parsed to empty value.');
    }
    return result;
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
