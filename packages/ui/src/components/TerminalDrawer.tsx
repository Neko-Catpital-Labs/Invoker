interface TerminalDrawerProps {
  collapsed: boolean;
  onToggle: () => void;
}

function TerminalToggleIcon({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      <path d="M3 3.5h10v9H3z" />
      {collapsed ? <path d="M5.5 9 8 6.5 10.5 9" /> : <path d="M5.5 7 8 9.5 10.5 7" />}
    </svg>
  );
}

export function TerminalDrawer({ collapsed, onToggle }: TerminalDrawerProps): JSX.Element {
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
          className="inline-flex h-7 w-7 items-center justify-center rounded border border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
          aria-label={collapsed ? 'Expand terminal drawer' : 'Minimize terminal drawer'}
          title={collapsed ? 'Expand terminal drawer' : 'Minimize terminal drawer'}
        >
          <TerminalToggleIcon collapsed={collapsed} />
        </button>
      </div>
      {!collapsed && (
        <div className="h-40 px-3 py-2 text-xs text-gray-400 overflow-auto">
          Terminal drawer reserved for embedded shell/log surfaces.
        </div>
      )}
    </div>
  );
}
