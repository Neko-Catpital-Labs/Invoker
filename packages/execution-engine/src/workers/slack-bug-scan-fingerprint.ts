import { createHash } from 'node:crypto';

/** Normalizes Slack markup/links/whitespace before fingerprinting, mirroring the
 * existing complaint-scout discovery script's normalize_text(). */
export function normalizeComplaintText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** First 16 hex chars of sha256(normalized text) — stable dedup key for a complaint. */
export function issueFingerprint(text: string): string {
  return createHash('sha256').update(normalizeComplaintText(text)).digest('hex').slice(0, 16);
}
