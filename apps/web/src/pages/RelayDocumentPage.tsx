import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { MilkdownEditor } from '../components/MilkdownEditor';
import { ReadOnlyMarkdownView } from '../components/ReadOnlyMarkdownView';
import { readWebConfig } from '../config';
import {
  MarklabWebApi,
  type CreatedRelaySession,
  type RelayAccessResponse,
} from '../lib/api-client';
import { collaboratorColorForClientId } from '../lib/editor-collab';

interface RelayDocumentPageProps {
  relayRoomId: string;
}

interface RelayCollab {
  ydoc: Y.Doc;
  awareness: Awareness;
  destroy: () => void;
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

type RelayAccessMode = 'checking' | 'editable' | 'read-only';
type IdentityStatus = 'checking' | 'prompt' | 'ready';

const relayOrigin = 'marklab-relay';
const relayClientIdKey = 'marklab.relayClientId.v1';
const relayNamePrefix = 'marklab.relayName.';

function readableError(error: unknown, fallback: string): string {
  console.error(fallback, error);
  return error instanceof Error ? `${fallback} ${error.message}` : fallback;
}

function relayToken(): string | null {
  const token = new URLSearchParams(window.location.search).get('token');
  return token && token.trim() ? token : null;
}

function relayApiUrl(): string | undefined {
  const value = new URLSearchParams(window.location.search).get('apiUrl');
  return value && value.trim() ? value : undefined;
}

function relayWebSocketUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('wsUrl');
  if (fromUrl && fromUrl.trim()) return fromUrl;
  const config = readWebConfig();
  return config.relayWebSocketUrl;
}

function readOrCreateRelayClientId(relayRoomId: string, grantId: string): string {
  const key = `${relayClientIdKey}.${relayRoomId}.${grantId}`;
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const next = crypto.randomUUID();
  window.localStorage.setItem(key, next);
  return next;
}

function readStoredRelayName(relayRoomId: string, grantId: string): string | null {
  return window.localStorage.getItem(`${relayNamePrefix}${relayRoomId}.${grantId}`);
}

function storeRelayName(relayRoomId: string, grantId: string, name: string): void {
  window.localStorage.setItem(`${relayNamePrefix}${relayRoomId}.${grantId}`, name);
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  value.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
}

function decodeBrowserBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

interface CollaborationNameDialogProps {
  busy: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
}

