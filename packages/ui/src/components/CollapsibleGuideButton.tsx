import { useState } from 'react';

interface CollapsibleGuideButtonProps {
  title?: string;
  items: string[];
}

export function CollapsibleGuideButton({
  title = 'Guide',
  items,
}: CollapsibleGuideButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div
      data-testid="collapsible-guide"
      className="fixed bottom-4 right-4 z-40 w-[min(20rem,calc(100vw-2rem))] text-slate-200"
    >
      {open ? (
        <div className="rounded-md border border-slate-700 bg-slate-950/95 p-3 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">{title}</div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-slate-500 hover:bg-slate-900"
              aria-label="Collapse guide"
            >
              Collapse
            </button>
          </div>
          <ol className="mt-3 space-y-2 text-xs leading-5 text-slate-400">
            {items.map((item, index) => (
              <li key={item} className="flex gap-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-blue-400/40 bg-blue-500/10 text-[10px] font-semibold text-blue-200">
                  {index + 1}
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <button
          type="button"
          data-testid="collapsible-guide-toggle"
          onClick={() => setOpen(true)}
          className="ml-auto flex rounded-md border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs font-medium text-slate-200 shadow-2xl shadow-black/35 backdrop-blur hover:border-slate-500 hover:bg-slate-900"
        >
          {title}
        </button>
      )}
    </div>
  );
}
