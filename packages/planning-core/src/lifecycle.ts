import { isExactPlanningSubmitCommand } from './planning-surface.js';

export type PlanningRole = 'user' | 'assistant' | 'system';

export interface PlanningMessage {
  role: PlanningRole;
  content: string;
}

function normalized(text: string): string {
  return text.trim().toLowerCase();
}

export function hasExplicitDraftIntent(message: string): boolean {
  if (isExactPlanningSubmitCommand(message)) return true;
  const value = message.trim().toLowerCase().replace(/\s+/g, ' ');
  return [
    /^draft$/,
    /\bdraft\b.*\b(yaml\s+)?plan\b/,
    /\b(yaml\s+)?plan\b.*\bdraft\b/,
    /\b(create|generate|write|produce|make)\b.*\b(yaml\s+)?plan\b/,
    /\bgo ahead\b.*\bdraft\b/,
    /\bproceed\b.*\b(yaml\s+)?plan\b/,
    /\bproceed\b/,
    /\bdraft it\b/,
    /\bcreate-plan\b/,
  ].some((pattern) => pattern.test(value));
}

export function isShortDraftConfirmation(message: string): boolean {
  return [
    'yes',
    'y',
    'yes please',
    'ok',
    'okay',
    'go',
    'please do',
    'go ahead',
    'do it',
    'sounds good',
    'confirm',
    'approved',
    'lgtm',
    'ship it',
  ].includes(normalized(message).replace(/[.!]+$/g, '').replace(/\s+/g, ' '));
}

const QUESTION_PUNCTUATION_PATTERN = /[?？¿؟՞︖⁇⁈⁉]/;

const LEADING_QUESTION_WORD_PATTERN = /^(what|when|where|who|whom|whose|which|why|how|is|are|am|was|were|do|does|did|can|could|will|would|shall|should|may|might|must)\b/i;

// A bare `?` check misses punctuation-free ("What files are in this repo")
// and non-ASCII questions, which can slip past authorization gates that key
// off "is this a question."
export function looksLikeQuestion(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (QUESTION_PUNCTUATION_PATTERN.test(trimmed)) return true;
  return LEADING_QUESTION_WORD_PATTERN.test(trimmed);
}

export function assistantAskedWhetherToDraft(message: string): boolean {
  return message.includes('?')
    && /\b(draft|create|generate|write|produce)\b/i.test(message)
    && /\b(yaml\s+)?plan\b/i.test(message);
}

export function previousAssistantAskedWhetherToDraft(messages: readonly PlanningMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') return false;
    if (message.role === 'assistant') return assistantAskedWhetherToDraft(message.content);
  }
  return false;
}

export function isDraftingAuthorized(message: string, messagesBeforeTurn: readonly PlanningMessage[]): boolean {
  return hasExplicitDraftIntent(message)
    || (isShortDraftConfirmation(message) && previousAssistantAskedWhetherToDraft(messagesBeforeTurn));
}
