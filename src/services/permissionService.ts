import { UserRole, PermissionCheck } from '../types/auth';
import { FEATURES } from '../config/releaseFlags';

const MONTHLY_SCAN_LIMIT = 100;

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
  const canScan = role !== 'guest';
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
  if (role === 'guest') return true;
  return scanQuotaUsed >= MONTHLY_SCAN_LIMIT;
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
      return '可瀏覽規則與查卡片，無法使用掃描功能';
    case 'free_user':
      return `每月可掃描 ${MONTHLY_SCAN_LIMIT} 張卡片`;
    case 'subscriber':
      return '無限掃描 + 價格預測與趨勢分析';
  }
}
