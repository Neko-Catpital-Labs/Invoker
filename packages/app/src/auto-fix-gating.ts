export function shouldSkipAutoFixForError(errorText: unknown): boolean {
  if (typeof errorText !== 'string') {
    return false;
  }
  return errorText.startsWith('Cancelled by user') || errorText.startsWith('Cancelled:')
    || errorText.startsWith('Terminated by user') || errorText.startsWith('Terminated:');
}

type FailureInfoLike = {
  category?: unknown;
  stage?: unknown;
};

type FailureSnapshot = {
  error?: unknown;
  failureInfo?: FailureInfoLike;
};

export function shouldSkipAutoFixForFailure(snapshot: FailureSnapshot | undefined): boolean {
  if (!snapshot) return false;
  if (shouldSkipAutoFixForError(snapshot.error)) return true;
  const category = typeof snapshot.failureInfo?.category === 'string' ? snapshot.failureInfo.category : undefined;
  const stage = typeof snapshot.failureInfo?.stage === 'string' ? snapshot.failureInfo.stage : undefined;
  return category === 'infra' && (stage === 'provisioning' || stage === 'setup_branch');
}
