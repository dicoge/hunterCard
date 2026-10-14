/**
 * Prominent disclosure + consent before the first card photo is uploaded (native AI photo
 * upload, 2026-10-14).
 *
 * Every AI scan sends the photo to our backend (/api/recognize-card), which forwards it to
 * Google Gemini. Nothing is uploaded until the user has accepted the CURRENT disclosure
 * version; bumping the version re-asks everyone. Declining uploads nothing and charges
 * nothing — manual search stays available.
 *
 * Dependency-free so the Node regression drives this exact decision.
 */

/** Bump when the disclosure text changes in substance. Must match the policy date below. */
export const PHOTO_UPLOAD_DISCLOSURE_VERSION = '2026-10-14';

export function hasPhotoUploadConsent(acceptedVersion: string | null | undefined): boolean {
  return acceptedVersion === PHOTO_UPLOAD_DISCLOSURE_VERSION;
}

export interface PhotoUploadConsentDeps {
  acceptedVersion(): string | null | undefined;
  recordAcceptance(version: string): void;
  /** Shows the disclosure; resolves true only on an explicit accept. */
  prompt(): Promise<boolean>;
}

let pending: Promise<boolean> | null = null;

/** Resolves true when an upload may proceed. Concurrent callers share one prompt. */
export function ensurePhotoUploadConsent(deps: PhotoUploadConsentDeps): Promise<boolean> {
  if (hasPhotoUploadConsent(deps.acceptedVersion())) return Promise.resolve(true);
  if (pending) return pending;
  pending = deps.prompt()
    .then((accepted) => {
      if (accepted === true) deps.recordAcceptance(PHOTO_UPLOAD_DISCLOSURE_VERSION);
      return accepted === true;
    })
    .catch(() => false)
    .finally(() => { pending = null; });
  return pending;
}
