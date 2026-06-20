package com.voxarcade.wear

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import org.json.JSONArray

/**
 * The entire native app: a single full-screen [WebView] that hosts the existing
 * ProsodyBall web app (bundled under assets/web/). It adds two things the web
 * app can't get reliably inside a WebView on a watch:
 *
 *   - Strong, reliable haptics via the system Vibrator ([HapticsBridge]). The
 *     page's existing navigator.vibrate(...) calls are routed here, so all
 *     biofeedback buzzes work with no changes to app.js.
 *   - Screen-brightness control for the eyes-free "necklace" mode
 *     ([ScreenBridge]) so the watch can run dark against your chest.
 *
 * The watch adaptation layer (watch.css / watch-boot.js) is injected after the
 * page loads; the navigator.vibrate override is injected earlier (onPageStarted)
 * so the engine detects haptic support at startup.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private val main = Handler(Looper.getMainLooper())

    private val requestMic =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            loadApp() // load regardless; the page shows its own mic-error UI if denied
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Creating a WebView throws on devices where Android System WebView is
        // missing or disabled (seen on some Samsung watches). Catch everything so
        // the watch shows a readable message instead of silently failing to open.
        try {
            webView = WebView(this).apply {
                systemUiVisibility = (View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION)

                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    allowFileAccess = true
                    allowContentAccess = true
                    @Suppress("DEPRECATION")
                    allowFileAccessFromFileURLs = true
                }

                addJavascriptInterface(HapticsBridge(this@MainActivity), "AndroidHaptics")
                addJavascriptInterface(ScreenBridge(), "AndroidScreen")

                webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                        super.onPageStarted(view, url, favicon)
                        // Route the page's navigator.vibrate(...) to the system vibrator,
                        // injected before app.js runs so it reports haptic support.
                        view.evaluateJavascript(VIBRATE_SHIM, null)
                    }

                    override fun onPageFinished(view: WebView, url: String?) {
                        super.onPageFinished(view, url)
                        injectWatchLayer(view)
                    }

                    override fun onReceivedError(
                        view: WebView,
                        request: WebResourceRequest,
                        error: WebResourceError
                    ) {
                        super.onReceivedError(view, request, error)
                        if (request.isForMainFrame) {
                            showError(
                                "Couldn't load the app page:\n" +
                                    "${error.description}\n${request.url}"
                            )
                        }
                    }
                }

                webChromeClient = object : WebChromeClient() {
                    override fun onPermissionRequest(request: PermissionRequest) {
                        val wanted = request.resources.filter {
                            it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                        }.toTypedArray()
                        if (wanted.isNotEmpty()) request.grant(wanted) else request.deny()
                    }
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "WebView init failed", t)
            showError(
                "This watch can't start the app's WebView.\n\n" +
                    "Android System WebView may be missing or disabled. Check the " +
                    "Play Store on the watch for \"Android System WebView\" and enable/update it.\n\n" +
                    Log.getStackTraceString(t)
            )
            return
        }

        setContentView(webView)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED
        ) {
            loadApp()
        } else {
            requestMic.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    /** Replace the screen with a scrollable error message (no logcat needed). */
    private fun showError(message: String) {
        main.post {
            val text = TextView(this).apply {
                setText(message)
                setTextColor(Color.WHITE)
                setBackgroundColor(Color.BLACK)
                textSize = 12f
                gravity = Gravity.CENTER_VERTICAL
                setPadding(24, 24, 24, 24)
            }
            val scroll = ScrollView(this).apply {
                setBackgroundColor(Color.BLACK)
                addView(text)
            }
            setContentView(scroll)
        }
    }

    private fun loadApp() {
        webView.loadUrl("file:///android_asset/web/index.html?watch=1")
    }

    private fun injectWatchLayer(view: WebView) {
        val js = """
            (function() {
              if (document.getElementById('watch-css')) return;
              var link = document.createElement('link');
              link.id = 'watch-css';
              link.rel = 'stylesheet';
              link.href = 'watch.css';
              document.head.appendChild(link);
              var s = document.createElement('script');
              s.id = 'watch-boot';
              s.src = 'watch-boot.js';
              document.body.appendChild(s);
            })();
        """.trimIndent()
        view.evaluateJavascript(js, null)
    }

    /** Set a low screen brightness for the eyes-free necklace mode, or restore it. */
    fun setLowBrightness(low: Boolean) {
        main.post {
            val lp = window.attributes
            lp.screenBrightness =
                if (low) 0.02f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            window.attributes = lp
        }
    }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    // ---- JS bridges -------------------------------------------------------

    /** Exposed to JS as `AndroidHaptics`. */
    private class HapticsBridge(context: Context) {
        private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)
                ?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

        /** `pattern` is a JSON number or array of millisecond on/off durations. */
        @JavascriptInterface
        fun vibrate(pattern: String) {
            val v = vibrator ?: return
            if (!v.hasVibrator()) return
            try {
                val timings = parseTimings(pattern)
                if (timings.isEmpty()) return
                // Waveform timings alternate off/on starting with an initial 0 delay.
                val waveform = LongArray(timings.size + 1)
                for (i in timings.indices) waveform[i + 1] = timings[i]
                v.vibrate(VibrationEffect.createWaveform(waveform, -1))
            } catch (_: Exception) {
            }
        }

        @JavascriptInterface
        fun cancel() {
            vibrator?.cancel()
        }

        private fun parseTimings(pattern: String): LongArray {
            return try {
                val arr = JSONArray(pattern)
                LongArray(arr.length()) { arr.getLong(it).coerceAtLeast(0) }
            } catch (_: Exception) {
                // Scalar duration, e.g. navigator.vibrate(200).
                val ms = pattern.trim().toDoubleOrNull()?.toLong() ?: return LongArray(0)
                longArrayOf(ms.coerceAtLeast(0))
            }
        }
    }

    /** Exposed to JS as `AndroidScreen`. */
    private inner class ScreenBridge {
        @JavascriptInterface
        fun setLowBrightness(low: Boolean) = this@MainActivity.setLowBrightness(low)
    }

    companion object {
        private const val TAG = "VoxArcadeWear"

        // Defines navigator.vibrate to forward to the native vibrator. Runs before
        // app.js, so the engine's `'vibrate' in navigator` check passes and every
        // existing haptic call (alert rules, resonance drift, test) buzzes for real.
        private const val VIBRATE_SHIM = """
            (function() {
              if (!window.AndroidHaptics) return;
              try {
                navigator.vibrate = function(pattern) {
                  try { window.AndroidHaptics.vibrate(JSON.stringify(pattern)); } catch (e) {}
                  return true;
                };
              } catch (e) {}
            })();
        """
    }
}
