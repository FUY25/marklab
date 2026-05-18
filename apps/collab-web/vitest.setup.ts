// Vitest setup: install a working `localStorage` / `sessionStorage` shim
// inside the jsdom environment.
//
// Why this file exists: under `vitest@3.2.4` + `jsdom@27`, vitest invokes
// jsdom's `--localstorage-file` option without a valid path, jsdom emits
// `Warning: --localstorage-file was provided without a valid path`, and
// `window.localStorage` ends up as a null-prototype empty `{}` instead of a
// real `Storage` instance. That breaks `localStorage.getItem`,
// `localStorage.setItem`, `localStorage.clear`, `vi.spyOn(Storage.prototype,
// 'setItem')`, and `vi.spyOn(window, 'localStorage', 'get')`.
//
// The real `Storage` constructor and `Storage.prototype` are intact (jsdom
// installs them); the only broken bit is the instance on `window`. So we:
//   1. install per-instance backing-store methods on `Storage.prototype`
//      (so `vi.spyOn(Storage.prototype, 'setItem')` works);
//   2. install a real `Object.create(Storage.prototype)` instance as
//      `window.localStorage` / `window.sessionStorage` via a configurable
//      getter (so `vi.spyOn(window, 'localStorage', 'get')` works).
//
// This setup is test-only. Production code paths still go through the real
// browser `localStorage` / `sessionStorage`.

const STORAGE_BACKING = new WeakMap<object, Map<string, string>>();

function backingStore(instance: object): Map<string, string> {
  let store = STORAGE_BACKING.get(instance);
  if (!store) {
    store = new Map<string, string>();
    STORAGE_BACKING.set(instance, store);
  }
  return store;
}

function installStorageProto(): void {
  if (typeof Storage === 'undefined') return;
  Storage.prototype.getItem = function getItem(this: Storage, key: string): string | null {
    const store = backingStore(this);
    return store.has(String(key)) ? store.get(String(key))! : null;
  };
  Storage.prototype.setItem = function setItem(this: Storage, key: string, value: string): void {
    backingStore(this).set(String(key), String(value));
  };
  Storage.prototype.removeItem = function removeItem(this: Storage, key: string): void {
    backingStore(this).delete(String(key));
  };
  Storage.prototype.clear = function clear(this: Storage): void {
    backingStore(this).clear();
  };
  Storage.prototype.key = function key(this: Storage, index: number): string | null {
    return Array.from(backingStore(this).keys())[index] ?? null;
  };
  Object.defineProperty(Storage.prototype, 'length', {
    configurable: true,
    get(this: Storage) {
      return backingStore(this).size;
    },
  });
}

function installWindowStorage(propName: 'localStorage' | 'sessionStorage'): void {
  if (typeof window === 'undefined' || typeof Storage === 'undefined') return;
  const instance = Object.create(Storage.prototype) as Storage;
  Object.defineProperty(window, propName, {
    configurable: true,
    get() {
      return instance;
    },
  });
}

installStorageProto();
installWindowStorage('localStorage');
installWindowStorage('sessionStorage');
