export function uniqueWorkKeys(keys: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const key of keys) {
    const normalized = key?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

export function singleWorkKey(key: string): () => string[] {
  return () => [key];
}
