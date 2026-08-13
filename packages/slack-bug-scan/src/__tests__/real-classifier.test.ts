import { describe, expect, it, vi } from 'vitest';
import { createSlackBugScanClassifier } from '../real-classifier.js';

function makeAnthropicStub(parse: (args: any) => Promise<any>) {
  return { messages: { parse: vi.fn(parse) } } as any;
}

describe('createSlackBugScanClassifier', () => {
  it('returns the parsed classification for a real bug complaint', async () => {
    const anthropic = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      parsed_output: { isBugComplaint: true, problemStatement: 'Login button throws a 500' },
    }));
    const classify = createSlackBugScanClassifier(anthropic);

    const result = await classify({
      channelId: 'C1', threadTs: '1.0', repoUrl: 'git@github.com:acme/widgets.git', threadText: 'the login button is broken',
    });

    expect(result).toEqual({ isBugComplaint: true, problemStatement: 'Login button throws a 500' });
  });

  it('includes the repo url and thread text in the prompt sent to Claude', async () => {
    const anthropic = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      parsed_output: { isBugComplaint: false, problemStatement: '' },
    }));
    const classify = createSlackBugScanClassifier(anthropic);

    await classify({ channelId: 'C1', threadTs: '1.0', repoUrl: 'git@github.com:acme/widgets.git', threadText: 'some thread text' });

    const call = (anthropic.messages.parse as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toBe('claude-opus-5');
    const promptText = call.messages[0].content;
    expect(promptText).toContain('git@github.com:acme/widgets.git');
    expect(promptText).toContain('some thread text');
  });

  it('treats an empty problemStatement as undefined', async () => {
    const anthropic = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      parsed_output: { isBugComplaint: false, problemStatement: '' },
    }));
    const classify = createSlackBugScanClassifier(anthropic);

    const result = await classify({ channelId: 'C1', threadTs: '1.0', repoUrl: 'repo', threadText: 'hi' });

    expect(result).toEqual({ isBugComplaint: false, problemStatement: undefined });
  });

  it('treats a refusal stop reason as not a bug complaint', async () => {
    const anthropic = makeAnthropicStub(async () => ({
      stop_reason: 'refusal',
      parsed_output: { isBugComplaint: true, problemStatement: 'should be ignored' },
    }));
    const classify = createSlackBugScanClassifier(anthropic);

    const result = await classify({ channelId: 'C1', threadTs: '1.0', repoUrl: 'repo', threadText: 'hi' });

    expect(result).toEqual({ isBugComplaint: false });
  });

  it('treats a missing parsed_output as not a bug complaint', async () => {
    const anthropic = makeAnthropicStub(async () => ({ stop_reason: 'end_turn', parsed_output: undefined }));
    const classify = createSlackBugScanClassifier(anthropic);

    const result = await classify({ channelId: 'C1', threadTs: '1.0', repoUrl: 'repo', threadText: 'hi' });

    expect(result).toEqual({ isBugComplaint: false });
  });

  it('truncates very long thread text to the last 20,000 characters', async () => {
    const anthropic = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      parsed_output: { isBugComplaint: false, problemStatement: '' },
    }));
    const classify = createSlackBugScanClassifier(anthropic);
    const longText = `${'a'.repeat(25_000)}TAIL_MARKER`;

    await classify({ channelId: 'C1', threadTs: '1.0', repoUrl: 'repo', threadText: longText });

    const call = (anthropic.messages.parse as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const promptText: string = call.messages[0].content;
    expect(promptText).toContain('TAIL_MARKER');
    const threadSection = promptText.split('Thread:\n')[1];
    expect(threadSection.length).toBeLessThan(25_000);
  });
});
