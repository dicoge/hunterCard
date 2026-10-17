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
import androidx.camera.core.UseCaseGroup
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
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Continuous CameraX preview + on-device frame analysis for the automatic card scan.
 *
 *  - ONE field of view: Preview, ImageAnalysis and ImageCapture are bound as a
 *    UseCaseGroup with the PreviewView's ViewPort, so CameraX gives every analysed frame
 *    and every still a crop rect equal to what the preview shows (independent of each
 *    stream's own resolution / aspect fallback / sensor rotation). Frame events carry that
 *    crop rect, the buffer size and the rotation; the still is cropped to it and rotated
 *    upright, so the still IS the visible preview.
 *  - Frames: STRATEGY_KEEP_ONLY_LATEST, at most one frame in ML Kit, at most one analysed
 *    frame per `analysisIntervalMs`; analysis only while `active`. Every analysis is tagged
 *    with the JS `session` and a native `generation` taken when the frame STARTS; a result
 *    is delivered only if both are unchanged and analysis is still on — a completion from
 *    before a deactivate/reactivate (background, blur, a result on screen…) is dropped.
 *  - Stills: each takePicture is a pending record settled exactly once (success, failure
 *    or release); the ImageProxy is always closed; JPEG work runs on an IO executor that
 *    release() does not cancel, and a file written for a capture that was released / no
 *    longer wanted is deleted.
 *  - Lifecycle: bound to the Activity; release() on view destroy rejects pending
 *    captures, stops analysis, unbinds, closes ML Kit and the executors. No events after.
 */
@SuppressLint("ViewConstructor")
class HoloHunterCardScannerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  companion object {
    const val DEFAULT_INTERVAL_MS = 700
    private const val MIN_INTERVAL_MS = 250
    private const val MAX_INTERVAL_MS = 5000
  }

  /** One still capture in flight; settled exactly once. */
  private class PendingCapture(private val promise: Promise) {
    private val settled = AtomicBoolean(false)
    @Volatile var file: File? = null
    val isSettled: Boolean get() = settled.get()
    fun resolve(value: Any): Boolean {
      if (!settled.compareAndSet(false, true)) return false
      promise.resolve(value)
      return true
    }
    fun reject(code: String, message: String, cause: Throwable?): Boolean {
      if (!settled.compareAndSet(false, true)) return false
      promise.reject(code, message, cause)
      return true
    }
  }

  private val onCameraReady by EventDispatcher()
  private val onMountError by EventDispatcher()
  private val onFrameText by EventDispatcher()

  private val previewView = PreviewView(context).apply {
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val pendingCaptures: MutableSet<PendingCapture> =
    Collections.newSetFromMap(ConcurrentHashMap<PendingCapture, Boolean>())
  private var recognizer: TextRecognizer? = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

  private var cameraProvider: ProcessCameraProvider? = null
  private var camera: Camera? = null
  private var preview: Preview? = null
  private var imageCapture: ImageCapture? = null
  private var imageAnalysis: ImageAnalysis? = null

  @Volatile private var analysisActive = false
  @Volatile private var session = 0
  @Volatile private var generation = 0
  @Volatile private var intervalMs = DEFAULT_INTERVAL_MS.toLong()
  @Volatile private var lastAnalysedAt = 0L
  @Volatile private var inFlight = false
  @Volatile private var released = false
  private var torchOn = false
  private var bindRequested = false
  private var bindStarted = false
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
    // The ViewPort needs the laid-out PreviewView size.
    if (bindRequested && !bindStarted && right - left > 0 && bottom - top > 0) {
      previewView.post { startBind() }
    }
  }

  fun setAnalysisActive(active: Boolean) {
    val next = active && !released
    if (next != analysisActive) {
      generation += 1          // anything started under the previous state is void
      lastAnalysedAt = 0L
    }
    analysisActive = next
  }

  fun setSession(value: Int) {
    if (value != session) {
      session = value
      generation += 1
    }
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
    if (previewView.width > 0 && previewView.height > 0) startBind()
  }

  private fun startBind() {
    if (bindStarted || released) return
    bindStarted = true
    scope.launch {
      try {
        val owner = appContext.currentActivity as? LifecycleOwner
          ?: throw IllegalStateException("No lifecycle owner for the camera")
        val viewPort = previewView.viewPort
          ?: throw IllegalStateException("The preview has no view port yet")
        val provider = ProcessCameraProvider.awaitInstance(context)
        if (released) return@launch
        val fourByThree = ResolutionSelector.Builder()
          .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
          .build()
        val previewUseCase = Preview.Builder()
          .setResolutionSelector(fourByThree)
          .build()
          .also { it.surfaceProvider = previewView.surfaceProvider }
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
        val group = UseCaseGroup.Builder()
          .setViewPort(viewPort)
          .addUseCase(previewUseCase)
          .addUseCase(captureUseCase)
          .addUseCase(analysisUseCase)
          .build()

        provider.unbindAll()
        val bound = provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, group)
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
    // Ownership of this analysis: the state it STARTED in.
    val startSession = session
    val startGeneration = generation
    val rotation = proxy.imageInfo.rotationDegrees
    val bufferWidth = proxy.width
    val bufferHeight = proxy.height
    val crop = Rect(proxy.cropRect)
    val width = if (rotation % 180 == 0) bufferWidth else bufferHeight
    val height = if (rotation % 180 == 0) bufferHeight else bufferWidth
    val seq = ++frameSeq
    try {
      reader.process(InputImage.fromMediaImage(media, rotation))
        .addOnSuccessListener(ContextCompat.getMainExecutor(context)) { text ->
          if (!released && analysisActive && startSession == session && startGeneration == generation) {
            onFrameText(
              mapOf(
                "seq" to seq,
                "session" to startSession,
                "width" to width,
                "height" to height,
                "rotation" to rotation,
                "bufferWidth" to bufferWidth,
                "bufferHeight" to bufferHeight,
                "cropRect" to mapOf("x" to crop.left, "y" to crop.top, "width" to crop.width(), "height" to crop.height()),
                "blocks" to mapBlocks(text)
              )
            )
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
    val pending = PendingCapture(promise)
    if (released || capture == null) {
      pending.reject("E_CAMERA_NOT_READY", "The camera is not ready", null)
      return
    }
    pendingCaptures.add(pending)
    capture.takePicture(ContextCompat.getMainExecutor(context), object : ImageCapture.OnImageCapturedCallback() {
      override fun onCaptureSuccess(image: ImageProxy) {
        var bytes: ByteArray? = null
        var rotation = 0
        var crop: Rect? = null
        try {
          if (!released && !pending.isSettled) {
            val buffer = image.planes[0].buffer
            bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
            rotation = image.imageInfo.rotationDegrees
            crop = Rect(image.cropRect)
          }
        } catch (e: Exception) {
          bytes = null
        } finally {
          image.close()
        }
        val data = bytes
        val visible = crop
        if (data == null || visible == null) {
          pending.reject("E_CAMERA_RELEASED", "The camera was closed", null)
          pendingCaptures.remove(pending)
          return
        }
        try {
          ioExecutor.execute { process(pending, data, rotation, visible, quality, base64) }
        } catch (e: RejectedExecutionException) {
          pending.reject("E_CAMERA_RELEASED", "The camera was closed", e)
          pendingCaptures.remove(pending)
        }
      }

      override fun onError(exception: ImageCaptureException) {
        pending.reject("E_CAPTURE_FAILED", exception.message ?: "Capture failed", exception)
        pendingCaptures.remove(pending)
      }
    })
  }

  private fun process(pending: PendingCapture, jpeg: ByteArray, rotation: Int, crop: Rect, quality: Double, base64: Boolean) {
    try {
      if (released || pending.isSettled) return
      val result = writeVisibleUpright(pending, jpeg, rotation, crop, quality, base64)
      if (!pending.resolve(result)) pending.file?.delete()      // released meanwhile: no orphan file
    } catch (e: Exception) {
      pending.file?.delete()
      pending.reject("E_CAPTURE_FAILED", e.message ?: "Capture failed", e)
    } finally {
      pendingCaptures.remove(pending)
    }
  }

  /** Crop the still to the shared view-port rect (buffer coordinates), then rotate upright. */
  private fun writeVisibleUpright(pending: PendingCapture, jpeg: ByteArray, rotation: Int, crop: Rect, quality: Double, base64: Boolean): Map<String, Any> {
    val decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
      ?: throw IllegalStateException("Could not decode the captured image")
    val left = crop.left.coerceIn(0, decoded.width - 1)
    val top = crop.top.coerceIn(0, decoded.height - 1)
    val cw = crop.width().coerceIn(1, decoded.width - left)
    val ch = crop.height().coerceIn(1, decoded.height - top)
    val matrix = Matrix().apply { if (rotation != 0) postRotate(rotation.toFloat()) }
    val visible = Bitmap.createBitmap(decoded, left, top, cw, ch, matrix, true)
    val out = ByteArrayOutputStream()
    visible.compress(Bitmap.CompressFormat.JPEG, (quality * 100).toInt().coerceIn(1, 100), out)
    val data = out.toByteArray()
    val dir = File(context.cacheDir, "HoloHunterScan").apply { mkdirs() }
    val file = File(dir, "${UUID.randomUUID()}.jpg")
    pending.file = file
    FileOutputStream(file).use { it.write(data) }
    val result = mutableMapOf<String, Any>(
      "uri" to "file://${file.absolutePath}",
      "width" to visible.width,
      "height" to visible.height
    )
    if (base64) result["base64"] = Base64.encodeToString(data, Base64.NO_WRAP)
    if (visible !== decoded) visible.recycle()
    decoded.recycle()
    return result
  }

  fun release() {
    if (released) return
    released = true
    analysisActive = false
    generation += 1
    for (pending in pendingCaptures.toList()) {
      pending.reject("E_CAMERA_RELEASED", "The camera was closed", null)
    }
    imageAnalysis?.clearAnalyzer()
    val useCases = listOfNotNull(preview, imageCapture, imageAnalysis)
    if (useCases.isNotEmpty()) cameraProvider?.unbind(*useCases.toTypedArray())
    camera = null
    recognizer?.close()
    recognizer = null
    analysisExecutor.shutdown()
    ioExecutor.shutdown()           // queued JPEG work still runs and deletes its file
    scope.cancel()                  // binding only; no capture settlement depends on it
  }
}
