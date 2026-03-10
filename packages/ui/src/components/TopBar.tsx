/**
 * TopBar — Persistent toolbar for plan loading and workflow control.
 *
 * Always visible at the top of the app. Contains:
 * - File picker to load YAML/JSON plans
 * - Plan name display
 * - Start / Stop / Clear buttons
 */

import { useRef } from 'react';
import { parsePlanText } from '../lib/plan-parser.js';

interface TopBarProps {
  planName: string | null;
  hasLoadedPlan: boolean;
  hasStarted: boolean;
  allSettled: boolean;
  canResume: boolean;
  onLoadFile: (planText: string) => void;
  onStart: () => void;
  onStop: () => void;
  onResume: () => void;
  onClear: () => void;
  onDeleteDB: () => void;
  onRefresh: () => void;
  viewMode: 'dag' | 'history';
  onToggleView: () => void;
}

export function TopBar({
  planName,
  hasLoadedPlan,
  hasStarted,
  allSettled,
  canResume,
  onLoadFile,
  onStart,
  onStop,
  onResume,
  onClear,
  onDeleteDB,
  onRefresh,
  viewMode,
  onToggleView,
}: TopBarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

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

      <button
        onClick={onToggleView}
        className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
          viewMode === 'history'
            ? 'bg-indigo-600 text-white'
            : 'bg-gray-600 hover:bg-gray-500 text-white'
        }`}
      >
        {viewMode === 'history' ? 'Back to DAG' : 'History'}
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: Action buttons */}
      {canResume && !hasLoadedPlan && (
        <button
          onClick={onResume}
          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-medium transition-colors"
        >
          Resume
        </button>
      )}

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

      <button
        onClick={onRefresh}
        className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 text-white rounded text-xs font-medium transition-colors"
        title="Force refresh task graph from main process"
      >
        Refresh
      </button>

      <button
        onClick={onClear}
        className="px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded text-xs font-medium transition-colors"
      >
        Clear
      </button>

      <button
        onClick={onDeleteDB}
        className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded text-xs font-medium transition-colors"
      >
        Delete DB
      </button>
    </div>
  );
}
