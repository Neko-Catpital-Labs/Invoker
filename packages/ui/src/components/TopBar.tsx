/**
 * TopBar — Persistent toolbar for plan loading and workflow control.
 *
 * Always visible at the top of the app. Contains:
 * - File picker to load YAML/JSON plans
 * - Plan name display
 * - Start / Stop / Clear buttons
 */

import { useRef, useState, useEffect } from 'react';
import { parsePlanText } from '../lib/plan-parser.js';

interface TopBarProps {
  planName: string | null;
  hasLoadedPlan: boolean;
  hasStarted: boolean;
  allSettled: boolean;
  onLoadFile: (planText: string) => void;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  onDeleteDB: () => void;
  onRefresh: () => void;
  viewMode: 'dag' | 'history' | 'timeline' | 'queue';
  onToggleView: (mode: 'dag' | 'history' | 'timeline' | 'queue') => void;
}

export function TopBar({
  planName,
  hasLoadedPlan,
  hasStarted,
  allSettled,
  onLoadFile,
  onStart,
  onStop,
  onClear,
  onDeleteDB,
  onRefresh,
  viewMode,
  onToggleView,
}: TopBarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Close dropdown on click-outside or Escape
  useEffect(() => {
    if (!isDropdownOpen) return;

    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isDropdownOpen]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const dotIndex = file.name.lastIndexOf('.');
    const ext = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : undefined;

    try {
      parsePlanText(text, ext);
      onLoadFile(text);
    } catch (err) {
      console.error('Failed to parse plan file:', err);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const showStart = hasLoadedPlan && !hasStarted;
  const showStop = hasStarted && !allSettled;

  const handleDeleteDB = () => {
    onDeleteDB();
    setIsDropdownOpen(false);
  };

  const handleRefresh = () => {
    onRefresh();
    setIsDropdownOpen(false);
  };

  const handleClear = () => {
    onClear();
    setIsDropdownOpen(false);
  };

  return (
    <div className="h-12 bg-gray-800 border-b border-gray-700 flex items-center px-4 gap-3 shrink-0">
      {/* Left: File picker + plan name */}
      <label className="px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded text-xs font-medium transition-colors cursor-pointer">
        Open File
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.yaml,.yml"
          onChange={handleFileSelect}
          className="hidden"
        />
      </label>

      {planName && (
        <span className="text-sm text-gray-300 font-medium truncate max-w-xs">
          {planName}
        </span>
      )}

      <div className="flex rounded overflow-hidden border border-gray-600">
        {(['dag', 'timeline', 'history', 'queue'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => onToggleView(mode)}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              viewMode === mode
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
            }`}
          >
            {mode === 'dag' ? 'DAG' : mode === 'timeline' ? 'Timeline' : mode === 'history' ? 'History' : 'Queue'}
          </button>
        ))}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: Action buttons */}
      {showStart && (
        <button
          onClick={onStart}
          className="px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white rounded text-xs font-medium transition-colors"
        >
          Start
        </button>
      )}

      {showStop && (
        <button
          onClick={onStop}
          className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded text-xs font-medium transition-colors"
        >
          Stop
        </button>
      )}

      {/* Utility dropdown */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          className="px-2 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded text-xs font-medium transition-colors"
          aria-label="Utility menu"
          title="Utility menu"
        >
          •••
        </button>

        {isDropdownOpen && (
          <div
            className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[200px] z-50"
            role="menu"
          >
            <button
              role="menuitem"
              onClick={handleRefresh}
              className="w-full text-left px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-700"
              title="Force refresh task graph from main process"
            >
              Refresh
            </button>
            <button
              role="menuitem"
              onClick={handleClear}
              className="w-full text-left px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-700"
            >
              Clear Session
            </button>

            <div className="border-t border-gray-600 my-1" />

            <button
              role="menuitem"
              disabled
              className="w-full text-left px-3 py-1.5 text-sm text-gray-500 cursor-not-allowed"
            >
              Export Logs...
            </button>
            <button
              role="menuitem"
              disabled
              className="w-full text-left px-3 py-1.5 text-sm text-gray-500 cursor-not-allowed"
            >
              Settings...
            </button>

            <div className="border-t border-gray-600 my-1">
              <div className="text-xs text-gray-500 text-center py-1">Danger Zone</div>
            </div>

            <button
              role="menuitem"
              onClick={handleDeleteDB}
              className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-gray-700"
            >
              Delete Workflow History (DB)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
