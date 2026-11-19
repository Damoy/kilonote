package dev.damoy.kilonote

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class AccessArgs {
  var request: Boolean = false
}

@InvokeArg
class OpenedArgs {
  lateinit var inbox: String
}

/**
 * The phone's files, for the Rust backend (src-tauri/src/lib.rs, which calls it):
 * - "All files access", which lets KiloNote open any folder like on a computer
 *   (asked only when the user chooses Open folder or Open file);
 * - the files the system hands to KiloNote ("Open with", "Edit with"), turned into
 *   paths; a file that has no path (an e-mail attachment, a cloud file) is copied
 *   into the inbox folder given by the backend.
 * Nothing here opens or runs a file: it only reads paths and copies text.
 */
@TauriPlugin
class StoragePlugin(private val activity: Activity) : Plugin(activity) {
  private val opened = mutableListOf<Uri>()

  override fun load(webView: WebView) {
    remember(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    remember(intent)
  }

  private fun remember(intent: Intent?) {
    if (intent == null || (intent.action != Intent.ACTION_VIEW && intent.action != Intent.ACTION_EDIT)) return
    val uri = intent.data ?: return
    synchronized(opened) { opened.add(uri) }
  }

  private fun granted() = Environment.isExternalStorageManager()

  private fun accessState(): JSObject {
    val state = JSObject()
    state.put("granted", granted())
    state.put("root", Environment.getExternalStorageDirectory().absolutePath)
    return state
  }

  /** Whether KiloNote may read the phone's files; with request, opens the system screen that allows it. */
  @Command
  fun access(invoke: Invoke) {
    val args = invoke.parseArgs(AccessArgs::class.java)
    if (granted() || !args.request) {
      invoke.resolve(accessState())
      return
    }
    val forApp = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${activity.packageName}"))
    val general = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
    val intent = if (forApp.resolveActivity(activity.packageManager) != null) forApp else general
    startActivityForResult(invoke, intent, "accessDone")
  }

  @ActivityCallback
  fun accessDone(invoke: Invoke, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
    invoke.resolve(accessState())
  }

  /** The files handed to KiloNote since the last call, as paths. */
  @Command
  fun takeOpened(invoke: Invoke) {
    val args = invoke.parseArgs(OpenedArgs::class.java)
    val uris = synchronized(opened) { opened.toList().also { opened.clear() } }
    val paths = JSArray()
    for (uri in uris) {
      val path = try {
        pathOf(uri) ?: copyToInbox(uri, File(args.inbox))
      } catch (e: Exception) {
        null
      }
      if (path != null) paths.put(path)
    }
    val result = JSObject()
    result.put("paths", paths)
    invoke.resolve(result)
  }

  /** The file behind a uri, when it has a path that KiloNote can read. */
  private fun pathOf(uri: Uri): String? {
    val candidate = when {
      uri.scheme == "file" -> uri.path
      uri.scheme != "content" -> null
      uri.authority == "com.android.externalstorage.documents" && DocumentsContract.isDocumentUri(activity, uri) -> {
        // "primary:Documents/notes.txt", or "1234-ABCD:notes.txt" on an SD card.
        val id = DocumentsContract.getDocumentId(uri)
        val volume = id.substringBefore(':')
        val rel = id.substringAfter(':', "")
        val base = if (volume == "primary") Environment.getExternalStorageDirectory().absolutePath else "/storage/$volume"
        if (rel.isEmpty()) base else "$base/$rel"
      }
      uri.authority == "com.android.providers.downloads.documents" &&
        DocumentsContract.isDocumentUri(activity, uri) &&
        DocumentsContract.getDocumentId(uri).startsWith("raw:") ->
        DocumentsContract.getDocumentId(uri).removePrefix("raw:")
      // File managers that put the path in the uri (".../file:///storage/emulated/0/…").
      Uri.decode(uri.toString()).contains("file:///") ->
        Uri.decode(uri.toString()).substringAfter("file://")
      else -> dataColumn(uri)
    }
    return candidate?.takeIf { File(it).let { f -> f.isFile && f.canRead() } }
  }

  private fun dataColumn(uri: Uri): String? = try {
    activity.contentResolver.query(uri, arrayOf("_data"), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }
  } catch (e: Exception) {
    null
  }

  /** A copy of a file that has no path, in the inbox (under a free name). */
  private fun copyToInbox(uri: Uri, inbox: File): String? {
    val name = displayName(uri)?.replace(Regex("[\\\\/:*?\"<>|]"), "-")?.takeIf { it.isNotBlank() } ?: "received.txt"
    inbox.mkdirs()
    var target = File(inbox, name)
    var n = 2
    while (target.exists()) {
      val dot = name.lastIndexOf('.')
      target = File(inbox, if (dot > 0) "${name.substring(0, dot)} ($n)${name.substring(dot)}" else "$name ($n)")
      n++
    }
    activity.contentResolver.openInputStream(uri)?.use { input ->
      target.outputStream().use { output -> input.copyTo(output) }
    } ?: return null
    return target.absolutePath
  }

  private fun displayName(uri: Uri): String? = try {
    activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }
  } catch (e: Exception) {
    null
  } ?: uri.lastPathSegment?.substringAfterLast('/')
}
