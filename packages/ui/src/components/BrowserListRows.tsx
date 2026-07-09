import { memo } from 'react';

export type BrowserTaskRowTone = 'attention' | 'running';

interface BrowserTaskRowProps {
  taskId: string;
  title: string;
  workflowName?: string;
  statusLabel: string;
  tone: BrowserTaskRowTone;
  selected: boolean;
  onSelect: (taskId: string) => void;
}

export const BrowserTaskRow = memo(function BrowserTaskRow({
  taskId,
  title,
  workflowName,
  statusLabel,
  tone,
  selected,
  onSelect,
}: BrowserTaskRowProps) {
  const accent = tone === 'attention'
    ? selected ? 'bg-amber-500/15 text-amber-100 ring-1 ring-amber-500/40' : 'text-foreground hover:bg-accent/30'
    : selected ? 'bg-accent/60 text-accent-foreground ring-1 ring-border-strong' : 'text-foreground hover:bg-accent/30';
  return (
    <button
      type="button"
      onClick={() => onSelect(taskId)}
      className={`block w-full rounded-md px-2.5 py-1.5 text-left transition-colors ${accent}`}
    >
      <div className="truncate text-body font-medium">{title}</div>
      <div className="mt-0.5 truncate text-caption text-muted-foreground">
        {statusLabel}
        {workflowName ? ` · ${workflowName}` : ''}
      </div>
    </button>
  );
});

interface BrowserWorkflowRowProps {
  workflowId: string;
  name: string;
  taskCount: number;
  statusLabel: string;
  selected: boolean;
  onSelect: (workflowId: string) => void;
}

export const BrowserWorkflowRow = memo(function BrowserWorkflowRow({
  workflowId,
  name,
  taskCount,
  statusLabel,
  selected,
  onSelect,
}: BrowserWorkflowRowProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(workflowId)}
      className={`block w-full rounded-md px-2.5 py-1.5 text-left transition-colors ${selected ? 'bg-accent/60 text-accent-foreground ring-1 ring-border-strong' : 'text-foreground hover:bg-accent/30'}`}
    >
      <div className="truncate text-body font-medium">{name}</div>
      <div className="mt-0.5 truncate text-caption text-muted-foreground">
        {statusLabel}
        {taskCount > 0 ? ` · ${taskCount} task${taskCount === 1 ? '' : 's'}` : ''}
      </div>
    </button>
  );
});
