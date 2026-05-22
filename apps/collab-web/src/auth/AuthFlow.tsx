import { useEffect, useState } from 'react';
import { MARKLAB_API_URL } from '@marklab/collab-editor';
import { AlertTriangle, CheckCircle2, ExternalLink, LoaderCircle } from 'lucide-react';

const NATIVE_AUTH_STORAGE_KEY = 'marklab_native_auth';

interface AuthSessionUser {
  userId: string;
  email: string;
  displayName: string;
}

interface AuthSessionResponse {
  token: string;
  user: AuthSessionUser;
}

export interface SignInPageProps {
  nativeMode?: boolean;
  redirect?: (url: string) => void;
}

export interface AuthCallbackPageProps {
  search?: string;
  redirect?: (url: string) => void;
}

function apiPath(path: string): string {
  return `${MARKLAB_API_URL}${path}`;
}

function defaultRedirect(url: string): void {
  window.location.assign(url);
}

function authErrorMessage(error: string): string {
  switch (error) {
    case 'oidc_not_configured':
      return 'Google sign-in is not configured for this environment.';
    case 'oidc_login_failed':
    case 'oidc_code_exchange_failed':
    case 'oidc_userinfo_failed':
      return 'Google sign-in could not be completed. Try again or ask the operator for a fresh invite.';
    case 'missing_oidc_callback':
      return 'The sign-in response is missing required details.';
    case 'invalid_oidc_start_response':
    case 'invalid_auth_callback_response':
    case 'invalid_auth_token':
    case 'invalid_auth_user':
    case 'invalid_auth_email':
    case 'invalid_auth_display_name':
      return 'The sign-in response was not recognized.';
    default:
      return 'Google sign-in failed. Try again or ask the operator to check the deployment.';
  }
}

function hostedBaseURL(): string {
  return window.location.origin;
}

function apiBaseURL(): string {
  return MARKLAB_API_URL || hostedBaseURL();
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${label}`);
  return value as Record<string, unknown>;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const code =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `http_${response.status}`;
    throw new Error(code);
  }
  return body;
}

function authSessionFromResponse(value: unknown): AuthSessionResponse {
  const record = requireObject(value, 'auth_callback_response');
  const user = requireObject(record.user, 'auth_user');
  if (typeof record.token !== 'string' || !record.token) throw new Error('invalid_auth_token');
  if (typeof user.userId !== 'string' || !user.userId) throw new Error('invalid_auth_user');
  if (typeof user.email !== 'string') throw new Error('invalid_auth_email');
  if (typeof user.displayName !== 'string' || !user.displayName.trim()) throw new Error('invalid_auth_display_name');
  return {
    token: record.token,
    user: {
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
    },
  };
}

function GoogleLogo() {
  return (
    <svg className="auth-google-logo" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285f4" d="M17.6 9.2c0-.6-.1-1.1-.2-1.6H9v3.1h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.8c1.7-1.5 2.8-3.7 2.8-6.4Z" />
      <path fill="#34a853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9a5.4 5.4 0 0 1-5.1-3.7H1v2.3A9 9 0 0 0 9 18Z" />
      <path fill="#fbbc05" d="M3.9 10.8a5.4 5.4 0 0 1 0-3.6V4.9H1a9 9 0 0 0 0 8.2l2.9-2.3Z" />
      <path fill="#ea4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3L15 2.4A9 9 0 0 0 1 4.9l2.9 2.3A5.4 5.4 0 0 1 9 3.6Z" />
    </svg>
  );
}

export function nativeAuthCallbackURL(session: AuthSessionResponse): string {
  const url = new URL('marklab://auth/callback');
  url.searchParams.set('token', session.token);
  url.searchParams.set('apiBaseURL', apiBaseURL());
  url.searchParams.set('webBaseURL', hostedBaseURL());
  url.searchParams.set('userId', session.user.userId);
  url.searchParams.set('email', session.user.email);
  url.searchParams.set('displayName', session.user.displayName);
  return url.toString();
}

export function SignInPage({ nativeMode = false, redirect = defaultRedirect }: SignInPageProps) {
  const [status, setStatus] = useState<'idle' | 'starting' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function startSignIn() {
    setStatus('starting');
    setError(null);
    try {
      const response = await fetch(apiPath('/api/auth/oidc/start'), {
        method: 'POST',
        credentials: 'include',
      });
      const body = requireObject(await readJsonResponse(response), 'oidc_start_response');
      if (typeof body.authorizationUrl !== 'string' || !body.authorizationUrl) throw new Error('invalid_oidc_start_response');
      if (nativeMode) window.sessionStorage.setItem(NATIVE_AUTH_STORAGE_KEY, '1');
      redirect(body.authorizationUrl);
    } catch (caught) {
      setStatus('failed');
      setError(caught instanceof Error ? caught.message : 'sign_in_failed');
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="auth-title">
        <h1 id="auth-title">Welcome to MarkLab</h1>
        <p className="auth-copy">Sign in or sign up with Google to continue.</p>
        <button className="auth-google" type="button" onClick={() => void startSignIn()} disabled={status === 'starting'}>
          {status === 'starting' ? <LoaderCircle className="auth-spin" size={17} aria-hidden="true" /> : <GoogleLogo />}
          <span>{status === 'starting' ? 'Opening Google' : 'Continue with Google'}</span>
        </button>
        {status === 'starting' ? (
          <p className="auth-status" role="status">Opening Google...</p>
        ) : null}
        {error ? (
          <p className="auth-alert" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{authErrorMessage(error)}</span>
          </p>
        ) : null}
      </section>
    </main>
  );
}

export function AuthCallbackPage({ search = window.location.search, redirect = defaultRedirect }: AuthCallbackPageProps) {
  const [status, setStatus] = useState<'loading' | 'done' | 'failed'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nativeURL, setNativeURL] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const params = new URLSearchParams(search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) {
      setStatus('failed');
      setError('missing_oidc_callback');
      return;
    }

    async function finishSignIn() {
      try {
        const response = await fetch(apiPath('/api/auth/oidc/callback'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, state }),
        });
        const session = authSessionFromResponse(await readJsonResponse(response));
        if (disposed) return;
        if (window.sessionStorage.getItem(NATIVE_AUTH_STORAGE_KEY) === '1') {
          window.sessionStorage.removeItem(NATIVE_AUTH_STORAGE_KEY);
          const callbackURL = nativeAuthCallbackURL(session);
          setNativeURL(callbackURL);
          setStatus('done');
          redirect(callbackURL);
          return;
        }
        setStatus('done');
      } catch (caught) {
        if (disposed) return;
        setStatus('failed');
        setError(caught instanceof Error ? caught.message : 'auth_callback_failed');
      }
    }

    void finishSignIn();
    return () => {
      disposed = true;
    };
  }, [redirect, search]);

  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="auth-callback-title">
        <h1 id="auth-callback-title">Signing in</h1>
        {status === 'loading' ? (
          <p className="auth-status" role="status">
            <LoaderCircle className="auth-spin" size={16} aria-hidden="true" />
            <span>Finishing sign-in...</span>
          </p>
        ) : null}
        {status === 'done' && nativeURL ? (
          <a className="auth-google auth-link" href={nativeURL}>
            <span>Open MarkLab</span>
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        ) : null}
        {status === 'done' && !nativeURL ? (
          <p className="auth-success" role="status">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>Signed in.</span>
          </p>
        ) : null}
        {error ? (
          <p className="auth-alert" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{authErrorMessage(error)}</span>
          </p>
        ) : null}
      </section>
    </main>
  );
}
