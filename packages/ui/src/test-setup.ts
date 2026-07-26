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

if (typeof HTMLCanvasElement !== 'undefined') {
  const createCanvas2dContext = (): CanvasRenderingContext2D => {
    let fillStyle: string | CanvasGradient | CanvasPattern = '#000000';

    return {
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        fillStyle = value;
      },
      strokeStyle: '#000000',
      font: '10px sans-serif',
      globalCompositeOperation: 'source-over',
      clearRect(): void {},
      drawImage(): void {},
      fillRect(): void {},
      fillText(): void {},
      getImageData(): ImageData {
        return new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
      },
      measureText(): TextMetrics {
        return { width: 0 } as TextMetrics;
      },
      strokeText(): void {},
      createLinearGradient(): CanvasGradient {
        return { addColorStop(): void {} } as CanvasGradient;
      },
    } as unknown as CanvasRenderingContext2D;
  };

  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: ((contextId: string) => {
      return contextId === '2d' ? createCanvas2dContext() : null;
    }) as unknown as HTMLCanvasElement['getContext'],
  });
}

if (typeof window !== 'undefined' && !window.localStorage) {
  const store: Record<string, string> = {};
  const storage: Storage = {
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
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

// jsdom defaults to 1024px; pin a wide viewport so App auto-collapse matches desktop
// unless a test explicitly overrides window.innerWidth.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true, writable: true });
}
