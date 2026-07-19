import type { JSX } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Compass,
  Cpu,
  GitMerge,
  GitPullRequest,
  Layers,
  Moon,
  Network,
  Play,
  Settings,
  Sun,
  TerminalSquare,
  type LucideProps,
} from 'lucide-react';

const DEFAULT_STROKE_WIDTH = 1.75;

function withDefaults<C extends React.FC<LucideProps>>(Icon: C, defaults?: LucideProps) {
  return function InvokerIcon(props: LucideProps): JSX.Element {
    return (
      <Icon
        strokeWidth={DEFAULT_STROKE_WIDTH}
        aria-hidden={props['aria-hidden'] ?? 'true'}
        {...defaults}
        {...props}
      />
    );
  };
}

export const AttentionIcon = withDefaults(AlertTriangle);
export const RunningIcon = withDefaults(Clock);
export const WorkerIcon = withDefaults(Cpu);
export const WorkflowsIcon = withDefaults(Layers);
export const GraphIcon = withDefaults(Network);
export const PlanningTerminalIcon = withDefaults(TerminalSquare);
export const SettingsIcon = withDefaults(Settings);
export const InvokerIcon = withDefaults(Compass);
export const ChevronLeftIcon = withDefaults(ChevronLeft);
export const ChevronRightIcon = withDefaults(ChevronRight);
export const ChevronDownIcon = withDefaults(ChevronDown);
export const PlayIcon = withDefaults(Play);
export const GitPullRequestIcon = withDefaults(GitPullRequest);
export const GitMergeIcon = withDefaults(GitMerge);
export const SunIcon = withDefaults(Sun);
export const MoonIcon = withDefaults(Moon);
