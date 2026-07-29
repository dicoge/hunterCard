import { UserRole, PermissionCheck } from '../types/auth';

const MONTHLY_SCAN_LIMIT = 100;

export function getPermissions(role: UserRole, scanQuotaUsed: number = 0): PermissionCheck {
  const canScan = role !== 'guest';
  const canViewPremium = role === 'subscriber';
  const scanQuota = role === 'subscriber' ? Infinity : MONTHLY_SCAN_LIMIT;

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

export function isQuotaExceeded(role: UserRole, scanQuotaUsed: number): boolean {
  if (role === 'subscriber') return false;
  if (role === 'guest') return true;
  return scanQuotaUsed >= MONTHLY_SCAN_LIMIT;
}

export function getRoleLabel(role: UserRole): string {
  switch (role) {
    case 'guest': return '訪客';
    case 'free_user': return '免費會員';
    case 'subscriber': return '訂閱會員';
  }
}

export function getRoleDescription(role: UserRole): string {
  switch (role) {
    case 'guest':
      return '可瀏覽規則與查卡片，無法使用掃描功能';
    case 'free_user':
      return `每月可掃描 ${MONTHLY_SCAN_LIMIT} 張卡片`;
    case 'subscriber':
      return '無限掃描 + 價格預測與趨勢分析';
  }
}
