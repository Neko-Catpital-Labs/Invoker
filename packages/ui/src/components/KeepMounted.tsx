/**
 * KeepMounted — mounts its children the first time `active` becomes true,
 * then never unmounts them again; only toggles CSS visibility after that.
 *
 * For stateful children (a live xterm.js terminal backed by a real PTY,
 * for example) a plain `active ? <X/> : null` conditional destroys and
 * recreates the child every time `active` flips, losing all live state.
 * This mirrors the display-toggle pattern already used correctly by
 * TerminalDrawer's own per-session panes (TerminalDrawer.tsx).
 */

import { useRef, type ReactNode } from 'react';

interface KeepMountedProps {
  active: boolean;
  className?: string;
  children: ReactNode;
}

export function KeepMounted({ active, className, children }: KeepMountedProps): JSX.Element | null {
  const hasActivatedRef = useRef(active);
  if (active) hasActivatedRef.current = true;
  if (!hasActivatedRef.current) return null;

  return (
    <div className={className} style={active ? undefined : { display: 'none' }}>
      {children}
    </div>
  );
}
