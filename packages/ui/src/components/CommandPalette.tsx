import { useMemo, useCallback, type JSX } from 'react';
import { AlertTriangle, Clock, GitBranch, Home, Layers, Settings, Terminal } from 'lucide-react';
import type { TaskState, WorkflowMeta } from '../types.js';
import type { SidebarSurface } from '../lib/workflow-progress-surfaces.js';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  Dialog,
  DialogContent,
  DialogTitle,
} from './primitives/index.js';
import {
  getAttentionTaskEntries,
  getRunningTaskEntries,
  getSortedWorkflows,
} from '../lib/workflow-progress-surfaces.js';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflows: Map<string, WorkflowMeta>;
  tasks: Map<string, TaskState>;
  onSelectSurface: (surface: SidebarSurface) => void;
  onSelectWorkflow: (workflowId: string) => void;
  onSelectTask: (taskId: string) => void;
  onOpenSettings: () => void;
  planningSessionCount: number;
}

const MAX_ROWS_PER_GROUP = 8;

export function CommandPalette({
  open,
  onOpenChange,
  workflows,
  tasks,
  onSelectSurface,
  onSelectWorkflow,
  onSelectTask,
  onOpenSettings,
  planningSessionCount,
}: CommandPaletteProps): JSX.Element {
  const workflowEntries = useMemo(() => getSortedWorkflows(workflows, tasks).slice(0, MAX_ROWS_PER_GROUP), [workflows, tasks]);
  const attentionEntries = useMemo(() => getAttentionTaskEntries(tasks, workflows).slice(0, MAX_ROWS_PER_GROUP), [tasks, workflows]);
  const runningEntries = useMemo(() => getRunningTaskEntries(tasks, workflows, null).slice(0, MAX_ROWS_PER_GROUP), [tasks, workflows]);

  const closeAnd = useCallback(
    (fn: () => void) => () => {
      fn();
      onOpenChange(false);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl gap-0 p-0 overflow-hidden"
        hideCloseButton
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command loop shouldFilter>
          <CommandInput placeholder="Jump to workflow, task, or view…" autoFocus />
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
                {attentionEntries.length > 0 && <CommandShortcut>{attentionEntries.length}</CommandShortcut>}
              </CommandItem>
              <CommandItem value="workflows browser" onSelect={closeAnd(() => onSelectSurface('workflows'))}>
                <Layers strokeWidth={1.75} />
                <span>Workflows</span>
                {workflowEntries.length > 0 && <CommandShortcut>{workflowEntries.length}</CommandShortcut>}
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
      </DialogContent>
    </Dialog>
  );
}
