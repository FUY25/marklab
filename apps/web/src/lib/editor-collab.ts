import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

export interface CreateEditorCollabInput {
  websocketUrl: string;
  roomName: string;
  token?: string | undefined;
  user: {
    name: string;
    color?: string;
  };
}

function mixedClientId(clientId: number): number {
  let hash = clientId >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function toHex(channel: number): string {
  return channel.toString(16).padStart(2, '0');
}

export function collaboratorColorForClientId(clientId: number): string {
  const hash = mixedClientId(clientId);
  const red = 48 + (hash & 0x9f);
  const green = 48 + ((hash >>> 8) & 0x9f);
  const blue = 48 + ((hash >>> 16) & 0x9f);
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

export function createEditorCollab(input: CreateEditorCollabInput) {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: input.websocketUrl,
    name: input.roomName,
    document: ydoc,
    ...(input.token ? { token: input.token } : {}),
  });

  const awareness = provider.awareness;
  if (!awareness) throw new Error('provider_awareness_unavailable');

  awareness.setLocalStateField('user', {
    ...input.user,
    color: input.user.color ?? collaboratorColorForClientId(ydoc.clientID),
  });

  return {
    ydoc,
    provider,
    awareness,
    destroy: () => {
      provider.destroy();
      ydoc.destroy();
    },
  };
}
