// Force UTC timezone for deterministic snapshot tests (CI runs in UTC).
process.env.TZ = 'UTC';

import '@testing-library/jest-dom/vitest';

function createMemoryStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
    },
    removeItem: (key) => {
      delete store[key];
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
    key: (i) => Object.keys(store)[i] ?? null,
    get length(): number {
      return Object.keys(store).length;
    },
  };
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverPolyfill {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverPolyfill as unknown as typeof ResizeObserver;
}

if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function noopScrollIntoView(): void {};
}

const testStorage = createMemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: testStorage,
});

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: testStorage,
  });
}

if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement, contextId: string) {
      if (contextId !== '2d') return null;
      return {
        canvas: this,
        fillStyle: '#000000',
        strokeStyle: '#000000',
        clearRect: () => {},
        fillRect: () => {},
        strokeRect: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: () => {},
        fill: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        scale: () => {},
        measureText: (text: string) => ({ width: text.length * 8 }),
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        putImageData: () => {},
        createLinearGradient: () => ({ addColorStop: () => {} }),
      } as unknown as CanvasRenderingContext2D;
    },
  });
}

// jsdom defaults to 1024px; pin a wide viewport so App auto-collapse matches desktop
// unless a test explicitly overrides window.innerWidth.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true, writable: true });
}
