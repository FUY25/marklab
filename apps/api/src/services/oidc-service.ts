import { createHash } from 'node:crypto';
import type { AlphaLoginClaims } from './user-service';

export interface OidcAuthConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationEndpoint?: string;
}

export interface OidcExchangeInput {
  code: string;
  codeVerifier: string;
  config: OidcAuthConfig;
}

export type OidcExchange = (input: OidcExchangeInput) => Promise<AlphaLoginClaims>;

interface OidcDiscoveryDocument {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  userinfo_endpoint?: unknown;
}

interface OidcTokenResponse {
  access_token?: unknown;
}

interface OidcUserInfo {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  picture?: unknown;
}

function endpointUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`oidc_missing_${field}`);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error('oidc_insecure_endpoint');
    }
    return url.toString();
  } catch (error) {
    if (error instanceof Error && error.message === 'oidc_insecure_endpoint') throw error;
    throw new Error('oidc_discovery_failed');
  }
}

async function jsonResponse<T>(response: Response, errorMessage: string): Promise<T> {
  if (!response.ok) throw new Error(errorMessage);
  try {
    return await response.json() as T;
  } catch {
    throw new Error(errorMessage);
  }
}

async function fetchResponse(input: string, init: RequestInit | undefined, errorMessage: string): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error(errorMessage);
  }
}

async function discoverOidc(input: { issuer: string; errorMessage: string }): Promise<OidcDiscoveryDocument> {
  const issuer = input.issuer.replace(/\/+$/u, '');
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const discoveryResponse = await fetchResponse(discoveryUrl, { headers: { accept: 'application/json' } }, input.errorMessage);
  const discovery = await jsonResponse<OidcDiscoveryDocument>(discoveryResponse, input.errorMessage);
  if (typeof discovery.issuer === 'string' && discovery.issuer.replace(/\/+$/u, '') !== issuer) {
    throw new Error('oidc_issuer_mismatch');
  }
  return discovery;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function pkceChallenge(codeVerifier: string): string {
  return base64Url(createHash('sha256').update(codeVerifier).digest());
}

export async function buildOidcAuthorizationUrl(input: {
  config: OidcAuthConfig;
  state: string;
  codeVerifier: string;
}): Promise<string> {
  const issuer = input.config.issuer.replace(/\/+$/u, '');
  const discovery = input.config.authorizationEndpoint
    ? undefined
    : await discoverOidc({ issuer, errorMessage: 'oidc_discovery_failed' });
  const authorizationEndpoint = endpointUrl(input.config.authorizationEndpoint ?? discovery?.authorization_endpoint, 'authorization_endpoint');
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.config.clientId);
  url.searchParams.set('redirect_uri', input.config.redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', pkceChallenge(input.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeOidcCode(input: OidcExchangeInput): Promise<AlphaLoginClaims> {
  const issuer = input.config.issuer.replace(/\/+$/u, '');
  const discovery = await discoverOidc({ issuer, errorMessage: 'oidc_discovery_failed' });
  const tokenEndpoint = endpointUrl(discovery.token_endpoint, 'token_endpoint');
  const userinfoEndpoint = endpointUrl(discovery.userinfo_endpoint, 'userinfo_endpoint');

  const tokenResponse = await fetchResponse(tokenEndpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      redirect_uri: input.config.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  }, 'oidc_code_exchange_failed');
  const token = await jsonResponse<OidcTokenResponse>(tokenResponse, 'oidc_code_exchange_failed');
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('oidc_code_exchange_failed');

  const userInfoResponse = await fetchResponse(userinfoEndpoint, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token.access_token}`,
    },
  }, 'oidc_userinfo_failed');
  const userInfo = await jsonResponse<OidcUserInfo>(userInfoResponse, 'oidc_userinfo_failed');
  if (typeof userInfo.sub !== 'string' || !userInfo.sub) throw new Error('oidc_invalid_claims');
  if (typeof userInfo.email !== 'string' || !userInfo.email) throw new Error('oidc_invalid_claims');
  if (userInfo.email_verified !== true) throw new Error('oidc_unverified_email');

  return {
    provider: issuer,
    subject: userInfo.sub,
    email: userInfo.email,
    ...(typeof userInfo.name === 'string' ? { name: userInfo.name } : {}),
    ...(typeof userInfo.given_name === 'string' ? { givenName: userInfo.given_name } : {}),
    ...(typeof userInfo.family_name === 'string' ? { familyName: userInfo.family_name } : {}),
    ...(typeof userInfo.picture === 'string' ? { picture: userInfo.picture } : {}),
  };
}