function CollaborationNameDialog({ busy, error, onSubmit }: CollaborationNameDialogProps) {
  const [name, setName] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(name);
  }

  return (
    <div className="collaboration-name-layer">
      <section className="collaboration-name-dialog" role="dialog" aria-modal="true" aria-labelledby="relay-name-title">
        <h2 id="relay-name-title">Name for collaboration</h2>
        <form onSubmit={handleSubmit}>
          <label htmlFor="relay-name-input">Collaborator name</label>
          <input
            id="relay-name-input"
            type="text"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            disabled={busy}
            autoComplete="name"
            autoFocus
          />
          <div className="collaboration-name-actions">
            <button type="submit" disabled={busy}>
              Continue
            </button>
            <button type="button" disabled={busy} onClick={() => onSubmit('')}>
              Continue as Guest
            </button>
          </div>
        </form>
        {error ? (
          <p className="collaboration-name-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}

export function RelayDocumentPage({ relayRoomId }: RelayDocumentPageProps) {
  const token = useMemo(() => relayToken(), []);
  const api = useMemo(() => {
    const apiUrl = relayApiUrl();
    return new MarklabWebApi(apiUrl ? { apiUrl } : {});
  }, []);
  const [accessMode, setAccessMode] = useState<RelayAccessMode>('checking');
  const [access, setAccess] = useState<RelayAccessResponse | null>(null);
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus>('checking');
  const [identity, setIdentity] = useState<CreatedRelaySession | null>(null);
  const [collab, setCollab] = useState<RelayCollab | null>(null);
  const [hostOnline, setHostOnline] = useState(false);
  const [relayPaused, setRelayPaused] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'status' | 'alert'>('status');
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [busyIdentity, setBusyIdentity] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const hostOnlineRef = useRef(false);
  const relayPausedRef = useRef(false);
  const pendingProposalIdRef = useRef<string | null>(null);
  const dirtySincePendingRef = useRef(false);
  const proposalTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let isActive = true;
    if (!token) {
      setAccessMode('read-only');
      setStatusKind('alert');
      setStatus('Unable to load relay link.');
      setIdentityStatus('ready');
      return undefined;
    }

    void api
      .getRelayAccess(relayRoomId, token)
      .then((nextAccess) => {
        if (!isActive) return;
        setAccess(nextAccess);
        hostOnlineRef.current = nextAccess.hostOnline;
        setHostOnline(nextAccess.hostOnline);
        setAccessMode(nextAccess.canWrite ? 'editable' : 'read-only');
        setStatus(nextAccess.hostOnline ? 'Connected' : 'Host offline');
        setStatusKind(nextAccess.hostOnline ? 'status' : 'alert');
      })
      .catch((error: unknown) => {
        if (!isActive) return;
        setAccessMode('read-only');
        setIdentityStatus('ready');
        setStatusKind('alert');
        setStatus(readableError(error, 'Unable to load relay link.'));
      });

    return () => {
      isActive = false;
    };
  }, [api, relayRoomId, token]);

  const establishIdentity = useCallback(
    async (displayName: string, source: 'stored' | 'prompt') => {
      if (!access || !token) return;
      setBusyIdentity(true);
      setIdentityError(null);
      try {
        const clientId = readOrCreateRelayClientId(relayRoomId, access.grantId);
        const session = await api.createRelaySession(relayRoomId, {
          token,
          clientId,
          clientKind: 'browser',
          displayName: displayName.trim(),
        });
        const identityName = source === 'stored' && displayName.trim() ? displayName.trim() : session.displayName;
        storeRelayName(relayRoomId, access.grantId, identityName);
        setIdentity({ ...session, displayName: identityName });
        setIdentityStatus('ready');
      } catch (error) {
        setIdentityStatus('prompt');
        setIdentityError(readableError(error, 'Unable to join collaboration.'));
      } finally {
        setBusyIdentity(false);
      }
    },
    [access, api, relayRoomId, token],
  );

  useEffect(() => {
    if (accessMode !== 'editable' || !access) {
      setIdentityStatus(accessMode === 'read-only' ? 'ready' : 'checking');
      return;
    }
    const stored = readStoredRelayName(relayRoomId, access.grantId);
    if (!stored) {
      setIdentityStatus('prompt');
      return;
    }
    setIdentityStatus('checking');
    void establishIdentity(stored, 'stored');
  }, [access, accessMode, establishIdentity, relayRoomId]);

  useEffect(() => {
    if (accessMode !== 'editable' || identityStatus !== 'ready' || !identity || !access || !token) return undefined;

    const ydoc = new Y.Doc();
    if (access.yjsStateBase64) Y.applyUpdate(ydoc, decodeBrowserBase64(access.yjsStateBase64), relayOrigin);
    const awareness = new Awareness(ydoc);
    awareness.setLocalStateField('user', {
      name: identity.displayName,
      color: identity.color || collaboratorColorForClientId(ydoc.clientID),
    });

    const socket = new WebSocket(relayWebSocketUrl());
    let relayReadyForAwareness = false;
    let cleanedUp = false;
    socketRef.current = socket;
    const sendAwarenessUpdate = (clientIds: number[]) => {
      if (!relayReadyForAwareness || clientIds.length === 0 || socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: 'awareness_update',
          updateBase64: encodeBase64(encodeAwarenessUpdate(awareness, clientIds)),
        }),
      );
    };
    const handleAwarenessUpdate = (change: AwarenessChange, origin: unknown) => {
      if (origin === relayOrigin) return;
      sendAwarenessUpdate([...change.added, ...change.updated, ...change.removed]);
    };
    awareness.on('update', handleAwarenessUpdate);

    const sendProposal = () => {
      proposalTimerRef.current = null;
      if (relayPausedRef.current) return;
      if (socket.readyState !== WebSocket.OPEN || !hostOnlineRef.current) {
        dirtySincePendingRef.current = true;
        relayPausedRef.current = true;
        setRelayPaused(true);
        setStatus('Host offline');
        setStatusKind('alert');
        return;
      }
      if (pendingProposalIdRef.current) {
        dirtySincePendingRef.current = true;
        return;
      }
      const proposalId = crypto.randomUUID();
      pendingProposalIdRef.current = proposalId;
      socket.send(
        JSON.stringify({
          type: 'propose_update',
          proposalId,
          updateBase64: encodeBase64(Y.encodeStateAsUpdate(ydoc)),
        }),
      );
      setStatus('Saving');
      setStatusKind('status');
    };
    const handleYjsUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === relayOrigin) return;
      if (relayPausedRef.current) return;
      if (pendingProposalIdRef.current) {
        dirtySincePendingRef.current = true;
        return;
      }
      if (proposalTimerRef.current !== null) window.clearTimeout(proposalTimerRef.current);
      proposalTimerRef.current = window.setTimeout(sendProposal, 400);
    };
    ydoc.on('update', handleYjsUpdate);

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          relayRoomId,
          token,
          clientId: readOrCreateRelayClientId(relayRoomId, access.grantId),
          clientKind: 'browser',
          displayName: identity.displayName,
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        yjsStateBase64?: string | null;
        updateBase64?: string | null;
        proposalId?: string | null;
        hostOnline?: boolean;
        replace?: boolean;
        reason?: string;
      };
      if (message.type === 'awareness_update' && message.updateBase64) {
        applyAwarenessUpdate(awareness, decodeBrowserBase64(message.updateBase64), relayOrigin);
        return;
      }
      if (typeof message.hostOnline === 'boolean') {
        hostOnlineRef.current = message.hostOnline;
        setHostOnline(message.hostOnline);
        if (message.hostOnline && relayPausedRef.current) {
          relayPausedRef.current = false;
          setRelayPaused(false);
          pendingProposalIdRef.current = null;
          const shouldSendAgain = dirtySincePendingRef.current;
          setStatus(shouldSendAgain ? 'Saving' : 'Connected');
          setStatusKind('status');
          if (shouldSendAgain) {
            dirtySincePendingRef.current = false;
            if (proposalTimerRef.current !== null) window.clearTimeout(proposalTimerRef.current);
            proposalTimerRef.current = window.setTimeout(sendProposal, 0);
          }
        } else if (!relayPausedRef.current) {
          setStatus(message.hostOnline ? 'Connected' : 'Host offline');
          setStatusKind(message.hostOnline ? 'status' : 'alert');
        }
      }
      const nextState = message.updateBase64 ?? message.yjsStateBase64;
      if ((message.type === 'hello_ack' || message.type === 'accepted_update') && nextState) {
        if (message.type === 'accepted_update' && message.replace) {
          setStatus('Reloading resolved document');
          setStatusKind('status');
          window.location.reload();
          return;
        }
        Y.applyUpdate(ydoc, decodeBrowserBase64(nextState), relayOrigin);
        if (message.type === 'accepted_update' && message.proposalId && message.proposalId === pendingProposalIdRef.current) {
          pendingProposalIdRef.current = null;
          const shouldSendAgain = dirtySincePendingRef.current && hostOnlineRef.current && !relayPausedRef.current;
          dirtySincePendingRef.current = false;
          setStatus('Saved');
          setStatusKind('status');
          if (shouldSendAgain) {
            proposalTimerRef.current = window.setTimeout(sendProposal, 0);
          }
        } else if (message.type === 'accepted_update' && !pendingProposalIdRef.current && !relayPausedRef.current) {
          setStatus('Connected');
          setStatusKind('status');
        }
      }
      if (message.type === 'hello_ack') {
        relayReadyForAwareness = true;
        sendAwarenessUpdate([awareness.clientID]);
      }
      if (message.type === 'rejected') {
        const hostOffline = message.reason === 'host_offline';
        if (message.proposalId && message.proposalId === pendingProposalIdRef.current) {
          pendingProposalIdRef.current = null;
        }
        if (hostOffline) {
          hostOnlineRef.current = false;
          setHostOnline(false);
        }
        relayPausedRef.current = true;
        setRelayPaused(true);
        dirtySincePendingRef.current = true;
        setStatus(hostOffline ? 'Host offline' : 'Unable to save');
        setStatusKind('alert');
      }
    });
    socket.addEventListener('close', () => {
      setStatus('Host offline');
      setStatusKind('alert');
      hostOnlineRef.current = false;
      setHostOnline(false);
    });

    const cleanupRelayCollab = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      ydoc.off('update', handleYjsUpdate);
      if (proposalTimerRef.current !== null) window.clearTimeout(proposalTimerRef.current);
      proposalTimerRef.current = null;
      if (relayReadyForAwareness && socket.readyState === WebSocket.OPEN) {
        awareness.setLocalState(null);
      }
      awareness.off('update', handleAwarenessUpdate);
      socket.close();
      awareness.destroy();
      ydoc.destroy();
    };

    setCollab({
      ydoc,
      awareness,
      destroy: cleanupRelayCollab,
    });

    return () => {
      socketRef.current = null;
      setCollab(null);
      pendingProposalIdRef.current = null;
      dirtySincePendingRef.current = false;
      cleanupRelayCollab();
    };
  }, [access, accessMode, identity, identityStatus, relayRoomId, token]);

  const isReadOnly = accessMode === 'read-only';

  return (
    <main className="remote-document-shell" data-testid="relay-document-page">
      <section className="remote-document-canvas" aria-label={isReadOnly ? 'Read-only relay document' : 'Relay document editor'}>
        {isReadOnly && access ? (
          <ReadOnlyMarkdownView markdown={access.markdown} />
        ) : accessMode === 'checking' || identityStatus === 'checking' ? (
          <div className="read-only-document read-only-document-loading" role="status" data-testid="relay-access-check">
            Loading document...
          </div>
        ) : collab && hostOnline && !relayPaused ? (
          <MilkdownEditor
            initialMarkdown=""
            ydoc={collab.ydoc}
            awareness={collab.awareness}
            applyInitialTemplate={false}
            testId="milkdown-editor"
          />
        ) : (
          <div className="read-only-document read-only-document-loading" role="status" data-testid="relay-host-offline">
            {relayPaused || !hostOnline ? 'Host offline' : 'Loading document...'}
          </div>
        )}
      </section>

      {accessMode === 'editable' && identityStatus === 'prompt' ? (
        <CollaborationNameDialog
          busy={busyIdentity}
          error={identityError}
          onSubmit={(name) => void establishIdentity(name, 'prompt')}
        />
      ) : null}

      {status ? (
        <div className="remote-save-status" role={statusKind}>
          {status}
        </div>
      ) : null}
    </main>
  );
}
