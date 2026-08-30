// DIC-1160 stub for `react-native-svg` used only by scripts/test-app-icon-visuals.mjs.
//
// The production module reaches through `unstable_createElement` from
// `react-native` to render real `<svg>`/`<path>` DOM nodes in the shipped web
// build. That entry point is stable for the browser but pulls in a slice of
// react-native-web's private API and platform-suffix (`.web.js`) resolution
// that the plain Node ESM loader will not do. For our regression the only
// thing that matters is that the migrated surfaces mount an AppIcon at all
// (proving they no longer depend on OS emoji glyphs), so this stub renders
// plain DOM tags via React and echoes the `d` prop into a `data-svg-path`
// attribute so the test can assert exactly which registry paths were drawn.
import React from 'react';

function forward(tag) {
  const Component = React.forwardRef(function ForwardedSvgTag(props, ref) {
    const { children, d, style, testID, ...rest } = props;
    const dataAttrs = { 'data-svg-tag': tag };
    if (typeof d === 'string' && d.length > 0) {
      dataAttrs['data-svg-path'] = d;
    }
    if (typeof testID === 'string') {
      dataAttrs['data-testid'] = testID;
    }
    // Some react-native-svg props are not valid HTML attributes; filter to a
    // conservative allowlist that keeps the test-visible ones.
    const passthrough = {};
    for (const key of ['width', 'height', 'viewBox', 'fill', 'stroke', 'aria-hidden', 'aria-label', 'role', 'focusable']) {
      if (rest[key] !== undefined) passthrough[key] = rest[key];
    }
    return React.createElement(tag, { ref, ...passthrough, ...dataAttrs, style }, children);
  });
  Component.displayName = `SvgStub(${tag})`;
  return Component;
}

const Svg = forward('svg');
export default Svg;
export const Circle = forward('circle');
export const ClipPath = forward('clipPath');
export const Defs = forward('defs');
export const Ellipse = forward('ellipse');
export const G = forward('g');
export const Image = forward('image');
export const Line = forward('line');
export const LinearGradient = forward('linearGradient');
export const Mask = forward('mask');
export const Path = forward('path');
export const Pattern = forward('pattern');
export const Polygon = forward('polygon');
export const Polyline = forward('polyline');
export const RadialGradient = forward('radialGradient');
export const Rect = forward('rect');
export const Stop = forward('stop');
export const Symbol = forward('symbol');
export const Text = forward('text');
export const TextPath = forward('textPath');
export const TSpan = forward('tspan');
export const Use = forward('use');
