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

function isBrokenStorage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  // Working Storage instances inherit from Storage.prototype.
  return Object.getPrototypeOf(value) === null;
}

function shouldInstallShim(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof (globalThis as { Storage?: unknown }).Storage === 'undefined') return false;
  try {
    return isBrokenStorage(window.localStorage) || isBrokenStorage(window.sessionStorage);
  } catch {
    return true;
  }
}

if (shouldInstallShim()) {
  const STORAGE_BACKING = new WeakMap<object, Map<string, string>>();

  const backingStore = (instance: object): Map<string, string> => {
    let store = STORAGE_BACKING.get(instance);
    if (!store) {
      store = new Map<string, string>();
      STORAGE_BACKING.set(instance, store);
    }
    return store;
  };

  const tryDefine = (target: object, prop: string, descriptor: PropertyDescriptor): void => {
    try {
      Object.defineProperty(target, prop, descriptor);
    } catch {
      // Some host environments (Node 22 built-in Storage) mark members as
      // non-configurable. Leave them as-is; the per-instance methods we
      // install will still take precedence because `window.localStorage`
      // gets replaced wholesale below.
    }
  };

  tryDefine(Storage.prototype, 'getItem', {
    configurable: true,
    writable: true,
    value: function getItem(this: Storage, key: string): string | null {
      const store = backingStore(this);
      return store.has(String(key)) ? store.get(String(key))! : null;
    },
  });
  tryDefine(Storage.prototype, 'setItem', {
    configurable: true,
    writable: true,
    value: function setItem(this: Storage, key: string, value: string): void {
      backingStore(this).set(String(key), String(value));
    },
  });
  tryDefine(Storage.prototype, 'removeItem', {
    configurable: true,
    writable: true,
    value: function removeItem(this: Storage, key: string): void {
      backingStore(this).delete(String(key));
    },
  });
  tryDefine(Storage.prototype, 'clear', {
    configurable: true,
    writable: true,
    value: function clear(this: Storage): void {
      backingStore(this).clear();
    },
  });
  tryDefine(Storage.prototype, 'key', {
    configurable: true,
    writable: true,
    value: function key(this: Storage, index: number): string | null {
      return Array.from(backingStore(this).keys())[index] ?? null;
    },
  });
  tryDefine(Storage.prototype, 'length', {
    configurable: true,
    get(this: Storage) {
      return backingStore(this).size;
    },
  });

  const installWindowStorage = (propName: 'localStorage' | 'sessionStorage'): void => {
    const instance = Object.create(Storage.prototype) as Storage;
    tryDefine(window, propName, {
      configurable: true,
      get() {
        return instance;
      },
    });
  };

  installWindowStorage('localStorage');
  installWindowStorage('sessionStorage');
}
