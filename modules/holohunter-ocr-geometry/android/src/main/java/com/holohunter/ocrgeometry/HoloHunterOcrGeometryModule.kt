package com.holohunter.ocrgeometry

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import com.google.android.gms.tasks.Task
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.max

/**
 * HoloHunter v42 (Android automatic scan). On-device ML Kit text recognition that returns
 * every TEXT BLOCK together with its LINES and ELEMENTS and their boxes.
 *
 * Why: expo-ocr-kit (used for the normal OCR text) exports block boxes only. ML Kit may
 * group the printed card number with neighbouring text into one block on one frame and
 * leave it standalone on the next, so the block box jumps although the number has not
 * moved. The automatic scan must measure the number's own box (element, else line).
 *
 * Image preparation and coordinate space are the same as expo-ocr-kit 0.1.4 on Android
 * (power-of-two down-sampling to ≤ 2000 px, EXIF rotation passed to InputImage, boxes
 * scaled back to source pixels), so boxes stay comparable to the crop the app measures.
 * Local only: nothing is uploaded, nothing is written.
 */
class HoloHunterOcrGeometryModule : Module() {
  private data class Prepared(val image: InputImage, val scale: Int)

  companion object {
    private const val MAX_IMAGE_DIMENSION = 2000
  }

  override fun definition() = ModuleDefinition {
    Name("HoloHunterOcrGeometry")

    AsyncFunction("recognizeGeometry") Coroutine { uri: String ->
      recognizeGeometry(uri)
    }
  }

  private suspend fun recognizeGeometry(uri: String): Map<String, Any> {
    val trimmed = uri.trim()
    require(trimmed.isNotEmpty()) { "Image URI must not be empty." }
    val context = requireNotNull(appContext.reactContext) { "React context is unavailable." }
    val imageUri = Uri.parse(trimmed)
    val prepared = withContext(Dispatchers.IO) { prepare(context.contentResolver, imageUri) }
    val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    return try {
      val result = recognizer.process(prepared.image).await()
      mapResult(result, prepared.scale)
    } finally {
      recognizer.close()
    }
  }

  private fun mapResult(result: Text, scale: Int): Map<String, Any> = mapOf(
    "text" to result.text,
    "blocks" to result.textBlocks.map { block ->
      mapOf(
        "text" to block.text,
        "boundingBox" to box(block.boundingBox, scale),
        "lines" to block.lines.map { line ->
          mapOf(
            "text" to line.text,
            "boundingBox" to box(line.boundingBox, scale),
            "elements" to line.elements.map { element ->
              mapOf("text" to element.text, "boundingBox" to box(element.boundingBox, scale))
            }
          )
        }
      )
    }
  )

  private fun prepare(resolver: ContentResolver, uri: Uri): Prepared {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth > 0 && bounds.outHeight > 0) {
      var sample = 1
      var w = bounds.outWidth
      var h = bounds.outHeight
      while (max(w, h) > MAX_IMAGE_DIMENSION) {
        w /= 2
        h /= 2
        sample *= 2
      }
      val options = BitmapFactory.Options().apply {
        inSampleSize = sample
        inPreferredConfig = Bitmap.Config.ARGB_8888
      }
      val bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
      if (bitmap != null) {
        return Prepared(InputImage.fromBitmap(bitmap, rotation(resolver, uri)), sample)
      }
    }
    return Prepared(InputImage.fromFilePath(requireNotNull(appContext.reactContext), uri), 1)
  }

  private fun rotation(resolver: ContentResolver, uri: Uri): Int =
    resolver.openInputStream(uri)?.use { stream ->
      when (ExifInterface(stream).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90
        ExifInterface.ORIENTATION_ROTATE_180 -> 180
        ExifInterface.ORIENTATION_ROTATE_270 -> 270
        else -> 0
      }
    } ?: 0

  private fun box(rect: Rect?, scale: Int): Map<String, Int> =
    if (rect == null) {
      mapOf("x" to 0, "y" to 0, "width" to 0, "height" to 0)
    } else {
      mapOf(
        "x" to rect.left * scale,
        "y" to rect.top * scale,
        "width" to rect.width() * scale,
        "height" to rect.height() * scale
      )
    }

  private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
    addOnSuccessListener { continuation.resume(it) }
    addOnFailureListener { continuation.resumeWithException(it) }
    addOnCanceledListener { continuation.cancel() }
  }
}
