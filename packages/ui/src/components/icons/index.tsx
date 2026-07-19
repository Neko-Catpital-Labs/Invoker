import type { JSX, SVGProps } from 'react';
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

export function SendIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      aria-hidden={props['aria-hidden'] ?? 'true'}
      viewBox="0 0 20 20"
      fill="currentColor"
      {...props}
    >
      <path d="M2.23 3.27a.75.75 0 0 1 .8-.12l14 6a.75.75 0 0 1 0 1.38l-14 6A.75.75 0 0 1 2 15.84V11l7.24-1L2 9V4.16a.75.75 0 0 1 .23-.89Z" />
    </svg>
  );
}
