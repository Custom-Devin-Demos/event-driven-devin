package com.example.eimrf

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var frame: FrameView
    private lateinit var overlay: TextView
    private lateinit var status: TextView
    private lateinit var prefs: SharedPreferences
    private var session: Session? = null
    private var connected = false
    private var everConnected = false
    private var rtt = -1L
    private var hostName = ""
    private val ui = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        prefs = getSharedPreferences("rf", Context.MODE_PRIVATE)
        buildUi()
    }

    override fun onStart() {
        super.onStart()
        session = Session(::host, ::port,
            onHello = { name, w, h -> ui.post {
                connected = true; everConnected = true; hostName = name
                frame.setFrameSize(w, h)
                overlay.visibility = View.GONE
                updateStatus()
            }},
            onFrame = { b -> ui.post { frame.setFrame(b) } },
            onRtt = { ms -> ui.post { rtt = ms; updateStatus() } },
            onDrop = { ui.post {
                connected = false
                overlay.text = if (everConnected) "Reconnecting…" else "Connecting…"
                overlay.visibility = View.VISIBLE
                updateStatus()
            }})
        session?.start()
    }

    override fun onStop() {
        session?.stop()
        session = null
        super.onStop()
    }

    private fun host() = prefs.getString("host", "10.0.2.2")!!
    private fun port() = prefs.getInt("port", 3390)
    private fun send(cmd: String) = session?.sendInput(cmd)
    private fun sendText(s: String) = send("text ${JSONObject.quote(s)}")

    private fun updateStatus() {
        status.text = if (connected)
            "Connected to $hostName · RTT ${if (rtt < 0) "—" else rtt.toString()} ms"
        else
            "Disconnected · ${host()}:${port()}"
    }

    private fun handleKey(e: KeyEvent): Boolean {
        mapKey(e.keyCode)?.let { send("key $it"); return true }
        val c = e.unicodeChar
        if (c != 0 && c >= 32 && c != 127) {
            sendText(c.toChar().toString())
            return true
        }
        return false
    }

    private fun mapKey(code: Int): String? = when (code) {
        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "ENTER"
        KeyEvent.KEYCODE_TAB -> "TAB"
        KeyEvent.KEYCODE_DEL -> "BACKSPACE"
        KeyEvent.KEYCODE_ESCAPE -> "ESC"
        KeyEvent.KEYCODE_DPAD_UP -> "UP"
        KeyEvent.KEYCODE_DPAD_DOWN -> "DOWN"
        in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> "F${code - KeyEvent.KEYCODE_F1 + 1}"
        else -> null
    }

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        if (e.action == KeyEvent.ACTION_DOWN && handleKey(e)) return true
        return super.dispatchKeyEvent(e)
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
        }
        val frameArea = FrameLayout(this)
        frame = FrameView(this,
            { x, y -> send("tap $x,$y") },
            ::sendText,
            { k -> send("key $k") },
            ::handleKey)
        frameArea.addView(frame, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        overlay = TextView(this).apply {
            text = "Connecting…"
            setTextColor(Color.WHITE)
            textSize = 24f
            gravity = Gravity.CENTER
            setBackgroundColor(0xB0000000.toInt())
        }
        frameArea.addView(overlay, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        root.addView(frameArea, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        status = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 13f
            maxLines = 1
            gravity = Gravity.CENTER_VERTICAL
            setPadding(24, 0, 8, 0)
        }
        val strip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0xFF222222.toInt())
            addView(status, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(stripButton("SCAN") { showScan() })
            addView(stripButton("KBD") { showKeyboard() })
            setOnLongClickListener { showSettings(); true }
        }
        root.addView(strip,
            LinearLayout.LayoutParams(MATCH_PARENT, (48 * resources.displayMetrics.density).toInt()))
        setContentView(root)
        updateStatus()
    }

    private fun stripButton(label: String, action: () -> Unit) = Button(this).apply {
        text = label
        minWidth = 0
        minimumWidth = 0
        setPadding(36, 0, 36, 0)
        setOnClickListener { action() }
    }

    private fun showKeyboard() {
        frame.requestFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(frame, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun showSettings() {
        val hostEdit = EditText(this).apply { hint = "Host"; setText(host()) }
        val portEdit = EditText(this).apply {
            hint = "Port"
            setText(port().toString())
            inputType = InputType.TYPE_CLASS_NUMBER
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 16, 48, 0)
            addView(hostEdit)
            addView(portEdit)
        }
        AlertDialog.Builder(this)
            .setTitle("Host settings")
            .setView(box)
            .setPositiveButton("Save") { _, _ ->
                prefs.edit()
                    .putString("host", hostEdit.text.toString().ifBlank { "10.0.2.2" })
                    .putInt("port", portEdit.text.toString().toIntOrNull() ?: 3390)
                    .apply()
                updateStatus()
                session?.reconnect()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private data class Entry(val code: String?, val desc: String = "")

    private val scanItems = listOf(
        Entry(null, "── Pallets ──"),
        Entry("006141411000000019", "COOL C-01-01 CHKN BRST"),
        Entry("006141411000000026", "COOL C-01-01 CHKN THIGH"),
        Entry("006141411000000033", "COOL C-01-02 BEEF mixed"),
        Entry("006141411000000064", "FRZR F-01-01 CHKN WING"),
        Entry("006141411000000088", "FRZR F-02-02 PORK BELLY"),
        Entry("006141411000000101", "RAW1 R-01-01 CHKN WOG"),
        Entry("006141411000000132", "C-STAGE OPEN pallet"),
        Entry(null, "── Blank pallet labels ──"),
        Entry("006141412000000016"),
        Entry("006141412000000023"),
        Entry("006141412000000030"),
        Entry(null, "── Bins ──"),
        Entry("C-01-02"),
        Entry("C-01-03"),
        Entry("C-02-01"),
        Entry("C-02-02", "blocked"),
        Entry("F-01-02"),
        Entry("F-02-02", "full"),
        Entry("D-DOOR-03"),
        Entry("R-01-02"),
        Entry(null, "── Case labels ──"),
        Entry("01000451202626900001"),
        Entry("01000451202626900002"),
        Entry("01000451202626900003"),
        Entry("01000453302626900009"),
        Entry("02000111802626800015"),
        Entry(null, "── Error barcodes ──"),
        Entry("006141411000000010", "bad check digit"),
        Entry("006141419999999999", "unknown pallet"),
        Entry("C-09-09", "no such bin")
    )

    private fun showScan() {
        AlertDialog.Builder(this)
            .setTitle("Scan barcode")
            .setItems(
                scanItems.map { it.code?.let { c -> "$c  ${it.desc}".trimEnd() } ?: it.desc }
                    .toTypedArray()
            ) { _, i ->
                scanItems[i].code?.let {
                    sendText(it)
                    send("key ENTER")
                }
            }
            .show()
    }
}
