import type { UserRole, PermissionCheck } from '../types/auth';
import { FEATURES } from '../config/releaseFlags';

// Shared monthly allowance of successful committed scans per device. Guests and
// signed-in free users draw from the SAME local counter (scanQuotaStore), so
// switching role neither resets nor grants extra scans. This is a device-local
// counter (localStorage on web, AsyncStorage on native), not a server quota.
export const MONTHLY_SCAN_LIMIT = 50;

// In Store MVP there is no subscription product, so a `subscriber` role must
// never grant premium behavior (unlimited scan) or surface premium labels/copy.
// Collapse it to `free_user` at the single source of truth so every downstream
// check — quota, permissions, labels — fails closed (CR DIC-913 #2).
export function effectiveRole(role: UserRole): UserRole {
  if (!FEATURES.premium && role === 'subscriber') return 'free_user';
  return role;
}

export function getPermissions(rawRole: UserRole, scanQuotaUsed: number = 0): PermissionCheck {
  const role = effectiveRole(rawRole);
  const canScan = role === 'subscriber' || scanQuotaUsed < MONTHLY_SCAN_LIMIT;
  const canViewPremium = role === 'subscriber';

  return {
    canScan,
    canViewPremium,
    scanQuota: role === 'subscriber' ? -1 : MONTHLY_SCAN_LIMIT,
    scanQuotaUsed,
    scanQuotaRemaining: role === 'subscriber'
      ? -1
      : Math.max(0, MONTHLY_SCAN_LIMIT - scanQuotaUsed),
    role,
  };
}

export function isQuotaExceeded(rawRole: UserRole, scanQuotaUsed: number): boolean {
  const role = effectiveRole(rawRole);
  if (role === 'subscriber') return false;
  return scanQuotaUsed >= MONTHLY_SCAN_LIMIT;
}

// Single scan gate shared by ScanScreen (shutter, gallery, auto-scan, manual
// search). `remaining` is scanQuotaStore.getRemaining() (-1 = unlimited, which
// effectiveRole only allows when FEATURES.premium is on).
export function canScanWithRemaining(rawRole: UserRole, remaining: number): boolean {
  if (effectiveRole(rawRole) === 'subscriber') return true;
  return remaining > 0;
}

export function getRoleLabel(rawRole: UserRole): string {
  const role = effectiveRole(rawRole);
  switch (role) {
    case 'guest': return '訪客';
    case 'free_user': return '免費會員';
    case 'subscriber': return '訂閱會員';
  }
}

export function getRoleDescription(rawRole: UserRole): string {
  const role = effectiveRole(rawRole);
  switch (role) {
    case 'guest':
    case 'free_user':
      return `每月可掃描 ${MONTHLY_SCAN_LIMIT} 張卡片`;
    case 'subscriber':
      return '無限掃描 + 價格預測與趨勢分析';
  }
}
