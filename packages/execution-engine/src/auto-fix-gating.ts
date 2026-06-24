export function shouldSkipAutoFixForError(errorText: unknown): boolean {
  if (typeof errorText !== 'string') {
    return false;
  }
  return errorText.startsWith('Cancelled by user') || errorText.startsWith('Cancelled:')
    || errorText.startsWith('Terminated by user') || errorText.startsWith('Terminated:');
}
