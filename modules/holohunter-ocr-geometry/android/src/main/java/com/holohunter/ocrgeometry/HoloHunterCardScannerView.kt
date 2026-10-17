package com.holohunter.ocrgeometry

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Rect
import android.os.SystemClock
import android.util.Base64
import android.util.Size
import androidx.camera.core.AspectRatio
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Continuous CameraX preview + on-device frame analysis for the automatic card scan.
 *
 *  - Preview: PreviewView, FILL_CENTER (cover), never interrupted by analysis; no still
 *    captures, no files, no shutter overlay and no flash while the scanner only looks.
 *  - ImageAnalysis: 4:3 frames (same field of view as the 4:3 preview), backpressure
 *    STRATEGY_KEEP_ONLY_LATEST, at most ONE frame in ML Kit at a time and at most one
 *    analysed frame per `analysisIntervalMs`; frames arriving in between are closed at
 *    once. Analysis runs only while `active` is true (JS turns it off while a scan, a
 *    result or an error is on screen, in the background, unfocused, without consent or
 *    allowance).
 *  - onFrameText: { seq, width, height, blocks: [{ text, boundingBox, lines: [{ text,
 *    boundingBox, elements: [...] }] }] } in the upright frame's pixel space.
 *  - takePicture(quality, base64): one silent still (flash off; the light is the torch),
 *    rotated upright and written as JPEG to the app cache: { uri, width, height, base64? }.
 *  - Lifecycle: bound to the Activity (CameraX stops in the background); release() on
 *    view destroy clears the analyzer, unbinds the use cases, closes ML Kit and the
 *    executor. Events are never sent after release.
 */
