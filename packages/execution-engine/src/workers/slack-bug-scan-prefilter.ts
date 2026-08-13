const COMPLAINT_PATTERN = /\b(broken|breaks|bug|crash(?:es|ed|ing)?|error|fail(?:s|ed|ing)?|hang(?:s|ing)?|missing|never|not working|doesn'?t work|stuck|silent|wrong|regression|timeout|timed out|cannot|can'?t|unable)\b/i;

export function looksLikeBugComplaint(text: string): boolean {
  return COMPLAINT_PATTERN.test(text);
}
