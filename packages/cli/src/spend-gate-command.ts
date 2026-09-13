import {
  clearCodexSpendGateTrip,
  codexSpendGateBlockMessage,
  defaultCodexSpendGatePath,
  loadCodexSpendGateTrip,
} from '@invoker/execution-engine';

export interface SpendGateCommandDeps {
  statePath?: string;
  write?: (text: string) => void;
}

export function runSpendGateCommand(argv: readonly string[], deps: SpendGateCommandDeps = {}): number {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const statePath = deps.statePath ?? defaultCodexSpendGatePath();
  const subcommand = argv[0] ?? 'status';

  if (subcommand !== 'status' && subcommand !== 'reset') {
    throw new Error('Unknown spend-gate command. Usage: invoker-cli spend-gate [status|reset]');
  }

  const trip = loadCodexSpendGateTrip(statePath);

  if (subcommand === 'status') {
    if (!trip) {
      write(`Codex daily spend gate: open (no trip recorded at ${statePath}).\n`);
      return 0;
    }
    write(`${codexSpendGateBlockMessage(trip, statePath)}\n`);
    return 1;
  }

  if (!trip) {
    write(`Codex daily spend gate was already open (no trip recorded at ${statePath}).\n`);
    return 0;
  }
  clearCodexSpendGateTrip(statePath);
  write(
    `Cleared the Codex daily spend gate trip from ${trip.trippedAt} (${trip.observedTokens} tokens on ${trip.dayKey}). Codex requests are allowed again.\n`,
  );
  return 0;
}
