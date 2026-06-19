package com.voxarcade.wear

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

/**
 * The entire native app: a single full-screen [WebView] that hosts the existing
 * ProsodyBall web app (bundled under assets/web/). The watch adaptation layer
 * (watch.css / watch-boot.js) is injected after the page loads so the canonical
 * index.html is never edited.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView

    private val requestMic =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            // Load regardless: if denied, the page surfaces its own mic-error UI.
            loadApp()
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Keep the watch awake during a training session.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this).apply {
            // Full-bleed, immersive layout for the round display.
            systemUiVisibility = (View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION)

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                // Audio (mic-driven) must start without a hardware media gesture.
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = true
                allowContentAccess = true
                @Suppress("DEPRECATION")
                allowFileAccessFromFileURLs = true
            }

            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String?) {
                    super.onPageFinished(view, url)
                    injectWatchLayer(view)
                }
            }

            // Grant the page's getUserMedia() mic request (we already hold RECORD_AUDIO).
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    val wanted = request.resources.filter {
                        it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                    }.toTypedArray()
                    if (wanted.isNotEmpty()) request.grant(wanted) else request.deny()
                }
            }
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

    private fun loadApp() {
        // ?watch=1 tells watch-boot.js to apply the wrist-sized layout.
        webView.loadUrl("file:///android_asset/web/index.html?watch=1")
    }

    /**
     * Append the watch stylesheet + boot script to the loaded page without
     * touching index.html on disk.
     */
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

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