@SuppressLint("ViewConstructor")
class HoloHunterCardScannerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  companion object {
    const val DEFAULT_INTERVAL_MS = 700
    private const val MIN_INTERVAL_MS = 250
    private const val MAX_INTERVAL_MS = 5000
  }

  private val onCameraReady by EventDispatcher()
  private val onMountError by EventDispatcher()
  private val onFrameText by EventDispatcher()

  private val previewView = PreviewView(context).apply {
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private var recognizer: TextRecognizer? = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

  private var cameraProvider: ProcessCameraProvider? = null
  private var camera: Camera? = null
  private var preview: Preview? = null
  private var imageCapture: ImageCapture? = null
  private var imageAnalysis: ImageAnalysis? = null

  @Volatile private var analysisActive = false
  @Volatile private var intervalMs = DEFAULT_INTERVAL_MS.toLong()
  @Volatile private var lastAnalysedAt = 0L
  @Volatile private var inFlight = false
  @Volatile private var released = false
  private var torchOn = false
  private var bindRequested = false
  private var readySent = false
  private var frameSeq = 0

  init {
    addView(previewView)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    measureChild(previewView, widthMeasureSpec, heightMeasureSpec)
    setMeasuredDimension(
      android.view.ViewGroup.resolveSize(previewView.measuredWidth, widthMeasureSpec),
      android.view.ViewGroup.resolveSize(previewView.measuredHeight, heightMeasureSpec)
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    previewView.layout(0, 0, right - left, bottom - top)
  }

  fun setAnalysisActive(active: Boolean) {
    analysisActive = active && !released
    if (!active) lastAnalysedAt = 0L
  }

  fun setAnalysisInterval(ms: Int) {
    intervalMs = ms.coerceIn(MIN_INTERVAL_MS, MAX_INTERVAL_MS).toLong()
  }

  fun setTorch(on: Boolean) {
    torchOn = on
    camera?.cameraControl?.enableTorch(on)
  }

  fun ensureCamera() {
    if (bindRequested || released) return
    bindRequested = true
    scope.launch {
      try {
        val owner = appContext.currentActivity as? LifecycleOwner
          ?: throw IllegalStateException("No lifecycle owner for the camera")
        val provider = ProcessCameraProvider.awaitInstance(context)
        if (released) return@launch
        val fourByThree = ResolutionSelector.Builder()
          .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
          .build()
        val previewUseCase = Preview.Builder()
          .setResolutionSelector(fourByThree)
          .build()
          .also { it.surfaceProvider = previewView.surfaceProvider }
        // The recognition still: ~1600 px long edge, like the device picture size the
        // normal scan already chooses (recognitionImagePolicy), so one JPEG fits.
        val captureUseCase = ImageCapture.Builder()
          .setResolutionSelector(
            ResolutionSelector.Builder()
              .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
              .setResolutionStrategy(ResolutionStrategy(Size(1600, 1200), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
              .build()
          )
          .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
          .setFlashMode(ImageCapture.FLASH_MODE_OFF)
          .build()
        val analysisUseCase = ImageAnalysis.Builder()
          .setResolutionSelector(
            ResolutionSelector.Builder()
              .setAspectRatioStrategy(AspectRatioStrategy(AspectRatio.RATIO_4_3, AspectRatioStrategy.FALLBACK_RULE_AUTO))
              .setResolutionStrategy(ResolutionStrategy(Size(1280, 960), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
              .build()
          )
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .build()
        analysisUseCase.setAnalyzer(analysisExecutor) { proxy -> analyze(proxy) }

        provider.unbindAll()
        val bound = provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, captureUseCase, analysisUseCase)
        cameraProvider = provider
        camera = bound
        preview = previewUseCase
        imageCapture = captureUseCase
        imageAnalysis = analysisUseCase
        bound.cameraControl.enableTorch(torchOn)
        bound.cameraInfo.cameraState.observe(owner) { state ->
          if (state.type == CameraState.Type.OPEN && !readySent && !released) {
            readySent = true
            onCameraReady(mapOf<String, Any>())
          }
        }
      } catch (e: Exception) {
        if (!released) onMountError(mapOf("message" to (e.message ?: "Camera could not be started")))
      }
    }
  }

  @SuppressLint("UnsafeOptInUsageError")
  private fun analyze(proxy: ImageProxy) {
    val now = SystemClock.elapsedRealtime()
    val reader = recognizer
    if (released || !analysisActive || inFlight || reader == null || now - lastAnalysedAt < intervalMs) {
      proxy.close()
      return
    }
    val media = proxy.image
    if (media == null) {
      proxy.close()
      return
    }
    lastAnalysedAt = now
    inFlight = true
    val rotation = proxy.imageInfo.rotationDegrees
    val width = if (rotation % 180 == 0) proxy.width else proxy.height
    val height = if (rotation % 180 == 0) proxy.height else proxy.width
    val seq = ++frameSeq
    try {
      reader.process(InputImage.fromMediaImage(media, rotation))
        .addOnSuccessListener(ContextCompat.getMainExecutor(context)) { text ->
          if (!released && analysisActive) {
            onFrameText(mapOf("seq" to seq, "width" to width, "height" to height, "blocks" to mapBlocks(text)))
          }
        }
        .addOnCompleteListener(ContextCompat.getMainExecutor(context)) {
          inFlight = false
          proxy.close()
        }
    } catch (e: Exception) {
      inFlight = false
      proxy.close()
    }
  }

  private fun mapBlocks(text: Text): List<Map<String, Any>> = text.textBlocks.map { block ->
    mapOf(
      "text" to block.text,
      "boundingBox" to box(block.boundingBox),
      "lines" to block.lines.map { line ->
        mapOf(
          "text" to line.text,
          "boundingBox" to box(line.boundingBox),
          "elements" to line.elements.map { element ->
            mapOf("text" to element.text, "boundingBox" to box(element.boundingBox))
          }
        )
      }
    )
  }

  private fun box(rect: Rect?): Map<String, Int> =
    if (rect == null) mapOf("x" to 0, "y" to 0, "width" to 0, "height" to 0)
    else mapOf("x" to rect.left, "y" to rect.top, "width" to rect.width(), "height" to rect.height())

  fun takePicture(quality: Double, base64: Boolean, promise: Promise) {
    val capture = imageCapture
    if (released || capture == null) {
      promise.reject("E_CAMERA_NOT_READY", "The camera is not ready", null)
      return
    }
    capture.takePicture(ContextCompat.getMainExecutor(context), object : ImageCapture.OnImageCapturedCallback() {
      override fun onCaptureSuccess(image: ImageProxy) {
        val rotation = image.imageInfo.rotationDegrees
        val buffer = image.planes[0].buffer
        val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
        image.close()
        scope.launch {
          try {
            val result = withContext(Dispatchers.IO) { writeUpright(bytes, rotation, quality, base64) }
            promise.resolve(result)
          } catch (e: Exception) {
            promise.reject("E_CAPTURE_FAILED", e.message ?: "Capture failed", e)
          }
        }
      }

      override fun onError(exception: ImageCaptureException) {
        promise.reject("E_CAPTURE_FAILED", exception.message ?: "Capture failed", exception)
      }
    })
  }

  private fun writeUpright(jpeg: ByteArray, rotation: Int, quality: Double, base64: Boolean): Map<String, Any> {
    val decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
      ?: throw IllegalStateException("Could not decode the captured image")
    val upright = if (rotation != 0) {
      Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
    } else decoded
    val out = ByteArrayOutputStream()
    upright.compress(Bitmap.CompressFormat.JPEG, (quality * 100).toInt().coerceIn(1, 100), out)
    val data = out.toByteArray()
    val dir = File(context.cacheDir, "HoloHunterScan").apply { mkdirs() }
    val file = File(dir, "${UUID.randomUUID()}.jpg")
    FileOutputStream(file).use { it.write(data) }
    val result = mutableMapOf<String, Any>(
      "uri" to "file://${file.absolutePath}",
      "width" to upright.width,
      "height" to upright.height
    )
    if (base64) result["base64"] = Base64.encodeToString(data, Base64.NO_WRAP)
    if (upright !== decoded) upright.recycle()
    decoded.recycle()
    return result
  }

  fun release() {
    if (released) return
    released = true
    analysisActive = false
    imageAnalysis?.clearAnalyzer()
    val useCases = listOfNotNull(preview, imageCapture, imageAnalysis)
    if (useCases.isNotEmpty()) cameraProvider?.unbind(*useCases.toTypedArray())
    camera = null
    recognizer?.close()
    recognizer = null
    analysisExecutor.shutdown()
    scope.cancel()
  }
}
