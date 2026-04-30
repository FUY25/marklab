import { canonicalizeMarkdown } from '@marklab/markdown/src/canonicalize';
import { sha256Hex } from '@marklab/shared/src/hash';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { editorViewCtx, parserCtx } from '@milkdown/kit/core';
import { getMarkdown } from '@milkdown/kit/utils';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';

export interface RuntimeMarkdownState {
  yjsState: Uint8Array;
  markdown: string;
  hash: string;
}

export interface AppliedHeadlessMarkdownTransaction {
  serializedMarkdown: string;
  yjsState: Uint8Array;
  previousSerializedMarkdown: string;
  previousHash: string;
  changedRangeCount: number;
  changedCharacterCount: number;
  documentCharacterCount: number;
  fullDocumentReplacement: boolean;
  appliedTransactionCount: number;
}

export interface ApplyChangedRangesInput {
  branchId: string;
  yjsState: Uint8Array;
  seedMarkdown: string;
  targetCanonicalMarkdown: string;
}

export interface HeadlessMilkdownRuntime {
  initializeFromMarkdown(markdown: string): Promise<RuntimeMarkdownState>;
  serializeYjsState(yjsState: Uint8Array): Promise<RuntimeMarkdownState>;
  applyChangedRanges(input: ApplyChangedRangesInput): Promise<AppliedHeadlessMarkdownTransaction>;
}

interface RuntimeSession {
  crepe: Crepe;
  ydoc: Y.Doc;
  cleanup(): void;
}

interface ChangeMetadata {
  changedCharacterCount: number;
  documentCharacterCount: number;
  fullDocumentReplacement: boolean;
}

let headlessLifecycleMutex: Promise<void> = Promise.resolve();

const crepeFeatures: Partial<Record<CrepeFeature, boolean>> = {
  [CrepeFeature.Cursor]: false,
  [CrepeFeature.ListItem]: false,
  [CrepeFeature.LinkTooltip]: false,
  [CrepeFeature.ImageBlock]: false,
  [CrepeFeature.BlockEdit]: false,
  [CrepeFeature.Placeholder]: false,
  [CrepeFeature.Toolbar]: false,
  [CrepeFeature.CodeMirror]: false,
  [CrepeFeature.Table]: false,
  [CrepeFeature.Latex]: false,
  [CrepeFeature.TopBar]: false,
};

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

function installDom(dom: JSDOM): () => void {
  const window = dom.window;
  const previous = new Map(
    [
      'window',
      'document',
      'navigator',
      'Node',
      'Element',
      'HTMLElement',
      'Text',
      'File',
      'Event',
      'CustomEvent',
      'DOMParser',
      'XMLSerializer',
      'MutationObserver',
      'getComputedStyle',
      'addEventListener',
      'removeEventListener',
      'dispatchEvent',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'ResizeObserver',
      'IntersectionObserver',
    ].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const),
  );

  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  class NoopIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  defineGlobal('window', window);
  defineGlobal('document', window.document);
  defineGlobal('navigator', window.navigator);
  defineGlobal('Node', window.Node);
  defineGlobal('Element', window.Element);
  defineGlobal('HTMLElement', window.HTMLElement);
  defineGlobal('Text', window.Text);
  defineGlobal('File', window.File);
  defineGlobal('Event', window.Event);
  defineGlobal('CustomEvent', window.CustomEvent);
  defineGlobal('DOMParser', window.DOMParser);
  defineGlobal('XMLSerializer', window.XMLSerializer);
  defineGlobal('MutationObserver', window.MutationObserver);
  defineGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  defineGlobal('addEventListener', window.addEventListener.bind(window));
  defineGlobal('removeEventListener', window.removeEventListener.bind(window));
  defineGlobal('dispatchEvent', window.dispatchEvent.bind(window));
  defineGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(callback, 0));
  defineGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
  defineGlobal('ResizeObserver', NoopResizeObserver);
  defineGlobal('IntersectionObserver', NoopIntersectionObserver);

  return () => {
    for (const [name, descriptor] of previous.entries()) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[name];
      }
    }
  };
}

async function withHeadlessLifecycleLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = headlessLifecycleMutex;
  let release: () => void = () => undefined;
  headlessLifecycleMutex = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
  }
}

