package com.holohunter.ocrgeometry

import android.graphics.Rect
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * v44: a small luminance grid of the VISIBLE, UPRIGHT preview frame for the card-region
 * detector (src/utils/cardRegionDetector.ts, which owns the detection rules and the
 * reference sampler `lumaGridFromRgba` this mirrors). The long side gets [LONG_SIDE]
 * cells; each cell is the mean of 2 × 2 sample points of the camera's Y plane inside the
 * view-port crop rect, mapped through the frame's rotation. Bounded: at most 64 × 64 × 4
 * reads per analysed frame, no allocation besides the result.
 */
object CardFrameLuma {
  const val LONG_SIDE = 64

  class Grid(val width: Int, val height: Int, val data: IntArray)

  fun sample(y: ByteBuffer, rowStride: Int, pixelStride: Int, crop: Rect, rotation: Int): Grid {
    val cw = max(1, crop.width())
    val ch = max(1, crop.height())
    val visW = if (rotation % 180 == 0) cw else ch
    val visH = if (rotation % 180 == 0) ch else cw
    val gw: Int
    val gh: Int
    if (visW >= visH) {
      gw = LONG_SIDE
      gh = max(1, (LONG_SIDE.toDouble() * visH / visW).roundToInt())
    } else {
      gh = LONG_SIDE
      gw = max(1, (LONG_SIDE.toDouble() * visW / visH).roundToInt())
    }
    val out = IntArray(gw * gh)
    for (gy in 0 until gh) {
      for (gx in 0 until gw) {
        var sum = 0
        for (sy in 0 until 2) {
          for (sx in 0 until 2) {
            // Upright sample point (u, v) inside the visible frame.
            val u = minOf(visW - 1, ((gx + (sx + 0.5) / 2.0) * visW / gw).toInt())
            val v = minOf(visH - 1, ((gy + (sy + 0.5) / 2.0) * visH / gh).toInt())
            // Back to the buffer (relative to the crop): inverse of rotating the buffer
            // clockwise by `rotation` (same convention as frameGeometry.visibleUprightRect).
            val bx: Int
            val by: Int
            when (rotation) {
              90 -> { bx = v; by = ch - 1 - u }
              180 -> { bx = cw - 1 - u; by = ch - 1 - v }
              270 -> { bx = cw - 1 - v; by = u }
              else -> { bx = u; by = v }
            }
            val px = crop.left + bx.coerceIn(0, cw - 1)
            val py = crop.top + by.coerceIn(0, ch - 1)
            sum += y.get(py * rowStride + px * pixelStride).toInt() and 0xFF
          }
        }
        out[gy * gw + gx] = sum shr 2
      }
    }
    return Grid(gw, gh, out)
  }
}
