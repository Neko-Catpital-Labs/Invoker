export const REQUIRED_SECTIONS: readonly string[];
export const DISCOURAGED_HEADINGS: readonly string[];

export function validateCanonicalPrBody(body: string): string[];
export function normalizeMarkdownBlock(value: string | undefined): string;
export function joinMarkdownLines(lines: string[] | undefined): string;
export function renderArchitectureSection(before?: string, after?: string): string;
export function renderCanonicalPrBody(input: {
  summary: string;
  architectureBefore?: string;
  architectureAfter?: string;
  testPlan?: string;
  revertPlan: string;
  additionalSections?: string[];
}): string;
