package com.prosodyball.dsp

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Quickselect percentile, ported from VoiceAnalyzer._percentile (app.js:452-488).
 * Selects the floor((n-1)*p)-th order statistic without a full sort.
 */
fun percentile(values: DoubleArray, p: Double): Double {
    if (values.isEmpty()) return 0.0
    val k = min(values.size - 1, max(0, floor((values.size - 1) * p).toInt()))
    return quickselect(values.copyOf(), k, 0, values.size - 1)
}

fun percentile(values: List<Double>, p: Double): Double = percentile(values.toDoubleArray(), p)

private fun quickselect(arr: DoubleArray, k: Int, leftStart: Int, rightStart: Int): Double {
    var left = leftStart
    var right = rightStart
    while (left < right) {
        val pivotIndex = partition(arr, left, right)
        when {
            pivotIndex == k -> return arr[k]
            k < pivotIndex -> right = pivotIndex - 1
            else -> left = pivotIndex + 1
        }
    }
    return arr[k]
}

private fun partition(arr: DoubleArray, left: Int, right: Int): Int {
    val pivot = arr[right]
    var i = left
    for (j in left until right) {
        if (arr[j] <= pivot) {
            val temp = arr[i]
            arr[i] = arr[j]
            arr[j] = temp
            i++
        }
    }
    val temp = arr[i]
    arr[i] = arr[right]
    arr[right] = temp
    return i
}
