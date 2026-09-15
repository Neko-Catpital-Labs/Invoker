import { createHash } from 'node:crypto';

export function normalizeComplaintText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function issueFingerprint(text: string): string {
  return createHash('sha256').update(normalizeComplaintText(text)).digest('hex').slice(0, 16);
}
