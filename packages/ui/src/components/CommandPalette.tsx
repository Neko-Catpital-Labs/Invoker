import { memo, useCallback, useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import { AlertTriangle, Clock, GitBranch, Home, Layers, Settings, Terminal } from 'lucide-react';
import type { SidebarSurface, WorkflowListEntry, WorkflowTaskEntry } from '../lib/workflow-progress-surfaces.js';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from './primitives/index.js';

export const COMMAND_PALETTE_MAX_ROWS = 8;

const EDITABLE_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '.xterm',
  '[role="dialog"] input',
  '[role="dialog"] textarea',
].join(',');

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(EDITABLE_SELECTOR));
}

export interface CommandPaletteProps {
  enabled?: boolean;
  defaultOpen?: boolean;
  workflowEntries: WorkflowListEntry[];
  attentionEntries: WorkflowTaskEntry[];
  runningEntries: WorkflowTaskEntry[];
  workflowCount: number;
  attentionCount: number;
  onSelectSurface: (surface: SidebarSurface) => void;
  onSelectWorkflow: (workflowId: string) => void;
  onSelectTask: (taskId: string) => void;
  onOpenSettings: () => void;
  planningSessionCount: number;
}

interface CommandPaletteBodyProps {
  inputRef: RefObject<HTMLInputElement | null>;
  close: () => void;
  workflowEntries: WorkflowListEntry[];
  attentionEntries: WorkflowTaskEntry[];
  runningEntries: WorkflowTaskEntry[];
  workflowCount: number;
  attentionCount: number;
  onSelectSurface: (surface: SidebarSurface) => void;
  onSelectWorkflow: (workflowId: string) => void;
  onSelectTask: (taskId: string) => void;
  onOpenSettings: () => void;
  planningSessionCount: number;
}

const CommandPaletteBody = memo(function CommandPaletteBody({
  inputRef,
  close,
  workflowEntries,
  attentionEntries,
  runningEntries,
  workflowCount,
  attentionCount,
  onSelectSurface,
  onSelectWorkflow,
  onSelectTask,
  onOpenSettings,
  planningSessionCount,
}: CommandPaletteBodyProps): JSX.Element {
  const closeAnd = useCallback(
    (fn: () => void) => () => {
      fn();
      close();
    },
    [close],
  );

  return (
    <div className="w-full max-w-xl overflow-hidden rounded-lg border border-border-strong bg-card text-card-foreground shadow-lg">
      <Command loop shouldFilter>
        <CommandInput
          ref={inputRef}
          placeholder="Jump to workflow, task, or view…"
        />
        <CommandList>
          <CommandEmpty>No matches.</CommandEmpty>

          <CommandGroup heading="Navigate">
            <CommandItem value="home go home" onSelect={closeAnd(() => onSelectSurface('home'))}>
              <Home strokeWidth={1.75} />
              <span>Go home</span>
            </CommandItem>
            <CommandItem value="planning terminal" onSelect={closeAnd(() => onSelectSurface('planning'))}>
              <Terminal strokeWidth={1.75} />
              <span>Planning Terminal</span>
              {planningSessionCount > 0 && <CommandShortcut>{planningSessionCount}</CommandShortcut>}
            </CommandItem>
            <CommandItem value="needs attention" onSelect={closeAnd(() => onSelectSurface('attention'))}>
              <AlertTriangle strokeWidth={1.75} />
              <span>Needs Attention</span>
              {attentionCount > 0 && <CommandShortcut>{attentionCount}</CommandShortcut>}
            </CommandItem>
            <CommandItem value="workflows browser" onSelect={closeAnd(() => onSelectSurface('workflows'))}>
              <Layers strokeWidth={1.75} />
              <span>Workflows</span>
              {workflowCount > 0 && <CommandShortcut>{workflowCount}</CommandShortcut>}
            </CommandItem>
            <CommandItem value="open settings" onSelect={closeAnd(onOpenSettings)}>
              <Settings strokeWidth={1.75} />
              <span>Settings</span>
            </CommandItem>
          </CommandGroup>

          {attentionEntries.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Needs attention">
                {attentionEntries.map(({ task }) => (
                  <CommandItem
                    key={`attention:${task.id}`}
                    value={`attention ${task.id} ${task.description ?? ''}`}
                    onSelect={closeAnd(() => onSelectTask(task.id))}
                  >
                    <AlertTriangle strokeWidth={1.75} className="text-amber-300" />
                    <span className="truncate">{task.description ?? task.id}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {runningEntries.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Running">
                {runningEntries.map(({ task }) => (
                  <CommandItem
                    key={`running:${task.id}`}
                    value={`running ${task.id} ${task.description ?? ''}`}
                    onSelect={closeAnd(() => onSelectTask(task.id))}
                  >
                    <Clock strokeWidth={1.75} className="text-foreground" />
                    <span className="truncate">{task.description ?? task.id}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {workflowEntries.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Workflows">
                {workflowEntries.map(({ workflow }) => (
                  <CommandItem
                    key={`workflow:${workflow.id}`}
                    value={`workflow ${workflow.id} ${workflow.name}`}
                    onSelect={closeAnd(() => onSelectWorkflow(workflow.id))}
                  >
                    <GitBranch strokeWidth={1.75} />
                    <span className="truncate">{workflow.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </div>
  );
});

export function CommandPalette({
  enabled = true,
  defaultOpen = false,
  workflowEntries,
  attentionEntries,
  runningEntries,
  workflowCount,
  attentionCount,
  onSelectSurface,
  onSelectWorkflow,
  onSelectTask,
  onOpenSettings,
  planningSessionCount,
}: CommandPaletteProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
        if (!enabled && !open) return;
        if (!open && isEditableKeyboardTarget(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen((prev) => !prev);
        return;
      }
      if (open && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [close, enabled, open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div
      role="dialog"
      aria-modal={open}
      aria-label="Command palette"
      aria-hidden={!open}
      data-testid="command-palette"
      data-state={open ? 'open' : 'closed'}
      className={[
        'fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-[18vh]',
        open ? '' : 'hidden',
      ].join(' ')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <CommandPaletteBody
        inputRef={inputRef}
        close={close}
        workflowEntries={workflowEntries}
        attentionEntries={attentionEntries}
        runningEntries={runningEntries}
        workflowCount={workflowCount}
        attentionCount={attentionCount}
        onSelectSurface={onSelectSurface}
        onSelectWorkflow={onSelectWorkflow}
        onSelectTask={onSelectTask}
        onOpenSettings={onOpenSettings}
        planningSessionCount={planningSessionCount}
      />
    </div>
  );
}
