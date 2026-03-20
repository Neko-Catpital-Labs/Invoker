/**
 * Pure text-processing utilities for Slack message formatting.
 *
 * These functions have ZERO Slack API dependencies — they operate only on strings.
 */

const SLACK_CHUNK_LIMIT = 3_800;

/**
 * Split text into Slack-safe chunks, preserving formatting.
 *
 * - Splits at double-newline (paragraph) boundaries first, then single newlines.
 * - Never breaks a fenced code block (``` ... ```) across chunks.
 * - If a single code block exceeds the limit, it is split at newlines within
 *   the block, closing and re-opening the fence on each chunk.
 */
export function splitForSlack(text: string, limit = SLACK_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const paragraphs = text.split(/\n\n/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const separator = current ? '\n\n' : '';
    const candidate = current + separator + para;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    // Current chunk is non-empty and adding this paragraph would exceed limit
    if (current) {
      chunks.push(current);
      current = '';
    }

    // If the paragraph itself fits in a fresh chunk, use it directly
    if (para.length <= limit) {
      current = para;
      continue;
    }

    // Paragraph exceeds limit — split at single newlines
    const lines = para.split('\n');
    for (const line of lines) {
      const sep = current ? '\n' : '';
      const lineCandidate = current + sep + line;

      if (lineCandidate.length <= limit) {
        current = lineCandidate;
      } else {
        if (current) chunks.push(current);
        // If a single line exceeds the limit, push it as-is (can't split further
        // without breaking words/code)
        current = line;
      }
    }
  }
  if (current) chunks.push(current);

  // Post-process: merge chunks that split inside a fenced code block
  return mergeCodeBlocks(chunks, limit);
}

/**
 * Ensure no chunk boundary falls inside a fenced code block.
 * If a code block spans a boundary, merge the chunks. If the merged result
 * exceeds the limit, re-split inside the block with fence close/re-open.
 */
export function mergeCodeBlocks(chunks: string[], limit: number): string[] {
  const result: string[] = [];
  let i = 0;

  while (i < chunks.length) {
    let chunk = chunks[i];
    const fenceCount = (chunk.match(/^```/gm) || []).length;

    if (fenceCount % 2 === 0) {
      // All code blocks are closed — chunk is self-contained
      result.push(chunk);
      i++;
      continue;
    }

    // Unclosed code block — merge with subsequent chunks until closed
    i++;
    while (i < chunks.length) {
      chunk += '\n\n' + chunks[i];
      i++;
      const newFenceCount = (chunk.match(/^```/gm) || []).length;
      if (newFenceCount % 2 === 0) break;
    }

    // If the merged chunk fits, keep it
    if (chunk.length <= limit) {
      result.push(chunk);
    } else {
      // Re-split the oversized block at line boundaries with fence close/open
      result.push(...splitCodeBlockChunk(chunk, limit));
    }
  }

  return result;
}

/**
 * Split a chunk containing a long code block into pieces, closing and
 * re-opening the fence at each split point so Slack renders correctly.
 */
export function splitCodeBlockChunk(text: string, limit: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  let insideFence = false;
  let fenceLang = '';

  for (const line of lines) {
    const isFenceOpen = /^```(\w*)/.test(line) && !insideFence;
    const isFenceClose = /^```\s*$/.test(line) && insideFence;

    if (isFenceOpen) {
      insideFence = true;
      fenceLang = line.slice(3).trim();
    } else if (isFenceClose) {
      insideFence = false;
    }

    const sep = current ? '\n' : '';
    const candidate = current + sep + line;
    const closeOverhead = insideFence && !isFenceClose ? '\n```'.length : 0;

    if (candidate.length + closeOverhead > limit && current) {
      // Close the fence if we're inside one before pushing
      if (insideFence && !isFenceClose) {
        current += '\n```';
      }
      chunks.push(current);
      // Re-open the fence for the next chunk if we were inside one
      if (insideFence && !isFenceClose) {
        current = '```' + fenceLang + '\n' + line;
      } else {
        current = line;
      }
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Strip hallucinated /invoker commands from LLM responses.
 * The inner Claude sometimes invents non-existent commands like "/invoker start_plan".
 * This replaces any such references (except /invoker conversations, which is real)
 * with the correct user instruction.
 */
export function sanitizeSlashCommands(text: string): string {
  return text.replace(
    /(?:use |run |type |try )?`?\/?invoker\s+(?!conversations\b)\w+[^`\n]*`?/gi,
    'reply with "yes", "go", or "execute" to confirm',
  );
}
