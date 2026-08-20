import type { ViewStyle } from 'react-native';

export function uniformGridItemStyle(columns: number): ViewStyle {
  const safeColumns = Math.max(1, Math.floor(columns));
  const gapAllowance = safeColumns > 1 ? (safeColumns - 1) * 2 : 0;
  const width = (100 - gapAllowance) / safeColumns;
  const percentage = `${width}%` as `${number}%`;
  return {
    flexBasis: percentage,
    maxWidth: percentage,
    flexGrow: 0,
    flexShrink: 1,
  };
}