function calculateChangeMetadata(currentMarkdown: string, targetMarkdown: string): ChangeMetadata {
  const documentCharacterCount = targetMarkdown.length;
  if (currentMarkdown === targetMarkdown) {
    return {
      changedCharacterCount: 0,
      documentCharacterCount,
      fullDocumentReplacement: false,
    };
  }

  const shorterLength = Math.min(currentMarkdown.length, targetMarkdown.length);
  let prefixLength = 0;
  while (prefixLength < shorterLength && currentMarkdown[prefixLength] === targetMarkdown[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < shorterLength - prefixLength &&
    currentMarkdown[currentMarkdown.length - 1 - suffixLength] === targetMarkdown[targetMarkdown.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const sourceChangedCharacterCount = Math.max(currentMarkdown.length - prefixLength - suffixLength, 0);
  const targetChangedCharacterCount = Math.max(targetMarkdown.length - prefixLength - suffixLength, 0);
  const changedCharacterCount = Math.max(sourceChangedCharacterCount, targetChangedCharacterCount);
  const comparedLength = Math.max(currentMarkdown.length, targetMarkdown.length, 1);

  return {
    changedCharacterCount,
    documentCharacterCount,
    fullDocumentReplacement: changedCharacterCount / comparedLength >= 0.5,
  };
}

async function createSession(input: { yjsState?: Uint8Array; seedMarkdown?: string }): Promise<RuntimeSession> {
  const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>');
  const restoreDom = installDom(dom);
  const ydoc = new Y.Doc();
  let crepe: Crepe | undefined;

  try {
    const root = dom.window.document.querySelector('#editor');
    if (!root) throw new Error('headless_root_not_found');

    if (input.yjsState) {
      if (input.yjsState.byteLength === 0) throw new Error('invalid_yjs_state');
      Y.applyUpdate(ydoc, input.yjsState);
    }

    crepe = new Crepe({
      root,
      defaultValue: '',
      features: crepeFeatures,
    });
    crepe.editor.use(collab);
    await crepe.create();

    crepe.editor.action((ctx) => {
      const service = ctx.get(collabServiceCtx).bindDoc(ydoc);
      if (input.seedMarkdown !== undefined) service.applyTemplate(input.seedMarkdown);
      service.connect();
    });

    const sessionCrepe = crepe;
    return {
      crepe: sessionCrepe,
      ydoc,
      cleanup() {
        sessionCrepe.destroy();
        ydoc.destroy();
        dom.window.close();
        restoreDom();
      },
    };
  } catch (error) {
    try {
      if (crepe) crepe.destroy();
      ydoc.destroy();
      dom.window.close();
    } finally {
      restoreDom();
    }
    throw error;
  }
}

async function serializeSession(session: RuntimeSession): Promise<RuntimeMarkdownState> {
  const serializedMarkdown = session.crepe.editor.action(getMarkdown());
  const markdown = await canonicalizeMarkdown(serializedMarkdown);
  const yjsState = Y.encodeStateAsUpdate(session.ydoc);
  return {
    yjsState,
    markdown,
    hash: sha256Hex(markdown),
  };
}

export function createHeadlessMilkdownRuntime(): HeadlessMilkdownRuntime {
  return {
    async initializeFromMarkdown(markdown) {
      return withHeadlessLifecycleLock(async () => {
        const session = await createSession({ seedMarkdown: markdown });
        try {
          return await serializeSession(session);
        } finally {
          session.cleanup();
        }
      });
    },

    async serializeYjsState(yjsState) {
      return withHeadlessLifecycleLock(async () => {
        const session = await createSession({ yjsState });
        try {
          return await serializeSession(session);
        } finally {
          session.cleanup();
        }
      });
    },

    async applyChangedRanges(input) {
      return withHeadlessLifecycleLock(async () => {
        const session = await createSession({ yjsState: input.yjsState, seedMarkdown: input.seedMarkdown });
        try {
          const beforeState = await serializeSession(session);
          const changeMetadata = calculateChangeMetadata(beforeState.markdown, input.targetCanonicalMarkdown);

          return await session.crepe.editor.action(async (ctx) => {
            const view = ctx.get(editorViewCtx);
            const parser = ctx.get(parserCtx);
            const targetDoc = parser(input.targetCanonicalMarkdown);
            if (!targetDoc) throw new Error('target_markdown_parse_failed');

            const currentDoc = view.state.doc;
            const start = currentDoc.content.findDiffStart(targetDoc.content);
            const end = currentDoc.content.findDiffEnd(targetDoc.content);
            if (start === null || !end) {
              const state = await serializeSession(session);
              return {
                serializedMarkdown: state.markdown,
                yjsState: state.yjsState,
                previousSerializedMarkdown: beforeState.markdown,
                previousHash: beforeState.hash,
                changedRangeCount: 0,
                ...changeMetadata,
                appliedTransactionCount: 0,
              };
            }

            const transaction = view.state.tr.replace(start, end.a, targetDoc.slice(start, end.b, true));
            view.dispatch(transaction);

            const state = await serializeSession(session);
            return {
              serializedMarkdown: state.markdown,
              yjsState: state.yjsState,
              previousSerializedMarkdown: beforeState.markdown,
              previousHash: beforeState.hash,
              changedRangeCount: 1,
              ...changeMetadata,
              appliedTransactionCount: 1,
            };
          });
        } finally {
          session.cleanup();
        }
      });
    },
  };
}
