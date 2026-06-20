package com.voxarcade.wear

import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import kotlin.math.roundToInt

/**
 * On-watch settings: toggle each alert, nudge the pitch/resonance ranges, and set
 * buzz strength + sensitivity — without re-calibrating. Built programmatically
 * (no XML) and saved to [ConfigStore] on every change; MainActivity pushes the
 * updated config to the running service when it resumes.
 */
class SettingsActivity : ComponentActivity() {

    private lateinit var c: NecklaceConfig

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        c = ConfigStore.load(this)
        if (c.resLo <= 0f || c.resHi <= 0f) { c.resLo = 1000f; c.resHi = 1600f }

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(30), dp(16), dp(34))
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(col)
        }
        setContentView(scroll)

        col.addView(title("Settings"))
        col.addView(toggleRow("Pitch alert", { c.pitchEnabled }) { c.pitchEnabled = it; save() })
        col.addView(stepperRow("Pitch low", { c.pitchLo }, 5f, { 70f }, { c.pitchHi - 10f }) { c.pitchLo = it; save() })
        col.addView(stepperRow("Pitch high", { c.pitchHi }, 5f, { c.pitchLo + 10f }, { 400f }) { c.pitchHi = it; save() })
        col.addView(toggleRow("Resonance alert", { c.resEnabled }) { c.resEnabled = it; save() })
        col.addView(stepperRow("Res low", { c.resLo }, 25f, { 200f }, { c.resHi - 25f }) { c.resLo = it; save() })
        col.addView(stepperRow("Res high", { c.resHi }, 25f, { c.resLo + 25f }, { 4000f }) { c.resHi = it; save() })
        col.addView(cycleRow("Buzz", BUZZ, { c.buzzStrength }) { c.buzzStrength = it; save() })
        col.addView(cycleRow("Mic sense", SENSE, { gateToIndex(c.voiceGate) }) { c.voiceGate = indexToGate(it); save() })
    }

    private fun save() = ConfigStore.save(this, c)

    // ---- row builders -------------------------------------------------------

    private fun title(text: String) = TextView(this).apply {
        setText(text)
        setTextColor(Color.WHITE)
        textSize = 18f
        gravity = Gravity.CENTER
        setPadding(0, 0, 0, dp(12))
    }

    private fun rowBase() = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.topMargin = dp(4)
        lp.bottomMargin = dp(4)
        layoutParams = lp
    }

    private fun rowLabel(text: String) = TextView(this).apply {
        setText(text)
        setTextColor(Color.parseColor("#C8C8DC"))
        textSize = 13f
        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    }

    private fun ctrlButton(text: String) = Button(this).apply {
        setText(text)
        textSize = 13f
        minWidth = dp(40)
        minHeight = dp(34)
        setPadding(dp(6), 0, dp(6), 0)
    }

    private fun toggleRow(text: String, get: () -> Boolean, set: (Boolean) -> Unit): View {
        val row = rowBase()
        val btn = ctrlButton(if (get()) "On" else "Off")
        btn.setOnClickListener {
            val v = !get(); set(v); btn.text = if (v) "On" else "Off"
        }
        row.addView(rowLabel(text))
        row.addView(btn)
        return row
    }

    private fun stepperRow(
        text: String,
        get: () -> Float,
        step: Float,
        min: () -> Float,
        max: () -> Float,
        set: (Float) -> Unit,
    ): View {
        val row = rowBase()
        val value = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 14f
            gravity = Gravity.CENTER
            minWidth = dp(46)
            setText(get().roundToInt().toString())
        }
        val minus = ctrlButton("−")
        val plus = ctrlButton("+")
        minus.setOnClickListener {
            val v = (get() - step).coerceIn(min(), max()); set(v); value.text = v.roundToInt().toString()
        }
        plus.setOnClickListener {
            val v = (get() + step).coerceIn(min(), max()); set(v); value.text = v.roundToInt().toString()
        }
        row.addView(rowLabel(text))
        row.addView(minus)
        row.addView(value)
        row.addView(plus)
        return row
    }

    private fun cycleRow(text: String, options: Array<String>, getIndex: () -> Int, setIndex: (Int) -> Unit): View {
        val row = rowBase()
        val btn = ctrlButton(options[getIndex().coerceIn(0, options.size - 1)])
        btn.setOnClickListener {
            val ni = (getIndex() + 1) % options.size; setIndex(ni); btn.text = options[ni]
        }
        row.addView(rowLabel(text))
        row.addView(btn)
        return row
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // Higher sensitivity = lower RMS gate (picks up quieter speech).
    private fun gateToIndex(gate: Float) = when {
        gate >= 0.018f -> 0   // Low
        gate <= 0.008f -> 2   // High
        else -> 1             // Med
    }

    private fun indexToGate(i: Int) = when (i) {
        0 -> 0.02f
        2 -> 0.006f
        else -> 0.012f
    }

    companion object {
        private val BUZZ = arrayOf("Low", "Med", "High")
        private val SENSE = arrayOf("Low", "Med", "High")
    }
}
