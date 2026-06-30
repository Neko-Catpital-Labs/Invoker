import type { FormEvent } from 'react';

export type InvokerTerminalLineKind = 'system' | 'command' | 'success' | 'error';

export interface InvokerTerminalLine {
  id: string;
  kind: InvokerTerminalLineKind;
  text: string;
}

interface InvokerTerminalProps {
  lines: InvokerTerminalLine[];
  input: string;
  busy: boolean;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
}

const LINE_CLASS_BY_KIND: Record<InvokerTerminalLineKind, string> = {
  system: 'text-gray-400',
  command: 'text-cyan-100',
  success: 'text-emerald-200',
  error: 'text-red-200',
};

const PROMPT_BY_KIND: Record<InvokerTerminalLineKind, string> = {
  system: 'invoker',
  command: '$',
  success: 'ok',
  error: 'error',
};

export function InvokerTerminal({
  lines,
  input,
  busy,
  onInputChange,
  onSubmit,
}: InvokerTerminalProps): JSX.Element {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <section
      data-testid="invoker-terminal"
      className="flex min-h-[220px] flex-col overflow-hidden rounded-lg border border-gray-800 bg-[#080b10]"
    >
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-100">Invoker Terminal</h2>
          <p className="mt-0.5 text-xs text-gray-500">Plan from a goal, then run when ready.</p>
        </div>
        {busy && (
          <div role="status" className="rounded border border-amber-700/60 px-2 py-1 text-[11px] text-amber-200">
            Planning
          </div>
        )}
      </div>

      <div
        role="log"
        aria-live="polite"
        data-testid="invoker-terminal-transcript"
        className="min-h-0 flex-1 space-y-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-5"
      >
        {lines.map((line) => (
          <div key={line.id} className={`flex gap-2 ${LINE_CLASS_BY_KIND[line.kind]}`}>
            <span className="w-12 shrink-0 select-none text-gray-600">{PROMPT_BY_KIND[line.kind]}</span>
            <span className="min-w-0 flex-1 break-words">{line.text}</span>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-gray-800 px-3 py-3">
        <span className="font-mono text-xs text-gray-500">$</span>
        <input
          aria-label="Invoker terminal input"
          value={input}
          disabled={busy}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder='plan "Add README"'
          className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-cyan-500 disabled:cursor-wait disabled:opacity-70"
        />
        <button
          type="submit"
          disabled={busy || input.trim().length === 0}
          className="rounded border border-cyan-700 bg-cyan-950 px-3 py-2 text-xs font-medium text-cyan-100 hover:bg-cyan-900 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600"
        >
          Send
        </button>
      </form>
    </section>
  );
}
