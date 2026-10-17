package com.holohunter.ocrgeometry

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * HoloHunter v42: Android automatic card scanner view. A CameraX preview whose FRAMES are
 * read on the device (ML Kit text recognition, line/element geometry) while JS keeps
 * analysis active; a single still is taken only when JS asks for it (the automatic
 * trigger or the shutter). See HoloHunterCardScannerView.
 */
class HoloHunterCardScannerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HoloHunterCardScanner")

    View(HoloHunterCardScannerView::class) {
      Events("onCameraReady", "onMountError", "onFrameText")

      Prop("active") { view: HoloHunterCardScannerView, active: Boolean? ->
        view.setAnalysisActive(active ?: false)
      }

      Prop("torch") { view: HoloHunterCardScannerView, torch: Boolean? ->
        view.setTorch(torch ?: false)
      }

      Prop("analysisIntervalMs") { view: HoloHunterCardScannerView, interval: Int? ->
        view.setAnalysisInterval(interval ?: HoloHunterCardScannerView.DEFAULT_INTERVAL_MS)
      }

      OnViewDidUpdateProps { view: HoloHunterCardScannerView ->
        view.ensureCamera()
      }

      OnViewDestroys { view: HoloHunterCardScannerView ->
        view.release()
      }

      AsyncFunction("takePicture") { view: HoloHunterCardScannerView, quality: Double, base64: Boolean, promise: Promise ->
        view.takePicture(quality, base64, promise)
      }
    }
  }
}
