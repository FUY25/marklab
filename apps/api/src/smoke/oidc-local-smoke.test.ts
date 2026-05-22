import { describe, expect, it } from 'vitest';
import { runLocalOidcSmoke } from './oidc-local-smoke';

describe('local OIDC owner onboarding smoke', () => {
  it('exercises OIDC sign-in, bearer session auth, and self-serve workspace creation', async () => {
    const result = await runLocalOidcSmoke();

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([
      'oidc_start_sets_state_cookie_and_authorization_url',
      'mock_oidc_authorize_redirects_with_code_and_state',
      'oidc_callback_exchanges_code_and_creates_owner_session',
      'bearer_session_authenticates_api_requests',
      'owner_can_list_empty_workspaces',
      'owner_can_create_self_serve_workspace',
      'created_workspace_is_listed_for_owner',
      'oidc_discovery_token_and_userinfo_endpoints_were_exercised',
    ]);
    expect(result.user).toEqual({
      userId: 'user_1',
      email: 'owner@example.test',
      displayName: 'Owner Smoke',
    });
    expect(result.workspace).toEqual({
      workspaceId: 'ws_1',
      name: 'Gate 6 Smoke Workspace',
      role: 'Owner',
    });
    expect(result.nativeCallbackUrl).toContain('marklab://auth/callback?token=REDACTED');
    expect(result.nativeCallbackUrl).toContain('displayName=Owner+Smoke');
    expect(result.oidcRequests).toEqual({
      authorizationRequests: 1,
      discoveryRequests: 2,
      tokenRequests: 1,
      userinfoRequests: 1,
    });
  });
});
