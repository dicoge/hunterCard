import { useWindowDimensions } from 'react-native';

export const DESKTOP_BREAKPOINT = 768;

export interface Breakpoint {
  width: number;
  height: number;
  isDesktop: boolean;
  isWide: boolean;
}

/**
 * Responsive breakpoint hook.
 * `isDesktop` (>= 768px) switches on the PC layout; below that the mobile UI stays untouched.
 * `isWide` (>= 1100px) allows extra columns on very wide screens.
 */
export function useBreakpoint(): Breakpoint {
  const { width, height } = useWindowDimensions();
  return {
    width,
    height,
    isDesktop: width >= DESKTOP_BREAKPOINT,
    isWide: width >= 1100,
  };
}
