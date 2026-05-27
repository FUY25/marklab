import { beforeEach } from 'vitest';

// Vitest setup: install a working `localStorage` / `sessionStorage` shim
// inside the jsdom environment, but only when the broken-state signature
// is detected. This file is loaded by both the root and the per-package
// Vitest config, so it must be a strict no-op when:
//   - running in a node-only environment (no window),
//   - running under a real browser-like environment where storage already
//     works (Object.getPrototypeOf(window.localStorage) is Storage.prototype).
//
// Why this file exists: under `vitest@3.2.4` + `jsdom@27`, vitest invokes
// jsdom with `--localstorage-file` but no path, and jsdom returns a
// null-prototype empty `{}` for `window.localStorage`. The `Storage`
// constructor and prototype are intact, so the fix is to bind a real
// `Object.create(Storage.prototype)` instance to `window.localStorage`
// and provide WeakMap-backed methods on `Storage.prototype` that work
// even when called on a plain instance.

function tryDefineProperty(target: object, prop: string, descriptor: PropertyDescriptor): void {
  try {
    Object.defineProperty(target, prop, descriptor);
  } catch {
    // Host-provided DOM shims may expose non-configurable properties.
    // When that happens, leave the existing implementation in place.
  }
}

function isBrokenStorage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  const storage = value as Partial<Storage>;
  if (
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function' ||
    typeof storage.clear !== 'function'
  ) {
    return true;
  }
  // Working Storage instances inherit from Storage.prototype.
  return Object.getPrototypeOf(value) === null;
}

function storageConstructorOrNull(): typeof Storage | null {
  if (typeof window !== 'undefined' && typeof window.Storage !== 'undefined') return window.Storage;
  const globalStorage = (globalThis as { Storage?: typeof Storage }).Storage;
  return typeof globalStorage === 'undefined' ? null : globalStorage;
}

function shouldInstallShim(): boolean {
  if (typeof window === 'undefined') return false;
  if (!storageConstructorOrNull()) return false;
  try {
    return isBrokenStorage(window.localStorage) || isBrokenStorage(window.sessionStorage);
  } catch {
    return true;
  }
}

function installStorageShim(): void {
  if (!shouldInstallShim()) return;

  const StorageConstructor = storageConstructorOrNull();
  if (!StorageConstructor) return;

  const STORAGE_BACKING = new WeakMap<object, Map<string, string>>();

  const backingStore = (instance: object): Map<string, string> => {
    let store = STORAGE_BACKING.get(instance);
    if (!store) {
      store = new Map<string, string>();
      STORAGE_BACKING.set(instance, store);
    }
    return store;
  };

  tryDefineProperty(StorageConstructor.prototype, 'getItem', {
    configurable: true,
    writable: true,
    value: function getItem(this: Storage, key: string): string | null {
      const store = backingStore(this);
      return store.has(String(key)) ? store.get(String(key))! : null;
    },
  });
  tryDefineProperty(StorageConstructor.prototype, 'setItem', {
    configurable: true,
    writable: true,
    value: function setItem(this: Storage, key: string, value: string): void {
      backingStore(this).set(String(key), String(value));
    },
  });
  tryDefineProperty(StorageConstructor.prototype, 'removeItem', {
    configurable: true,
    writable: true,
    value: function removeItem(this: Storage, key: string): void {
      backingStore(this).delete(String(key));
    },
  });
  tryDefineProperty(StorageConstructor.prototype, 'clear', {
    configurable: true,
    writable: true,
    value: function clear(this: Storage): void {
      backingStore(this).clear();
    },
  });
  tryDefineProperty(StorageConstructor.prototype, 'key', {
    configurable: true,
    writable: true,
    value: function key(this: Storage, index: number): string | null {
      return Array.from(backingStore(this).keys())[index] ?? null;
    },
  });
  tryDefineProperty(StorageConstructor.prototype, 'length', {
    configurable: true,
    get(this: Storage) {
      return backingStore(this).size;
    },
  });

  const installWindowStorage = (propName: 'localStorage' | 'sessionStorage'): void => {
    const instance = Object.create(StorageConstructor.prototype) as Storage;
    tryDefineProperty(window, propName, {
      configurable: true,
      get() {
        return instance;
      },
    });
    if (globalThis !== window) {
      tryDefineProperty(globalThis, propName, {
        configurable: true,
        get() {
          return instance;
        },
      });
    }
  };

  installWindowStorage('localStorage');
  installWindowStorage('sessionStorage');
}

function installRangeGeometryShim(): void {
  if (typeof window === 'undefined') return;

  const RangeConstructor = window.Range
    ?? (globalThis as { Range?: typeof Range }).Range;
  if (!RangeConstructor) return;

  const prototype = RangeConstructor.prototype as Range & {
    getClientRects?: () => DOMRectList;
    getBoundingClientRect?: () => DOMRect;
  };
  if (typeof prototype.getClientRects !== 'function') {
    tryDefineProperty(prototype, 'getClientRects', {
      configurable: true,
      value: () => [] as unknown as DOMRectList,
    });
  }
  if (typeof prototype.getBoundingClientRect !== 'function') {
    tryDefineProperty(prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }) as DOMRect,
    });
  }
}

installStorageShim();
installRangeGeometryShim();
beforeEach(() => {
  installStorageShim();
  installRangeGeometryShim();
});
