import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { GoogleUser, AuthTokens } from '../types/auth';

WebBrowser.maybeCompleteAuthSession();

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
  || process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID
  || '';

const scopes = ['openid', 'profile', 'email'];

async function fetchUserInfo(accessToken: string): Promise<GoogleUser> {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.status}`);
  }
  const data = await response.json();
  return {
    id: data.sub,
    email: data.email,
    name: data.name,
    givenName: data.given_name,
    familyName: data.family_name,
    picture: data.picture,
  };
}

export async function googleSignIn(): Promise<{ user: GoogleUser; tokens: AuthTokens }> {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID. Set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID in your .env file.\n' +
      'See .env.example for required variables.'
    );
  }

  const redirectUri = AuthSession.makeRedirectUri();

  const authRequest = new AuthSession.AuthRequest({
    clientId: GOOGLE_CLIENT_ID,
    scopes,
    redirectUri,
    usePKCE: true,
  });

  const result = await authRequest.promptAsync(discovery);
  if (result.type !== 'success') {
    throw new Error(result.type === 'cancel' ? 'User cancelled login' : `Auth failed: ${result.type}`);
  }

  const code = result.params.code;
  if (!code) {
    throw new Error('No authorization code returned');
  }

  const codeVerifier = authRequest.codeVerifier;
  if (!codeVerifier) {
    throw new Error('PKCE code verifier missing');
  }

  const tokenResponse = await AuthSession.exchangeCodeAsync(
    {
      clientId: GOOGLE_CLIENT_ID,
      code,
      redirectUri,
      extraParams: {
        code_verifier: codeVerifier,
      },
    },
    discovery,
  );

  const tokens: AuthTokens = {
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken,
    expiresAt: Date.now() + (tokenResponse.expiresIn ?? 3600) * 1000,
  };

  const user = await fetchUserInfo(tokens.accessToken);
  return { user, tokens };
}

export async function googleSignOut(tokens: AuthTokens | null): Promise<void> {
  if (tokens?.accessToken) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `token=${tokens.accessToken}`,
      });
    } catch {
      // Revocation is best-effort; proceed with local sign-out
    }
  }
}
