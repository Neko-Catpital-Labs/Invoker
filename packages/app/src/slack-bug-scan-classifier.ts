import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { SlackBugScanClassifier } from '@invoker/execution-engine';

const MAX_THREAD_TEXT_CHARS = 20_000;

const ClassificationSchema = z.object({
  isBugComplaint: z.boolean(),
  problemStatement: z.string(),
});

export function createSlackBugScanClassifier(client: Anthropic = new Anthropic()): SlackBugScanClassifier {
  return async ({ repoUrl, threadText }) => {
    const truncated = threadText.length > MAX_THREAD_TEXT_CHARS
      ? threadText.slice(-MAX_THREAD_TEXT_CHARS)
      : threadText;
    const response = await client.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 1024,
      output_config: { effort: 'low', format: zodOutputFormat(ClassificationSchema) },
      messages: [{
        role: 'user',
        content: [
          `You are triaging a Slack thread about the repo ${repoUrl} to decide whether it contains`,
          'a genuine bug complaint that should become an Invoker task.',
          '',
          'Thread:',
          truncated,
          '',
          'If this is a real bug complaint, set isBugComplaint true and write problemStatement as a',
          'concise, actionable bug description an engineer could act on. If it is not a bug complaint',
          '(a question, casual chat, or a feature request), set isBugComplaint false and leave',
          'problemStatement empty.',
        ].join('\n'),
      }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return { isBugComplaint: false };
    }
    return {
      isBugComplaint: response.parsed_output.isBugComplaint,
      problemStatement: response.parsed_output.problemStatement || undefined,
    };
  };
}
