package com.remotex.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import java.io.InputStream

/**
 * Activity principal do RemoteX para Android.
 *
 * Hospeda a interface do cliente (TypeScript, empacotada em assets/web) num WebView com WebRTC
 * (decodificação H.264 por hardware via MediaCodec) e expõe APIs nativas pela [NativeBridge]:
 * teclado do sistema, modo imersivo, orientação, tela sempre ligada, vibração, área de
 * transferência, microfone e gravação de sessões em Filmes/RemoteX.
 *
 * Os arquivos do app são servidos em https://appassets.androidplatform.net/app/ (origem segura),
 * o que habilita getUserMedia (microfone) e WebCrypto mesmo conectando a servidores na rede local.
 */
class MainActivity : Activity() {

    lateinit var webView: WebView
        private set
    private var pendingPermission: PermissionRequest? = null
    private lateinit var bridge: NativeBridge

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)

        webView = WebView(this)
        webView.setBackgroundColor(Color.parseColor("#0B1220"))
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        setContentView(webView)

        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.setSupportZoom(false)
        s.builtInZoomControls = false
        s.displayZoomControls = false
        s.textZoom = 100
        // A interface (origem https) precisa falar com servidores http:// / ws:// na rede local.
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.userAgentString = s.userAgentString + " RemoteXAndroid/1.0"

        bridge = NativeBridge(this)
        webView.addJavascriptInterface(bridge, "RemoteXNative")

        webView.setWebViewClient(object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                if (url.host != ASSET_HOST || url.path?.startsWith("/app/") != true) return null
                return serveAsset(url.path!!.removePrefix("/app/"))
            }

            // Assinatura com String: disponível em todas as versões (a variante com
            // WebResourceRequest só existe a partir da API 24 e delega para esta).
            @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView, urlString: String): Boolean {
                val url = Uri.parse(urlString)
                if (url.host == ASSET_HOST) return false
                // Links externos abrem no navegador do sistema.
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                } catch (_: Exception) {
                }
                return true
            }
        })

        webView.setWebChromeClient(object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handleWebPermission(request) }
            }
        })

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(START_URL + routeFromIntent(intent))
        }
    }

    private fun routeFromIntent(intent: Intent?): String {
        val data: Uri = intent?.data ?: return ""
        if (data.scheme == "remotex" && data.host == "connect") {
            val id = data.path?.replace(Regex("\\D"), "") ?: ""
            if (id.length == 9) return "#/connect/$id"
        }
        return ""
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val route = routeFromIntent(intent)
        if (route.isNotEmpty()) webView.evaluateJavascript("location.hash = '${route.removePrefix("#")}'", null)
    }

    private fun serveAsset(path: String): WebResourceResponse {
        val clean = if (path.isEmpty()) "index.html" else path.substringBefore('?').substringBefore('#')
        return try {
            if (clean.contains("..")) throw SecurityException("caminho inválido")
            val stream: InputStream = assets.open("web/$clean")
            val headers = mapOf("Cache-Control" to "no-cache", "Access-Control-Allow-Origin" to "*")
            WebResourceResponse(mimeOf(clean), if (isText(clean)) "utf-8" else null, 200, "OK", headers, stream)
        } catch (e: Exception) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())
        }
    }

    private fun mimeOf(p: String): String = when (p.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"
        "js" -> "application/javascript"
        "css" -> "text/css"
        "json", "map" -> "application/json"
        "webmanifest" -> "application/manifest+json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "ico" -> "image/x-icon"
        "woff2" -> "font/woff2"
        else -> "application/octet-stream"
    }

    private fun isText(p: String) = p.endsWith(".html") || p.endsWith(".js") || p.endsWith(".css") || p.endsWith(".json") || p.endsWith(".svg") || p.endsWith(".webmanifest")

    // ---- permissões (microfone) -------------------------------------------------------------
    private fun handleWebPermission(request: PermissionRequest) {
        val wantsAudio = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
        if (!wantsAudio) {
            request.deny()
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
            pendingPermission = request
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
        }
    }

    fun requestMicPermission() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MIC) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        val req = pendingPermission
        pendingPermission = null
        if (granted) {
            req?.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
            req?.deny()
            Toast.makeText(this, getString(R.string.mic_denied), Toast.LENGTH_LONG).show()
        }
    }

    // ---- recursos de tela usados pela ponte ---------------------------------------------------
    @Suppress("DEPRECATION")
    fun setImmersiveUi(on: Boolean) {
        val flags = if (on) {
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        } else {
            View.SYSTEM_UI_FLAG_VISIBLE
        }
        window.decorView.systemUiVisibility = flags
        immersive = on
    }

    private var immersive = false

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && immersive) setImmersiveUi(true)
    }

    fun setOrientation(mode: String) {
        requestedOrientation = when (mode) {
            "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    fun keepScreenOn(on: Boolean) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    @Deprecated("Mantido para compatibilidade com Android 7–12")
    override fun onBackPressed() {
        webView.evaluateJavascript("(window.remotexBack && window.remotexBack()) ? 'handled' : 'exit'") { result ->
            if (result?.contains("handled") != true) {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        bridge.closeAll()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val START_URL = "https://$ASSET_HOST/app/index.html"
        private const val REQ_MIC = 41
        val SDK: Int = Build.VERSION.SDK_INT
    }
}
