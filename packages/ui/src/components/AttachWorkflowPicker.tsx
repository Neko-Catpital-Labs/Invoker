import { useEffect, useRef, type JSX } from 'react';
import { GitBranch } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './primitives/index.js';

export interface AttachWorkflowPickerEntry {
  id: string;
  name: string;
}

export interface AttachWorkflowPickerProps {
  open: boolean;
  downstreamName: string;
  entries: AttachWorkflowPickerEntry[];
  onSelect: (upstreamWorkflowId: string) => void;
  onClose: () => void;
}

export function AttachWorkflowPicker({
  open,
  downstreamName,
  entries,
  onSelect,
  onClose,
}: AttachWorkflowPickerProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose]);

  return (
    <div
      role="dialog"
      aria-modal={open}
      aria-label={`Attach ${downstreamName} to...`}
      aria-hidden={!open}
      data-testid="attach-workflow-picker"
      data-state={open ? 'open' : 'closed'}
      className={[
        'fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-[18vh]',
        open ? '' : 'hidden',
      ].join(' ')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-border-strong bg-card text-card-foreground shadow-lg">
        <Command loop shouldFilter>
          <CommandInput
            ref={inputRef}
            placeholder={`Attach "${downstreamName}" to which upstream workflow?`}
          />
          <CommandList>
            <CommandEmpty>No matching workflows.</CommandEmpty>
            <CommandGroup heading="Workflows">
              {entries.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`${entry.id} ${entry.name}`}
                  onSelect={() => onSelect(entry.id)}
                >
                  <GitBranch strokeWidth={1.75} />
                  <span className="truncate">{entry.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    </div>
  );
}
