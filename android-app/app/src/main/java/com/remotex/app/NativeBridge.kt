package com.remotex.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.Vibrator
import android.provider.MediaStore
import android.util.Base64
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Ponte JavaScript ↔ Android exposta como `window.RemoteXNative`.
 * Métodos @JavascriptInterface rodam numa thread do WebView; operações de interface são
 * repassadas para a thread principal.
 */
class NativeBridge(private val activity: MainActivity) {
    private val main = Handler(Looper.getMainLooper())
    private val recordings = ConcurrentHashMap<String, Recording>()
    private val seq = AtomicInteger(1)

    private class Recording(val name: String, val stream: OutputStream, val uri: Uri?, val file: File?)

    private fun ui(block: () -> Unit) = main.post(block)

    @JavascriptInterface
    fun deviceModel(): String {
        val m = Build.MODEL ?: "Android"
        val brand = Build.MANUFACTURER ?: ""
        return if (m.lowercase().startsWith(brand.lowercase())) m else "$brand $m".trim()
    }

    @JavascriptInterface
    fun appVersion(): String = "1.0.0"

    @JavascriptInterface
    fun defaultServer(): String = activity.getString(R.string.default_server)

    @JavascriptInterface
    fun showKeyboard() = ui {
        val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        activity.webView.requestFocus()
        imm.showSoftInput(activity.webView, InputMethodManager.SHOW_IMPLICIT)
    }

    @JavascriptInterface
    fun hideKeyboard() = ui {
        val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(activity.webView.windowToken, 0)
    }

    @JavascriptInterface
    fun setImmersive(on: Boolean) = ui { activity.setImmersiveUi(on) }

    @JavascriptInterface
    fun setOrientation(mode: String) = ui { activity.setOrientation(mode) }

    @JavascriptInterface
    fun keepScreenOn(on: Boolean) = ui { activity.keepScreenOn(on) }

    @JavascriptInterface
    @Suppress("DEPRECATION")
    fun vibrate(ms: Int) {
        val v = activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        if (v.hasVibrator()) v.vibrate(ms.coerceIn(1, 200).toLong())
    }

    @JavascriptInterface
    fun getClipboard(): String {
        // Leitura precisa acontecer na thread principal com o app em primeiro plano.
        var text = ""
        val latch = java.util.concurrent.CountDownLatch(1)
        ui {
            try {
                val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(activity)?.toString() ?: ""
            } catch (_: Exception) {
            }
            latch.countDown()
        }
        latch.await(2, java.util.concurrent.TimeUnit.SECONDS)
        return text
    }

    @JavascriptInterface
    fun setClipboard(text: String) = ui {
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("RemoteX", text))
    }

    @JavascriptInterface
    fun requestMicPermission() = ui { activity.requestMicPermission() }

    @JavascriptInterface
    fun hasMicPermission(): Boolean =
        activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED

    // ---- gravação no celular (Filmes/RemoteX) ------------------------------------------------
    @JavascriptInterface
    fun recBegin(name: String, mime: String): String {
        val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val id = "rec${seq.getAndIncrement()}"
        val rec = if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, safe)
                put(MediaStore.MediaColumns.MIME_TYPE, mime.substringBefore(';'))
                put("relative_path", "${Environment.DIRECTORY_MOVIES}/RemoteX")
                put("is_pending", 1)
            }
            val uri = activity.contentResolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("Não foi possível criar o arquivo de gravação")
            Recording(safe, activity.contentResolver.openOutputStream(uri)!!, uri, null)
        } else {
            val dir = File(activity.getExternalFilesDir(Environment.DIRECTORY_MOVIES), "RemoteX").apply { mkdirs() }
            val f = File(dir, safe)
            Recording(safe, FileOutputStream(f), null, f)
        }
        recordings[id] = rec
        return id
    }

    @JavascriptInterface
    fun recChunk(id: String, base64: String): Boolean {
        val rec = recordings[id] ?: return false
        return try {
            rec.stream.write(Base64.decode(base64, Base64.DEFAULT))
            true
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun recEnd(id: String): String {
        val rec = recordings.remove(id) ?: return ""
        try {
            rec.stream.flush()
            rec.stream.close()
        } catch (_: Exception) {
        }
        if (rec.uri != null && Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply { put("is_pending", 0) }
            activity.contentResolver.update(rec.uri, values, null, null)
            return "Filmes/RemoteX"
        }
        return rec.file?.absolutePath ?: ""
    }

    @JavascriptInterface
    fun listRecordings(): String {
        val out = StringBuilder("[")
        var first = true
        fun add(name: String, size: Long, date: Long) {
            if (!first) out.append(',')
            first = false
            out.append("{\"name\":").append(jsonString(name)).append(",\"size\":").append(size)
                .append(",\"createdAt\":").append(jsonString(iso(date))).append('}')
        }
        if (Build.VERSION.SDK_INT >= 29) {
            val projection = arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED)
            activity.contentResolver.query(
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI, projection, "relative_path LIKE ?", arrayOf("%Movies/RemoteX%"),
                MediaStore.MediaColumns.DATE_ADDED + " DESC",
            )?.use { c ->
                while (c.moveToNext()) add(c.getString(0), c.getLong(1), c.getLong(2) * 1000)
            }
        } else {
            val dir = File(activity.getExternalFilesDir(Environment.DIRECTORY_MOVIES), "RemoteX")
            dir.listFiles()?.sortedByDescending { it.lastModified() }?.forEach { add(it.name, it.length(), it.lastModified()) }
        }
        return out.append(']').toString()
    }

    @JavascriptInterface
    fun openRecording(name: String) = ui {
        if (Build.VERSION.SDK_INT < 29) {
            Toast.makeText(activity, "Arquivo salvo em Android/data/com.remotex.app/files/Movies/RemoteX", Toast.LENGTH_LONG).show()
            return@ui
        }
        activity.contentResolver.query(
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.MediaColumns._ID),
            MediaStore.MediaColumns.DISPLAY_NAME + " = ?", arrayOf(name), null,
        )?.use { c ->
            if (c.moveToFirst()) {
                val uri = Uri.withAppendedPath(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, c.getLong(0).toString())
                val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "video/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                try {
                    activity.startActivity(intent)
                } catch (_: Exception) {
                    Toast.makeText(activity, "Nenhum player de vídeo encontrado", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    fun closeAll() {
        for (id in recordings.keys.toList()) recEnd(id)
    }

    private fun iso(ms: Long): String {
        val f = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
        f.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return f.format(java.util.Date(ms))
    }

    private fun jsonString(s: String): String {
        val sb = StringBuilder("\"")
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                else -> if (ch < ' ') sb.append(String.format("\\u%04x", ch.code)) else sb.append(ch)
            }
        }
        return sb.append('"').toString()
    }
}
