import { DocumentManager, type ClientToken } from '@y-sweet/sdk';
import { PROVIDER_TOKEN_TTL_SECONDS } from '../config/provider-token-policy';

export type ProviderAuthorization = 'full' | 'read-only';

export interface YSweetDocumentManagerLike {
  getOrCreateDocAndToken(
    docId?: string,
    request?: { authorization?: ProviderAuthorization; validForSeconds?: number },
  ): Promise<ClientToken>;
}

export interface IssueProviderTokenInput {
  providerDocId: string;
  sessionId: string;
  authorization: ProviderAuthorization;
  validForSeconds?: number;
}

export interface IssuedProviderToken {
  providerDocId: string;
  sessionId: string;
  authorization: ProviderAuthorization;
  validForSeconds: number;
  issuedAt: string;
  expiresAt: string;
  clientToken: ClientToken;
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
      const clientToken = await manager.getOrCreateDocAndToken(request.providerDocId, {
        authorization: request.authorization,
        validForSeconds,
      });

      return {
        providerDocId: request.providerDocId,
        sessionId: request.sessionId,
        authorization: request.authorization,
        validForSeconds,
        issuedAt: new Date(issuedAtMs).toISOString(),
        expiresAt: new Date(issuedAtMs + validForSeconds * 1000).toISOString(),
        clientToken,
      };
    },
  };
}

function requiredConnectionString(): string {
  const value = process.env.MARKLAB_YSWEET_CONNECTION_STRING;
  if (!value?.trim()) throw new Error('ysweet_connection_string_not_configured');
  return value;
}
