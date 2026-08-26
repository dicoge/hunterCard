import type { ViewStyle } from 'react-native';

export interface UniformGridArgs {
  columns: number;
  containerWidth?: number;
  gap?: number;
}

// DIC-1150: the percentage-only path double-counted the row gap — a fixed 12px
// `columnWrapper.gap` PLUS a `(100 - (n-1)*2) / n` allowance meant each row
// exceeded its container on desktop, giving the page a horizontal scrollbar and
// pushing the third column past the right edge. The pixel-mode overload takes
// the measured container width and the actual gap so the row math closes to
// exactly `containerWidth`.
export function uniformGridItemStyle(columns: number): ViewStyle;
export function uniformGridItemStyle(args: UniformGridArgs): ViewStyle;
export function uniformGridItemStyle(input: number | UniformGridArgs): ViewStyle {
  const args: UniformGridArgs = typeof input === 'number' ? { columns: input } : input;
  const safeColumns = Math.max(1, Math.floor(args.columns));

  // DIC-1192: a single-column FlatList has no `columnWrapperStyle` row —
  // items sit directly on the list's vertical main axis, so a numeric
  // `flexBasis` becomes the wrapper's HEIGHT rather than its width. That
  // is exactly how a 358×card-content wrapper got padded to 358×358 in
  // production, leaving ≈189px of vertical whitespace between cards.
  // Force `flexBasis: 'auto'` here so the card content decides the row
  // height, and keep the width tied to the measured container so the
  // cross-axis still fills the row. Ignoring 2/3-column callers on
  // purpose — their `columnWrapperStyle` puts the wrapper on a horizontal
  // main axis where the numeric `flexBasis` = width contract is correct.
  if (safeColumns === 1) {
    const containerWidth = args.containerWidth;
    if (typeof containerWidth === 'number' && Number.isFinite(containerWidth) && containerWidth > 0) {
      const width = Math.max(0, Math.floor(containerWidth));
      return {
        flexBasis: 'auto',
        width,
        maxWidth: width,
        flexGrow: 0,
        flexShrink: 0,
      };
    }
    return {
      flexBasis: 'auto',
      width: '100%',
      maxWidth: '100%',
      flexGrow: 0,
      flexShrink: 0,
    };
  }

  const containerWidth = args.containerWidth;
  if (typeof containerWidth === 'number' && Number.isFinite(containerWidth) && containerWidth > 0) {
    const gap = Math.max(0, args.gap ?? 0);
    const totalGap = (safeColumns - 1) * gap;
    const width = Math.max(0, Math.floor((containerWidth - totalGap) / safeColumns));
    return {
      flexBasis: width,
      width,
      maxWidth: width,
      flexGrow: 0,
      flexShrink: 0,
    };
  }

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
