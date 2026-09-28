package com.example.eimrf

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection

class FrameView(
    context: Context,
    private val onTap: (Int, Int) -> Unit,
    private val onText: (String) -> Unit,
    private val onKey: (String) -> Unit,
    private val onKeyEvent: (KeyEvent) -> Boolean
) : View(context) {
    @Volatile private var frame: Bitmap? = null
    @Volatile var fw = 480
    @Volatile var fh = 640
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
    private var dx = 0f
    private var dy = 0f
    private var scale = 1f
    private var downIn = false

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        setBackgroundColor(Color.BLACK)
    }

    fun setFrame(b: Bitmap) {
        frame = b
        postInvalidate()
    }

    fun setFrameSize(w: Int, h: Int) {
        fw = w
        fh = h
        postInvalidate()
    }

    override fun onDraw(c: Canvas) {
        super.onDraw(c)
        scale = minOf(width / fw.toFloat(), height / fh.toFloat())
        dx = (width - fw * scale) / 2f
        dy = (height - fh * scale) / 2f
        frame?.let {
            c.drawBitmap(it, null, RectF(dx, dy, dx + fw * scale, dy + fh * scale), paint)
        }
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.action) {
            MotionEvent.ACTION_DOWN -> {
                requestFocus()
                downIn = e.x in dx..(dx + fw * scale) && e.y in dy..(dy + fh * scale)
            }
            MotionEvent.ACTION_UP -> if (downIn) {
                val fx = ((e.x - dx) / scale).toInt().coerceIn(0, fw - 1)
                val fy = ((e.y - dy) / scale).toInt().coerceIn(0, fh - 1)
                onTap(fx, fy)
            }
        }
        return true
    }

    override fun onCheckIsTextEditor() = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = EditorInfo.TYPE_CLASS_TEXT or
            EditorInfo.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
            EditorInfo.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or
            EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_ACTION_NONE
        return object : BaseInputConnection(this@FrameView, false) {
            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                text?.let { onText(it.toString()) }
                return true
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                repeat(beforeLength) { onKey("BACKSPACE") }
                return true
            }

            override fun sendKeyEvent(e: KeyEvent): Boolean {
                if (e.action == KeyEvent.ACTION_DOWN && onKeyEvent(e)) return true
                return super.sendKeyEvent(e)
            }

            override fun performEditorAction(actionCode: Int): Boolean {
                onKey("ENTER")
                return true
            }
        }
    }
}
