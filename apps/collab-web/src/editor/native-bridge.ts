export type NativeBridgeMessage =
  | { type: 'markdown-snapshot'; markdown: string }
  | { type: 'selection-change'; status: string }
  | { type: 'collaborators-change'; collaborators: NativeCollaboratorSummary[] }
  | { type: 'cursor-debug'; entry: NativeCursorDebugEntry };

export interface NativeCollaboratorSummary {
  clientId: number;
  name: string;
  color: string;
  colorLight: string;
  kind: 'human' | 'agent';
  clientKind?: 'browser' | 'app' | 'agent' | 'guest' | 'api' | undefined;
}

export interface NativeCursorDebugEntry {
  event: string;
  at: string;
  localClientId?: number;
  docLength?: number;
  stateCount?: number;
  rawStates?: unknown[];
  resolvedCursors?: unknown[];
  collaboratorSummaries?: unknown[];
  domCarets?: unknown[];
  inlineLabels?: unknown[];
  overlayLabels?: unknown[];
  bodyRemoteCarets?: unknown[];
  bodyRemoteLabels?: unknown[];
  bodyGuestElements?: unknown[];
  domCounts?: unknown;
  localSelection?: unknown;
  details?: Record<string, unknown>;
}

export type NativeDiskMarkdownApplyResult =
  | { ok: true; markdown: string }
  | { ok: false; reason: 'provider_changed'; providerMarkdown: string }
  | { ok: false; reason: 'unavailable' };

export interface NativeDiskMarkdownText {
  readonly length: number;
  toString(): string;
  delete(index: number, length: number): void;
  insert(index: number, text: string): void;
}

type NativeMessageHandler = {
  postMessage(message: NativeBridgeMessage): void;
};

type NativeWebkitBridge = {
  messageHandlers?: {
    marklabNative?: NativeMessageHandler;
  };
};

declare global {
  interface Window {
    webkit?: NativeWebkitBridge;
    __marklabNativeApplyDiskMarkdown?: (
      markdown: string,
      baseline: string,
    ) => NativeDiskMarkdownApplyResult;
  }
}

export function postNativeMarkdownSnapshot(markdown: string): boolean {
  const handler = window.webkit?.messageHandlers?.marklabNative;
  if (!handler) return false;
  handler.postMessage({ type: 'markdown-snapshot', markdown });
  return true;
}

export function postNativeSelectionStatus(status: string): boolean {
  const handler = window.webkit?.messageHandlers?.marklabNative;
  if (!handler) return false;
  handler.postMessage({ type: 'selection-change', status });
  return true;
}

export function postNativeCollaborators(collaborators: NativeCollaboratorSummary[]): boolean {
  const handler = window.webkit?.messageHandlers?.marklabNative;
  if (!handler) return false;
  handler.postMessage({ type: 'collaborators-change', collaborators });
  return true;
}

export function postNativeCursorDebug(entry: NativeCursorDebugEntry): boolean {
  const handler = window.webkit?.messageHandlers?.marklabNative;
  if (!handler) return false;
  handler.postMessage({ type: 'cursor-debug', entry });
  return true;
}

export function applyNativeDiskMarkdownToText(
  text: NativeDiskMarkdownText,
  transact: (callback: () => void, origin: string) => void,
  markdown: string,
  baseline: string,
): NativeDiskMarkdownApplyResult {
  const providerMarkdown = text.toString();
  if (providerMarkdown !== baseline && providerMarkdown !== markdown) {
    return { ok: false, reason: 'provider_changed', providerMarkdown };
  }
  const prefixLength = commonPrefixLength(providerMarkdown, markdown);
  const suffixLength = commonSuffixLength(
    providerMarkdown.slice(prefixLength),
    markdown.slice(prefixLength),
  );
  const deleteLength = providerMarkdown.length - prefixLength - suffixLength;
  const insertText = markdown.slice(prefixLength, markdown.length - suffixLength);
  transact(() => {
    if (deleteLength > 0) text.delete(prefixLength, deleteLength);
    if (insertText) text.insert(prefixLength, insertText);
  }, 'marklab.native.disk');
  return { ok: true, markdown };
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return length;
}

function commonSuffixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[left.length - 1 - index] !== right[right.length - 1 - index]) return index;
  }
  return length;
}
