export type AuthProvider = 'google' | 'apple';

export interface ProviderUserInfo {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

export interface GoogleUser extends ProviderUserInfo {
  givenName?: string;
  familyName?: string;
}

export interface AppleUser extends ProviderUserInfo {
  realUserStatus?: number;
}

export interface LinkedIdentity {
  provider: AuthProvider;
  providerId: string;
  email: string;
  displayName: string;
  photoUrl?: string;
  linkedAt: string;
}

export interface HoloUser {
  internalId: string;
  displayName: string;
  primaryEmail?: string;
  photoUrl?: string;
  // Server-authoritative role. Never inferred client-side: hard-coding it on
  // login/restore silently downgraded subscribers (CR DIC-866 #4).
  role: 'free_user' | 'subscriber';
  linkedProviders: LinkedIdentity[];
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  provider: AuthProvider;
}

export interface AuthState {
  user: HoloUser | null;
  tokens: AuthTokens | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export type UserRole = 'guest' | 'free_user' | 'subscriber';

export interface PermissionCheck {
  canScan: boolean;
  canViewPremium: boolean;
  scanQuota: number;
  scanQuotaUsed: number;
  scanQuotaRemaining: number;
  role: UserRole;
}

export interface AccountDeletionResult {
  deletedInternalUser: boolean;
  deletedProviders: number;
  deletedData: string[];
}

export interface AuthUser {
  id: string;
  name: string | null;
  email: string | null;
  provider: AuthProvider;
}

export interface AuthSession {
  user: AuthUser;
  identityToken: string | null;
  authorizationCode: string | null;
  createdAt: string;
}
