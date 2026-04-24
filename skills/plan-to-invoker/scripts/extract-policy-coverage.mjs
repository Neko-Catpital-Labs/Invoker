#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function trimCell(value) {
  return value.trim().replace(/^`|`$/g, '');
}

function classifyDecisionRow(targetAction) {
  const normalized = targetAction.trim().toLowerCase();
  if (normalized === 'no invalidation' || normalized === 'continue or revert') {
    return 'non_invalidating_exception';
  }
  return 'mutation_path';
}

function sectionLines(lines, heading) {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^## /.test(line)) break;
    out.push(line);
  }
  return out;
}

function subsectionTitles(lines, parentHeading) {
  const section = sectionLines(lines, parentHeading);
  return section
    .filter((line) => /^### /.test(line))
    .map((line) => line.replace(/^### /, '').trim());
}

function extractDefinitionItems(lines) {
  const section = sectionLines(lines, '## Canonical 2x2 Model');
  const defsStart = section.findIndex((line) => line.trim() === 'Definitions:');
  if (defsStart === -1) return [];
  const items = [];
  for (let i = defsStart + 1; i < section.length; i += 1) {
    const line = section[i].trim();
    if (!line.startsWith('- ')) continue;
    const match = line.match(/^- `?([^`:]+)`?:\s*(.+)$/);
    if (!match) continue;
    const name = match[1].trim();
    items.push({
      coverageKey: `definition-${slugify(name)}`,
      rowType: 'lifecycle_command',
      verifyText: name,
      sourceText: line.slice(2),
      section: 'Canonical 2x2 Model',
      mustCover: true,
      suggestedTaskClass: 'lifecycle_command',
    });
  }
  return items;
}

function extractDecisionTableItems(lines) {
  const section = sectionLines(lines, '## Decision Table');
  const headerIndex = section.findIndex((line) => line.includes('| Mutation |'));
  if (headerIndex === -1) return [];
  const items = [];
  for (let i = headerIndex + 2; i < section.length; i += 1) {
    const line = section[i];
    if (!line.trim().startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(trimCell);
    if (cells.length < 6) continue;
    const [mutation, changesSpec, invalidateActive, targetAction, behaviorToday, why] = cells;
    if (!mutation || mutation === '---') continue;
    const rowType = classifyDecisionRow(targetAction);
    items.push({
      coverageKey: `decision-${slugify(mutation)}`,
      rowType,
      verifyText: mutation,
      sourceText: line.trim(),
      section: 'Decision Table',
      mustCover: true,
      suggestedTaskClass: rowType,
      metadata: {
        changesExecutionSpec: changesSpec,
        invalidateActiveAttempt: invalidateActive,
        targetAction,
        behaviorToday,
        why,
      },
    });
  }
  return items;
}

function extractBulletItems(lines, heading, rowType, suggestedTaskClass) {
  const section = sectionLines(lines, heading);
  return section
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => {
      const text = line.trim().slice(2).trim().replace(/^`|`$/g, '');
      return {
        coverageKey: `${rowType}-${slugify(text)}`,
        rowType,
        verifyText: text,
        sourceText: text,
        section: heading.replace(/^## /, ''),
        mustCover: true,
        suggestedTaskClass,
      };
    });
}

function extractExecutionDefiningItems(lines) {
  const section = sectionLines(lines, '## Execution-Defining Inputs');
  const headerIndex = section.findIndex((line) => line.trim() === 'These are not execution-defining task inputs:');
  const itemsSection = headerIndex === -1 ? section : section.slice(0, headerIndex);
  return itemsSection
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => {
      const text = line.trim().slice(2).trim().replace(/^`|`$/g, '');
      return {
        coverageKey: `execution_defining_input-${slugify(text)}`,
        rowType: 'execution_defining_input',
        verifyText: text,
        sourceText: text,
        section: 'Execution-Defining Inputs',
        mustCover: true,
        suggestedTaskClass: 'mutation_path',
      };
    });
}

function extractNonExecutionItems(lines) {
  const section = sectionLines(lines, '## Execution-Defining Inputs');
  const headerIndex = section.findIndex((line) => line.trim() === 'These are not execution-defining task inputs:');
  if (headerIndex === -1) return [];
  return section
    .slice(headerIndex + 1)
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => {
      const text = line.trim().slice(2).trim().replace(/^`|`$/g, '');
      return {
        coverageKey: `non-invalidating-${slugify(text)}`,
        rowType: 'non_invalidating_exception',
        verifyText: text,
        sourceText: text,
        section: 'Execution-Defining Inputs',
        mustCover: true,
        suggestedTaskClass: 'non_invalidating_exception',
      };
    });
}

function extractInconsistencyItems(lines) {
  return subsectionTitles(lines, '## Inconsistencies With The 2x2 Model').map((title) => ({
    coverageKey: `inconsistency-${slugify(title)}`,
    rowType: 'cleanup',
    verifyText: `### ${title}`,
    sourceText: title,
    section: 'Inconsistencies With The 2x2 Model',
    mustCover: true,
    suggestedTaskClass: 'cleanup',
  }));
}

function extractInvariantItem(lines) {
  const section = sectionLines(lines, '## Hard Invariant');
  if (section.length === 0) return [];
  return [{
    coverageKey: 'hard-invariant-cancel-first',
    rowType: 'invariant',
    verifyText: 'Whenever we `retry` or `recreate`, any affected in-flight work must be interrupted and canceled first.',
    sourceText: 'Whenever we `retry` or `recreate`, any affected in-flight work must be interrupted and canceled first.',
    section: 'Hard Invariant',
    mustCover: true,
    suggestedTaskClass: 'invariant',
  }];
}

function extractCoverage(inputPath, content) {
  const lines = content.split(/\r?\n/);
  const isPolicyMatrix = content.includes('## Decision Table')
    && content.includes('## Hard Invariant')
    && content.includes('| Mutation |');

  if (!isPolicyMatrix) {
    return {
      sourceKind: 'generic',
      sourceFile: inputPath ?? null,
      coverageItems: [],
    };
  }

  const coverageItems = [
    ...extractDefinitionItems(lines),
    ...extractDecisionTableItems(lines),
    ...extractExecutionDefiningItems(lines),
    ...extractBulletItems(lines, '## Route Selection Rule', 'route_selection_rule', 'invariant'),
  ];

  const result = {
    sourceKind: 'policy_matrix',
    sourceFile: inputPath ?? null,
    coverageItems: [
      ...extractInvariantItem(lines),
      ...coverageItems,
      ...extractNonExecutionItems(lines),
      ...extractInconsistencyItems(lines),
    ],
  };

  const seen = new Set();
  result.coverageItems = result.coverageItems.filter((item) => {
    if (seen.has(item.coverageKey)) return false;
    seen.add(item.coverageKey);
    return true;
  });
  return result;
}

const inputPath = process.argv[2] || null;
const content = inputPath ? readFileSync(inputPath, 'utf8') : readFileSync(0, 'utf8');
process.stdout.write(`${JSON.stringify(extractCoverage(inputPath, content), null, 2)}\n`);
