import { useEffect, useRef, useState } from 'react';

export interface InvokerTerminalLine {
  id: number;
  text: string;
  tone?: 'muted' | 'error' | 'success';
}

interface InvokerTerminalProps {
  lines: InvokerTerminalLine[];
  busy: boolean;
  onSubmit: (command: string) => void;
}

export function InvokerTerminal({ lines, busy, onSubmit }: InvokerTerminalProps): JSX.Element {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-950 shadow-inner">
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2">
        <div>
          <h1 className="text-sm font-semibold text-gray-100">Invoker Terminal</h1>
          <p className="text-xs text-gray-500">Plan from a goal, then run it.</p>
        </div>
        {busy && <span className="text-xs text-blue-300">Working…</span>}
      </div>
      <div data-testid="invoker-terminal-transcript" className="max-h-36 space-y-1 overflow-y-auto px-4 py-3 font-mono text-xs">
        {lines.map((line) => {
          const toneClass = line.tone === 'error'
            ? 'text-red-300'
            : line.tone === 'success'
              ? 'text-emerald-300'
              : 'text-gray-300';
          return (
            <div key={line.id} className={toneClass}>
              {line.text}
            </div>
          );
        })}
      </div>
      <form
        className="flex items-center gap-2 border-t border-gray-800 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          const command = value.trim();
          if (!command || busy) return;
          onSubmit(command);
          setValue('');
        }}
      >
        <span className="font-mono text-xs text-gray-500">$</span>
        <input
          ref={inputRef}
          data-testid="invoker-terminal-input"
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          placeholder='plan "Add README" or run'
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-gray-100 outline-none placeholder:text-gray-600 disabled:cursor-wait"
        />
      </form>
    </section>
  );
}
