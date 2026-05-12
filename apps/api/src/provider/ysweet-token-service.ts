import { DocumentManager, type ClientToken } from '@y-sweet/sdk';
import * as Y from 'yjs';
import { PROVIDER_TOKEN_TTL_SECONDS } from '../config/provider-token-policy';
import type { DbPool } from '../db/client';
import type { CollabSnapshotService } from '../http/app';
import { createHeadlessMilkdownRuntime } from '../services/milkdown-headless-runtime';

export type ProviderAuthorization = 'full' | 'read-only';

export interface ProviderSessionIdentity {
  sessionId: string;
  actorType: 'agent' | 'user';
  actorId: string;
  displayName: string;
  isGuest: boolean;
}

export function encodeProviderSessionIdentity(identity: ProviderSessionIdentity): string {
  return JSON.stringify({
    sessionId: identity.sessionId,
    actorType: identity.actorType,
    actorId: identity.actorId,
    displayName: identity.displayName,
    isGuest: identity.isGuest,
  });
}

export function bindProviderSessionIdentity(ydoc: Y.Doc, identity: ProviderSessionIdentity): Y.PermanentUserData {
  const permanentUserData = new Y.PermanentUserData(ydoc);
  permanentUserData.setUserMapping(ydoc, ydoc.clientID, encodeProviderSessionIdentity(identity));
  return permanentUserData;
}

export interface YSweetDocumentManagerLike {
  createDoc(docId?: string): Promise<{ docId: string }>;
  getClientToken(
    docId: string | { docId: string },
    request?: { authorization?: ProviderAuthorization; validForSeconds?: number },
  ): Promise<ClientToken>;
  getOrCreateDocAndToken(
    docId?: string,
    request?: { authorization?: ProviderAuthorization; validForSeconds?: number },
  ): Promise<ClientToken>;
  getDocAsUpdate?(docId: string): Promise<Uint8Array>;
  updateDoc(docId: string, update: Uint8Array): Promise<void>;
}

export interface IssueProviderTokenInput {
  providerDocId: string;
  sessionId: string;
  authorization: ProviderAuthorization;
  validForSeconds?: number;
  seedYjsState?: Uint8Array;
  sessionIdentity?: ProviderSessionIdentity;
}

export function createYSweetSnapshotService(input: {
  pool: DbPool;
  connectionString?: string;
  manager?: YSweetDocumentManagerLike;
}): CollabSnapshotService {
  const manager = input.manager ?? new DocumentManager(input.connectionString ?? requiredConnectionString());
  const runtime = createHeadlessMilkdownRuntime();

  return {
    async readCurrentMarkdownSnapshot({ docId, branchId }) {
      const providerDoc = await input.pool.query<{ provider_doc_id: string | null; provider_doc_seeded_at: Date | string | null }>(
        `select s.provider_doc_id, s.provider_doc_seeded_at
           from document_branch_states s
           join document_branches b
             on b.id = s.branch_id
          where s.branch_id = $1
            and b.doc_id = $2
            and b.is_archived = false`,
        [branchId, docId],
      );
      const providerDocId = providerDoc.rows[0]?.provider_doc_id;
      if (!providerDocId) return null;
      if (!providerDoc.rows[0]?.provider_doc_seeded_at) throw new Error('collab_snapshot_unavailable');
      if (!manager.getDocAsUpdate) throw new Error('collab_snapshot_unavailable');

      let yjsState: Uint8Array;
      try {
        yjsState = await manager.getDocAsUpdate!(providerDocId);
      } catch {
        throw new Error('collab_snapshot_unavailable');
      }
      const serialized = await runtime.serializeYjsState(yjsState);
      if (serialized.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
      return {
        docId,
        branchId,
        versionId: null,
        versionNumber: null,
        hash: serialized.hash,
        markdown: serialized.markdown,
      };
    },
  };
}

export interface IssuedProviderToken {
  providerDocId: string;
  sessionId: string;
  authorization: ProviderAuthorization;
  validForSeconds: number;
  issuedAt: string;
  expiresAt: string;
  clientToken: ClientToken;
  sessionIdentity?: ProviderSessionIdentity;
}

export interface ProviderTokenService {
  issueProviderToken(input: IssueProviderTokenInput): Promise<IssuedProviderToken>;
}

export function createYSweetTokenService(input: {
  connectionString?: string;
  manager?: YSweetDocumentManagerLike;
  defaultValidForSeconds?: number;
} = {}): ProviderTokenService {
  const manager = input.manager ?? new DocumentManager(input.connectionString ?? requiredConnectionString());
  const defaultValidForSeconds = input.defaultValidForSeconds ?? PROVIDER_TOKEN_TTL_SECONDS;

  return {
    async issueProviderToken(request) {
      const validForSeconds = request.validForSeconds ?? defaultValidForSeconds;
      const issuedAtMs = Date.now();
      const tokenRequest = {
        authorization: request.authorization,
        validForSeconds,
      };
      let clientToken: ClientToken;
      if (request.seedYjsState) {
        // Upstream Y-Sweet createDoc(docId) is idempotent when the document
        // already exists, which lets us retry after a local seed-marker failure.
        const created = await manager.createDoc(request.providerDocId);
        if (created.docId !== request.providerDocId) throw new Error('ysweet_provider_doc_id_mismatch');
        await manager.updateDoc(created.docId, request.seedYjsState);
        clientToken = await manager.getClientToken(created, tokenRequest);
      } else {
        clientToken = await manager.getOrCreateDocAndToken(request.providerDocId, tokenRequest);
      }

      return {
        providerDocId: request.providerDocId,
        sessionId: request.sessionId,
        authorization: request.authorization,
        validForSeconds,
        issuedAt: new Date(issuedAtMs).toISOString(),
        expiresAt: new Date(issuedAtMs + validForSeconds * 1000).toISOString(),
        clientToken,
        ...(request.sessionIdentity ? { sessionIdentity: request.sessionIdentity } : {}),
      };
    },
  };
}

function requiredConnectionString(): string {
  const value = process.env.MARKLAB_YSWEET_CONNECTION_STRING;
  if (!value?.trim()) throw new Error('ysweet_connection_string_not_configured');
  return value;
}
