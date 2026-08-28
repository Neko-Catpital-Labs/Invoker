/**
 * VillageView — Invoker tab host for the shared Botvillage canvas.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { WorkerStatusSnapshot } from '../types.js';
import { buildVillageWorld } from '../lib/village-trips.js';
import villageEngineUrl from '../../../botvillage/static/village.js?url';

interface VillageViewProps {
  snapshot: WorkerStatusSnapshot | null;
  remoteTargets?: readonly string[];
  onSelectWorkerKind?: (kind: string | null) => void;
}

type BotvillageHandle = {
  setWorld: (world: unknown) => void;
  select: (kind: string | null) => void;
  destroy: () => void;
};

type BotvillageApi = {
  mount: (
    root: HTMLElement,
    options?: {
      world?: unknown;
      hour?: number | null;
      onSelect?: (kind: string | null) => void;
    },
  ) => BotvillageHandle;
};

declare global {
  interface Window {
    Botvillage?: BotvillageApi;
  }
}

let villageScriptPromise: Promise<void> | null = null;

function loadVillageEngine(): Promise<void> {
  if (window.Botvillage) return Promise.resolve();
  if (villageScriptPromise) return villageScriptPromise;
  villageScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-botvillage-engine]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('botvillage engine failed to load')));
      if (window.Botvillage) resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = villageEngineUrl;
    script.async = true;
    script.dataset.botvillageEngine = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('botvillage engine failed to load'));
    document.head.appendChild(script);
  });
  return villageScriptPromise;
}

export function VillageView({
  snapshot,
  remoteTargets = [],
  onSelectWorkerKind,
}: VillageViewProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<BotvillageHandle | null>(null);
  const onSelectRef = useRef(onSelectWorkerKind);
  onSelectRef.current = onSelectWorkerKind;

  const world = useMemo(
    () => buildVillageWorld(snapshot, { remoteTargets }),
    [snapshot, remoteTargets],
  );

  useEffect(() => {
    let cancelled = false;
    void loadVillageEngine().then(() => {
      if (cancelled || !rootRef.current || !window.Botvillage) return;
      handleRef.current?.destroy();
      handleRef.current = window.Botvillage.mount(rootRef.current, {
        world,
        onSelect: (kind) => onSelectRef.current?.(kind),
      });
    });
    return () => {
      cancelled = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
    // Mount once; world updates go through setWorld.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handleRef.current?.setWorld(world);
  }, [world]);

  return (
    <div
      data-testid="village-surface"
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#070b14]"
    >
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-100">Village</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {world.activeTripCount > 0
              ? `${world.activeTripCount} active trip${world.activeTripCount === 1 ? '' : 's'} · inspect only`
              : `${world.heroes.length} worker${world.heroes.length === 1 ? '' : 's'} on the map · inspect only`}
          </p>
        </div>
      </div>
      <div ref={rootRef} className="relative min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
