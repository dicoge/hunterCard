// Pure, platform-agnostic Google OAuth client-id / redirect resolution.
//
// Extracted from authService so it can be unit-tested without React Native
// (see scripts/verify-google-client-selection.mjs). authService supplies the
// live Platform.OS + EXPO_PUBLIC_* values; everything here is a pure function
// of its arguments.
//
// Why per-platform client ids: Google issues a *separate* OAuth client for
// each application type. The Web client id only accepts web (https) redirect
// URIs, so a native iOS build must use the iOS client id, whose redirect is the
// reversed-client-id custom scheme. Feeding the Web id to a native build is
// exactly why "有 env 時 Google 可登" failed on device (DIC-824 CR).

export type OSName = 'ios' | 'android' | 'web' | (string & {});

export interface GoogleClientEnv {
  /** EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID */
  web?: string;
  /** EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID */
  ios?: string;
  /** EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID */
  android?: string;
  /** EXPO_PUBLIC_GOOGLE_CLIENT_ID — legacy generic fallback */
  generic?: string;
}

const GOOGLE_CLIENT_SUFFIX = '.apps.googleusercontent.com';

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Pick the correct Google OAuth client id for the running platform.
 * Native platforms prefer their own client id and fall back to the generic /
 * web id only so a partially-configured project still attempts a login rather
 * than hard-failing. Web always uses the web client id.
 */
export function resolveGoogleClientId(os: OSName, env: GoogleClientEnv): string {
  const web = clean(env.web);
  const ios = clean(env.ios);
  const android = clean(env.android);
  const generic = clean(env.generic);

  if (os === 'ios') return ios || generic || web;
  if (os === 'android') return android || generic || web;
  return web || generic;
}

/** True when a usable Google client id exists for this platform. */
export function isGoogleConfigured(os: OSName, env: GoogleClientEnv): boolean {
  return resolveGoogleClientId(os, env).length > 0;
}

/**
 * "1234-abc.apps.googleusercontent.com" -> "com.googleusercontent.apps.1234-abc"
 * (the reversed-client-id URL scheme Google expects for native redirects).
 */
export function reverseGoogleClientId(clientId: string): string {
  const id = clean(clientId);
  const base = id.endsWith(GOOGLE_CLIENT_SUFFIX)
    ? id.slice(0, -GOOGLE_CLIENT_SUFFIX.length)
    : id;
  return `com.googleusercontent.apps.${base}`;
}

/**
 * Native redirect URI for a Google iOS/Android client. Returns '' when the id
 * is empty so callers can fall back to AuthSession's default web redirect.
 */
export function nativeGoogleRedirectUri(clientId: string): string {
  const id = clean(clientId);
  if (!id) return '';
  return `${reverseGoogleClientId(id)}:/oauthredirect`;
}
