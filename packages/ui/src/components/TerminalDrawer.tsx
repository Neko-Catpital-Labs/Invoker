import type { ReactElement, ReactNode } from 'react';

interface TerminalDrawerProps {
  collapsed: boolean;
  onToggle: () => void;
  children?: ReactNode;
}

export function TerminalDrawer({ collapsed, onToggle, children }: TerminalDrawerProps): ReactElement {
  return (
    <div className="border-t border-gray-800 bg-gray-950">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="flex items-center gap-3 text-xs text-gray-300">
          <button className="hover:text-white">Terminal</button>
          <button className="hover:text-white">Logs</button>
          <button className="hover:text-white">Problems</button>
        </div>
        <button
          onClick={onToggle}
          aria-label={collapsed ? 'Expand terminal drawer' : 'Collapse terminal drawer'}
          className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
        >
          {collapsed ? 'Expand' : 'Minimize'}
        </button>
      </div>
      {!collapsed && (
        <div className="h-64 px-3 py-2 text-xs text-gray-400 overflow-auto">
          {children ?? 'Terminal drawer reserved for embedded shell/log surfaces.'}
        </div>
      )}
    </div>
  );
}
