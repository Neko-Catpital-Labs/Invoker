const JSON_TAIL_RE = /\{["'][\s\S]*$/;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HEX_ADDR_RE = /\b0x[0-9a-fA-F]+\b/g;
const TMP_PATH_RES = [
  new RegExp('/private/tmp/\\S*', 'g'),
  new RegExp('/tmp/\\S*', 'g'),
  new RegExp('/var/folders/\\S*', 'g'),
  new RegExp('\\binvoker-[a-zA-Z0-9]+-[a-zA-Z0-9]+\\b', 'g'),
];
const WORKFLOW_ID_RE = /\bwf-\d+-\d+\b/g;
const HEX_RUN_RE = /\b[0-9a-fA-F]{7,}\b/g;
const LONG_ID_RE = /\b[a-zA-Z0-9]{16,}\b/g;
const DURATION_RE = /\b\d+(?:\.\d+)?(?:ms|s)\b/g;
const WHITESPACE_RE = /\s+/g;

export function normalizeErrorMessage(message) {
  let text = String(message ?? '');
  text = text.replace(JSON_TAIL_RE, '{...}');
  text = text.replace(UUID_RE, '{uuid}');
  text = text.replace(HEX_ADDR_RE, '{addr}');
  for (const re of TMP_PATH_RES) {
    text = text.replace(re, '{tmp}');
  }
  text = text.replace(WORKFLOW_ID_RE, '{wf}');
  text = text.replace(HEX_RUN_RE, '{hex}');
  text = text.replace(LONG_ID_RE, '{id}');
  text = text.replace(DURATION_RE, '{dur}');
  text = text.replace(WHITESPACE_RE, ' ');
  return text.trim();
}

function slugify(value, maxLength = 72) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return (slug || 'ci-job').slice(0, maxLength).replace(/-+$/g, '') || 'ci-job';
}

export function errorFingerprint(message, maxLen = 72) {
  const normalized = normalizeErrorMessage(message).slice(0, 120);
  return slugify(normalized, maxLen);
}
