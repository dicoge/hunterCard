export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface CropOptions {
  padXRatio?: number;
  padYRatio?: number;
}

export function clampRectToBounds(rect: Rect, bounds: Size): Rect {
  const x = Math.max(0, Math.min(bounds.width, rect.x));
  const y = Math.max(0, Math.min(bounds.height, rect.y));
  const maxW = Math.max(0, bounds.width - x);
  const maxH = Math.max(0, bounds.height - y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(maxW, rect.width)),
    height: Math.max(0, Math.min(maxH, rect.height)),
  };
}

/**
 * Convert a rectangle measured in the rendered video element coordinate space
 * to source video pixels when CSS object-fit: cover is used.
 */
export function mapCoverRectToSource(
  rendered: Size,
  source: Size,
  rect: Rect,
  options: CropOptions = {},
): Rect {
  if (rendered.width <= 0 || rendered.height <= 0 || source.width <= 0 || source.height <= 0) {
    return { x: 0, y: 0, width: source.width, height: source.height };
  }

  const scale = Math.max(rendered.width / source.width, rendered.height / source.height);
  const displayedWidth = source.width * scale;
  const displayedHeight = source.height * scale;
  const offsetX = (displayedWidth - rendered.width) / 2;
  const offsetY = (displayedHeight - rendered.height) / 2;

  const padX = rect.width * (options.padXRatio ?? 0);
  const padY = rect.height * (options.padYRatio ?? 0);
  const padded = {
    x: rect.x - padX,
    y: rect.y - padY,
    width: rect.width + padX * 2,
    height: rect.height + padY * 2,
  };

  return clampRectToBounds({
    x: (padded.x + offsetX) / scale,
    y: (padded.y + offsetY) / scale,
    width: padded.width / scale,
    height: padded.height / scale,
  }, source);
}

/**
 * Convert an overlay rectangle measured in viewport/page coordinates to source
 * video pixels. The overlay and video elements can have non-zero origins; only
 * the overlay's video-local rectangle is passed into the object-fit: cover map.
 */
export function mapViewportRectToSource(
  videoViewport: Rect,
  source: Size,
  overlayViewport: Rect,
  options: CropOptions = {},
): Rect {
  return mapCoverRectToSource(
    { width: videoViewport.width, height: videoViewport.height },
    source,
    {
      x: overlayViewport.x - videoViewport.x,
      y: overlayViewport.y - videoViewport.y,
      width: overlayViewport.width,
      height: overlayViewport.height,
    },
    options,
  );
}