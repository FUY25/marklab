import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

export interface CreateEditorCollabInput {
  websocketUrl: string;
  roomName: string;
  token?: string | undefined;
  user: {
    name: string;
    color: string;
  };
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

  awareness.setLocalStateField('user', input.user);

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
