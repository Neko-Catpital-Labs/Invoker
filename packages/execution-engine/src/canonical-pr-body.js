export const REQUIRED_SECTIONS = Object.freeze(['## Summary', '## Test Plan', '## Revert Plan']);
export const DISCOURAGED_HEADINGS = Object.freeze(['## Testing', '## Notes']);

/**
 * @param {string} body
 * @returns {string[]}
 */
export function validateCanonicalPrBody(body) {
  const errors = [];
  const trimmed = body.trim();

  if (!trimmed) {
    return [
      'PR body is empty. Use the canonical schema: ## Summary, ## Test Plan, ## Revert Plan, plus optional ## Architecture.',
    ];
  }

  for (const heading of REQUIRED_SECTIONS) {
    if (!trimmed.includes(heading)) {
      errors.push(`Missing required section: ${heading}`);
    }
  }

  for (const heading of DISCOURAGED_HEADINGS) {
    if (trimmed.includes(heading)) {
      errors.push(
        `Unsupported section: ${heading}. Do not use the lightweight PR format; use ## Test Plan and ## Revert Plan instead.`,
      );
    }
  }

  if (trimmed.includes('## Architecture')) {
    for (const subsection of ['### Before', '### After']) {
      if (!trimmed.includes(subsection)) {
        errors.push(`Architecture section is missing required subsection: ${subsection}`);
      }
    }
  }

  return errors;
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
export function normalizeMarkdownBlock(value) {
  return value?.trim() ?? '';
}

/**
 * @param {string[] | undefined} lines
 * @returns {string}
 */
export function joinMarkdownLines(lines) {
  return (lines ?? []).map((line) => line.trimEnd()).join('\n').trim();
}

/**
 * @param {{
 *   summary: string,
 *   architectureBefore?: string,
 *   architectureAfter?: string,
 *   testPlan?: string,
 *   revertPlan: string,
 *   additionalSections?: string[],
 * }} input
 * @returns {string}
 */
export function renderCanonicalPrBody(input) {
  const sections = ['## Summary', normalizeMarkdownBlock(input.summary)];
  const architecture = renderArchitectureSection(input.architectureBefore, input.architectureAfter);
  if (architecture) {
    sections.push(architecture);
  }

  sections.push('## Test Plan');
  sections.push(normalizeMarkdownBlock(input.testPlan));
  sections.push('## Revert Plan');
  sections.push(normalizeMarkdownBlock(input.revertPlan));

  for (const section of input.additionalSections ?? []) {
    const normalized = normalizeMarkdownBlock(section);
    if (normalized) {
      sections.push(normalized);
    }
  }

  return sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param {string | undefined} before
 * @param {string | undefined} after
 * @returns {string}
 */
export function renderArchitectureSection(before, after) {
  const normalizedBefore = normalizeMarkdownBlock(before);
  const normalizedAfter = normalizeMarkdownBlock(after);
  if (!normalizedBefore || !normalizedAfter) {
    return '';
  }

  return [
    '## Architecture',
    '',
    '### Before',
    '',
    normalizedBefore,
    '',
    '### After',
    '',
    normalizedAfter,
  ].join('\n');
}
