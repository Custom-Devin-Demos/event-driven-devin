package com.example.eimrf

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.HandlerThread
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer

class Session(
    private val host: () -> String,
    private val port: () -> Int,
    private val onHello: (String, Int, Int) -> Unit,
    private val onFrame: (Bitmap) -> Unit,
    private val onRtt: (Long) -> Unit,
    private val onDrop: () -> Unit
) {
    private val out = HandlerThread("net-out")
    private var outHandler: Handler? = null
    @Volatile private var running = false
    @Volatile private var sock: Socket? = null
    @Volatile private var outStream: DataOutputStream? = null
    private var thread: Thread? = null

    fun start() {
        running = true
        out.start()
        outHandler = Handler(out.looper)
        thread = Thread({ loop() }, "net-in").also { it.start() }
        outHandler?.post(object : Runnable {
            override fun run() {
                if (!running) return
                send('P', ByteBuffer.allocate(8).putLong(System.currentTimeMillis()).array())
                outHandler?.postDelayed(this, 2000)
            }
        })
    }

    fun stop() {
        running = false
        close()
        out.quitSafely()
    }

    fun reconnect() = close()

    fun sendInput(cmd: String) = send('I', cmd.toByteArray(Charsets.UTF_8))

    fun send(type: Char, payload: ByteArray) {
        outHandler?.post {
            synchronized(this@Session) {
                try {
                    val os = outStream ?: return@synchronized
                    os.writeByte(type.code)
                    os.writeInt(payload.size)
                    os.write(payload)
                    os.flush()
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun close() {
        try {
            sock?.close()
        } catch (_: Exception) {
        }
        sock = null
        synchronized(this) { outStream = null }
    }

    private fun loop() {
        while (running) {
            var s: Socket? = null
            try {
                s = Socket()
                s.connect(InetSocketAddress(host(), port()), 3000)
                s.soTimeout = 5000
                s.tcpNoDelay = true
                sock = s
                synchronized(this) { outStream = DataOutputStream(s.getOutputStream()) }
                val r = DataInputStream(s.getInputStream())
                while (running) {
                    val type = r.readByte()
                    val len = r.readInt()
                    if (len < 0 || len > 4 * 1024 * 1024)
                        throw java.io.IOException("bad frame length $len")
                    val buf = ByteArray(len)
                    r.readFully(buf)
                    when (type) {
                        'H'.code.toByte() -> {
                            val j = JSONObject(String(buf, Charsets.UTF_8))
                            onHello(j.getString("host"), j.getInt("width"), j.getInt("height"))
                        }
                        'F'.code.toByte() ->
                            BitmapFactory.decodeByteArray(buf, 0, buf.size)?.let(onFrame)
                        'P'.code.toByte() ->
                            if (buf.size >= 8) onRtt(System.currentTimeMillis() - ByteBuffer.wrap(buf).long)
                    }
                }
            } catch (_: Exception) {
                try {
                    s?.close()
                } catch (_: Exception) {
                }
                close()
                onDrop()
                try {
                    Thread.sleep(1000)
                } catch (_: InterruptedException) {
                }
            }
        }
    }
}
