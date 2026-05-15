declare module 'y-indexeddb' {
  import type * as Y from 'yjs';

  export class IndexeddbPersistence {
    readonly name: string;
    readonly doc: Y.Doc;
    readonly whenSynced: Promise<void>;

    constructor(name: string, doc: Y.Doc);
    destroy(): void;
  }
}
