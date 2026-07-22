export type PlanningRole = 'user' | 'assistant' | 'system';

export interface PlanningMessage {
  role: PlanningRole;
  content: string;
}

export type PlanningState = 'discussing' | 'awaiting_answer' | 'draft_ready' | 'submitted';

export interface PlanningTurnResult {
  state: PlanningState;
  draftingAuthorized: boolean;
}

function normalized(text: string): string {
  return text.trim().toLowerCase();
}

export function hasExplicitDraftIntent(message: string): boolean {
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

export function derivePlanningTurnResult(
  message: string,
  messagesBeforeTurn: readonly PlanningMessage[],
  response: { hasDraft: boolean; asksQuestion: boolean; submitted: boolean },
): PlanningTurnResult {
  const draftingAuthorized = isDraftingAuthorized(message, messagesBeforeTurn);
  if (response.submitted) return { state: 'submitted', draftingAuthorized };
  if (response.hasDraft && draftingAuthorized) return { state: 'draft_ready', draftingAuthorized };
  return {
    state: response.asksQuestion ? 'awaiting_answer' : 'discussing',
    draftingAuthorized,
  };
}

export class SerializedPlanningTurns {
  private pending: Promise<void> = Promise.resolve();

  async run<T>(turn: () => Promise<T>): Promise<T> {
    const next = this.pending.then(turn);
    this.pending = next.then(() => undefined, () => undefined);
    return await next;
  }
}

export interface PlanningRunner {
  sendMessage(message: string): Promise<string>;
  getDraftedPlan(): string | null;
  readonly planSubmitted: boolean;
}

export interface PlanningSessionTurn {
  reply: string;
  state: PlanningState;
  draftingAuthorized: boolean;
}

export class PlanningSession {
  private readonly turns = new SerializedPlanningTurns();
  private readonly messages: PlanningMessage[] = [];

  constructor(private readonly runner: PlanningRunner) {}

  get history(): readonly PlanningMessage[] {
    return this.messages;
  }

  async send(message: string): Promise<PlanningSessionTurn> {
    return await this.turns.run(async () => {
      const messagesBeforeTurn = [...this.messages];
      const draftingAuthorized = isDraftingAuthorized(message, messagesBeforeTurn);
      this.messages.push({ role: 'user', content: message });
      const reply = await this.runner.sendMessage(message);
      this.messages.push({ role: 'assistant', content: reply });
      const result = derivePlanningTurnResult(message, messagesBeforeTurn, {
        hasDraft: this.runner.getDraftedPlan() !== null,
        asksQuestion: reply.includes('?'),
        submitted: this.runner.planSubmitted,
      });
      return { reply, state: result.state, draftingAuthorized };
    });
  }
}
