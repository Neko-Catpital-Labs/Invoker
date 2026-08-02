// Force UTC timezone for deterministic snapshot tests (CI runs in UTC).
process.env.TZ = 'UTC';

import '@testing-library/jest-dom/vitest';

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

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: createMemoryStorage(),
  });
}

if (typeof HTMLCanvasElement !== 'undefined') {
  const context = {
    canvas: null,
    fillStyle: '#000000',
    globalCompositeOperation: 'source-over',
    clearRect: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    drawImage: () => {},
    fillRect: () => {},
    fillText: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    measureText: (text: string) => ({ width: text.length * 8 }),
    putImageData: () => {},
    restore: () => {},
    save: () => {},
    scale: () => {},
    strokeText: () => {},
  } as unknown as CanvasRenderingContext2D;

  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(contextId: string) {
      return contextId === '2d' ? context : null;
    },
  });
}

// jsdom defaults to 1024px; pin a wide viewport so App auto-collapse matches desktop
// unless a test explicitly overrides window.innerWidth.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true, writable: true });
}
