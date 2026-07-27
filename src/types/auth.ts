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
