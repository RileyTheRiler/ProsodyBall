package com.prosodyball.dsp

import com.prosodyball.dsp.AnalyzerConfig as C
import com.prosodyball.dsp.model.VoiceFrame
import com.prosodyball.dsp.model.VoiceMetrics
import com.prosodyball.dsp.model.VoiceProfile
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * Streaming port of the web app's VoiceAnalyzer (app.js:48-1714).
 *
 * The web analyzer reads WebAudio AnalyserNodes once per ~16ms animation frame;
 * here the audio capture layer pushes raw PCM via [processSamples] and the same
 * per-frame analysis runs once per hop. Feed hops of ~16ms (256 samples at
 * 16kHz) so the EMA smoothing constants behave as tuned.
 *
 * Differences from the JS, all deliberate:
 * - fftSize defaults to 2048 (vs 4096 at 44.1kHz) — comparable window duration
 *   and finer bin resolution at the watch's 16kHz capture rate.
 * - Only the 'harmonic' resonance method is ported (the JS default).
 * - Adds [TempoTracker] (tempo is documented in docs/ANALYZER_API.md but
 *   unimplemented in the JS analyzer).
 * - Learned calibration can be exported/imported as a [VoiceProfile] so the
 *   watch can persist it across sessions.
 */
class VoiceAnalyzer(
    val sampleRate: Double,
    val fftSize: Int = 2048,
    val hfFftSize: Int = 512,
) {
    // --- Analysers (smoothing constants per app.js:230, 236, 241) ---
    private val analyserMain = SpectrumAnalyzer(fftSize, smoothingTimeConstant = 0.8)
    private val analyserFormant = SpectrumAnalyzer(fftSize, smoothingTimeConstant = 0.5)
    private val analyserHF = SpectrumAnalyzer(hfFftSize, smoothingTimeConstant = 0.3)

    /** Highpass at 2000 Hz feeds the HF analyser (app.js:242-246). */
    private val hfFilter = Biquad.highpass(sampleRate, 2000.0)

    private val timeDomainData = FloatArray(fftSize)
    private val hfTimeDomain = FloatArray(hfFftSize)
    private val frequencyData = FloatArray(fftSize / 2)
    private val formantFreqData = FloatArray(fftSize / 2)
    private val hfFrequencyData = IntArray(hfFftSize / 2)
    private val hfFilteredChunk = FloatArray(8192)

    private val yin = YinPitchDetector(sampleRate)
    private val formantEstimator = FormantEstimator()
    private val tempoTracker = TempoTracker()
    private val aWeights = AWeighting(sampleRate / fftSize, fftSize / 2).gains

    private var nowSecs = 0.0

    // --- Pitch state (app.js:68-74) ---
    private val pitchHistory = ArrayDeque<Double>()
    private val pitchHistoryMax = 30
    var lastPitch = 0.0
        private set
    var smoothPitchHz = 160.0
        private set
    var pitchConfidence = 0.0
        private set

    // --- Resonance state (app.js:76-94) ---
    var smoothResonance = 0.5
        private set
    var smoothF1 = 500.0
        private set
    var smoothF2 = 1500.0
        private set
    var smoothF3 = 2700.0
        private set
    var formantConfidence = 0.0
        private set
    var vowelLikelihood = 0.0
        private set
    private val kalmanF1 = KalmanFilter1D()
    private val kalmanF2 = KalmanFilter1D()
    private val kalmanF3 = KalmanFilter1D()

    // --- Spectral tilt state (app.js:96-102) ---
    var spectralTiltRawDb = -14.0
        private set
    var spectralTiltSmoothedDb = -14.0
        private set
    var spectralWeight = 0.5
        private set
    var spectralTiltConfidence = 0.0
        private set
    var micTiltBaselineDb = 0.0
        private set
    private val micCalibrationTiltSamples = ArrayList<Double>()

    // --- Weight / attack state (app.js:104-115) ---
    private var weightSmoothed = 0.5
    private var prevGatedRms = 0.0
    private var attackRisePeak = 0.0
    private var attackWindowTimer = -1.0
    private var attackRiseCeiling = 0.02
    private var attackImpulse = 0.0
    private var attackPeakTime = 0.0
    var attackRiseHardness = 0.0
        private set
    var attackAbruptness = 0.0
        private set
    private var h1h2SmoothedDb = 6.0
    private var h1h2Confidence = 0.0

    // --- Energy state (app.js:117-123) ---
    private var smoothEnergy = 0.0
    private val energyBaselineWindow = ArrayDeque<Double>()
    private val energyBaselineWindowMax = 120
    private var energyP50 = 0.002
    private var energyP75 = 0.004
    private var energyP90 = 0.008

    // --- Syllable state (app.js:125-129) ---
    private var syllableState = "silent"
    private var syllableThreshold = 0.015
    private var lastSyllableTime = 0.0
    private var syllableImpulse = 0.0

    // --- Vowel state (app.js:131-134) ---
    private var sustainedDuration = 0.0
    private var sustainedThreshold = 0.02

    // --- Adaptive pitch range (app.js:136-144) ---
    private val pitchProfileSamples = ArrayList<Double>()
    var pitchProfileMin = 80.0
        private set
    var pitchProfileMax = 380.0
        private set
    var pitchProfileLearned = false
        private set
    private var pitchProfileVoicedTime = 0.0
    private val profileLearningDuration = 5.0

    // --- Adaptive tilt range (app.js:146-154) ---
    private val tiltProfileSamples = ArrayList<Double>()
    var tiltProfileMin = -34.0
        private set
    var tiltProfileMax = -4.0
        private set
    var tiltProfileLearned = false
        private set
    private var tiltProfileVoicedTime = 0.0

    // --- HF energy tracking (app.js:156-159) ---
    private val hfEnergyWindow = ArrayDeque<Double>()
    private val hfEnergyWindowMax = 60
    private var hfP50 = 0.0
    private var hfP90 = 0.02

    // --- Noise floor calibration (app.js:161-169) ---
    var noiseFloor = 0.015
        private set
    var hfNoiseFloor = 0.0
        private set
    private val noiseCalibrationSamples = ArrayList<Double>()
    private val hfCalibrationSamples = ArrayList<Double>()
    private val noiseCalibrationDuration = 1.0
    private var noiseCalibrationTimer = 0.0
    var isCalibrated = false
        private set
    private val noiseAdaptRate = 0.002
    private var noiseSpectralProfile: DoubleArray? = null

    // --- Metrics (app.js:171-179) ---
    private var mBounce = 0.0
    private var mVowel = 0.0
    private var mArticulation = 0.0
    private var mPitch = 0.0
    private var mEnergy = 0.0
    private var mResonance = 0.0
    private var mAttack = 0.0
    private var mWeight = 0.0
    var frameConfidence = 0.0
        private set
    private var wasLastFrameReliable = false

    private var gatedRmsLast = 0.0
    private var reliableFrameLast = false

    // Sliding raw-sample window; new hops shift in from the right
    private var windowFill = 0
    private var hfWindowFill = 0

    /**
     * Pushes [count] new samples and runs one analysis frame over the updated
     * sliding window. Returns null until the window has filled once.
     */
    fun processSamples(samples: FloatArray, count: Int, dt: Double): VoiceFrame? {
        // Slide the main window
        var offset = 0
        var remaining = count
        while (remaining > 0) {
            val chunk = min(remaining, fftSize)
            val shift = min(chunk, fftSize)
            System.arraycopy(timeDomainData, shift, timeDomainData, 0, fftSize - shift)
            for (i in 0 until shift) {
                timeDomainData[fftSize - shift + i] = samples[offset + i]
            }
            offset += chunk
            remaining -= chunk
        }
        windowFill = min(fftSize, windowFill + count)

        // Highpass-filter the new samples and slide the HF window
        val filtered = if (count <= hfFilteredChunk.size) hfFilteredChunk else FloatArray(count)
        hfFilter.process(samples, filtered, count)
        var hfOffset = 0
        var hfRemaining = count
        while (hfRemaining > 0) {
            val chunk = min(hfRemaining, hfFftSize)
            System.arraycopy(hfTimeDomain, chunk, hfTimeDomain, 0, hfFftSize - chunk)
            for (i in 0 until chunk) {
                hfTimeDomain[hfFftSize - chunk + i] = filtered[hfOffset + i]
            }
            hfOffset += chunk
            hfRemaining -= chunk
        }
        hfWindowFill = min(hfFftSize, hfWindowFill + count)

        if (windowFill < fftSize) return null

        analyserMain.process(timeDomainData)
        analyserFormant.process(timeDomainData)
        analyserHF.process(hfTimeDomain)

        return update(dt)
    }

    /** Port of VoiceAnalyzer.update(dt) (app.js:620-1180). */
    private fun update(dt: Double): VoiceFrame {
        nowSecs += dt
        val now = nowSecs

        // --- Raw energy first (needed for calibration) ---
        var rms = 0.0
        for (i in 0 until fftSize) {
            rms += timeDomainData[i] * timeDomainData[i]
        }
        rms = sqrt(rms / fftSize)

        // --- Noise floor calibration (app.js:633-721) ---
        if (!isCalibrated) {
            runCalibrationFrame(dt, rms)
            return buildFrame()
        }

        // --- Slow ongoing noise floor adaptation ---
        if (rms < noiseFloor * 1.5 && rms > 0.001) {
            noiseFloor += (rms * 1.2 - noiseFloor) * noiseAdaptRate
            noiseFloor = max(0.005, noiseFloor)
            syllableThreshold = noiseFloor * 1.2
            sustainedThreshold = noiseFloor * 1.5
        }

        // --- Gate: subtract noise floor from RMS ---
        val gatedRms = max(0.0, rms - noiseFloor)
        gatedRmsLast = gatedRms
        smoothEnergy += (gatedRms - smoothEnergy) * 0.15

        energyBaselineWindow.addLast(gatedRms)
        if (energyBaselineWindow.size > energyBaselineWindowMax) energyBaselineWindow.removeFirst()
        if (energyBaselineWindow.size >= 12) {
            val arr = energyBaselineWindow.toDoubleArray()
            energyP50 = percentile(arr, 0.5)
            energyP75 = percentile(arr, 0.75)
            energyP90 = percentile(arr, 0.9)
        }

        // --- Pitch (only if above noise floor) ---
        var pitch = 0.0
        if (rms > noiseFloor * 2) {
            val silenceThreshold = if (isCalibrated) noiseFloor * 2.5 else 0.015
            pitch = yin.detectPitch(
                timeDomainData, fftSize, rms, silenceThreshold,
                pitchProfileMin, pitchProfileMax,
            )
            pitchConfidence = yin.pitchConfidence
        }
        if (pitch > 0) {
            lastPitch = pitch
            pitchHistory.addLast(pitch)
            if (pitchHistory.size > pitchHistoryMax) pitchHistory.removeFirst()
            // Only update smooth Hz when confident — prevents flicker during breathy speech
            if (pitchConfidence > 0.4) {
                val lerpRate = 0.08 + pitchConfidence * 0.12
                smoothPitchHz += (pitch - smoothPitchHz) * lerpRate

                // --- Adaptive pitch range learning ---
                if (!pitchProfileLearned) {
                    pitchProfileSamples.add(pitch)
                    pitchProfileVoicedTime += dt
                    if (pitchProfileVoicedTime >= profileLearningDuration || pitchProfileSamples.size > 200) {
                        val sorted = pitchProfileSamples.sorted()
                        val p05 = sorted[floor(sorted.size * 0.05).toInt()]
                        val p95 = sorted[floor(sorted.size * 0.95).toInt()]
                        pitchProfileMin = max(50.0, p05 * 0.85)
                        pitchProfileMax = min(800.0, p95 * 1.25)
                        pitchProfileLearned = true
                    }
                }
            }
        }

        // --- HF energy (articulation) (app.js:778-798) ---
        analyserHF.getByteFrequencyData(hfFrequencyData)
        var hfEnergy = 0.0
        for (v in hfFrequencyData) hfEnergy += v
        hfEnergy /= (hfFrequencyData.size * 255.0)
        hfEnergy = max(0.0, hfEnergy - hfNoiseFloor)
        if (rms < noiseFloor * 1.3) hfEnergy = 0.0

        if (hfEnergy > 0) {
            hfEnergyWindow.addLast(hfEnergy)
            if (hfEnergyWindow.size > hfEnergyWindowMax) hfEnergyWindow.removeFirst()
            if (hfEnergyWindow.size >= 8) {
                val arr = hfEnergyWindow.toDoubleArray()
                hfP50 = percentile(arr, 0.5)
                hfP90 = percentile(arr, 0.9)
            }
        }

        // --- Main spectrum with noise spectral subtraction (app.js:800-810) ---
        analyserMain.getFloatFrequencyData(frequencyData)
        val noiseProfile = noiseSpectralProfile
        if (noiseProfile != null) {
            for (i in frequencyData.indices) {
                val signalMag = 10.0.pow(frequencyData[i] / 20.0)
                val noiseMag = noiseProfile[i]
                val cleanMag = max(0.01 * signalMag, signalMag - 1.5 * noiseMag)
                frequencyData[i] = if (cleanMag > 1e-10) (20.0 * log10(cleanMag)).toFloat() else -200f
            }
        }
        val fData = frequencyData

        // ====== SPECTRAL TILT (app.js:813-880) ======
        val fftBinHz = sampleRate / fftSize
        val eps = 1e-12
        val activeF0 = if (pitch > 0) pitch else if (lastPitch > 0) lastPitch else smoothPitchHz.takeIf { it > 0 } ?: 160.0
        val lowStartHz = max(70.0, activeF0 * 0.5)
        val lowEndHz = min(2200.0, activeF0 * 3.5)
        val highStartHz = 2500.0
        val highEndHz = min(5000.0, sampleRate * 0.5 - fftBinHz)

        val eLowTilt = sumBandPowerAWeighted(fData, lowStartHz, lowEndHz, fftBinHz)
        val eHighTilt = sumBandPowerAWeighted(fData, highStartHz, highEndHz, fftBinHz)
        var rawTiltDb = 10 * log10((eHighTilt + eps) / (eLowTilt + eps))
        if (!rawTiltDb.isFinite()) rawTiltDb = spectralTiltSmoothedDb
        rawTiltDb -= micTiltBaselineDb
        spectralTiltRawDb = rawTiltDb

        val tiltAlpha = 0.16
        spectralTiltSmoothedDb += (rawTiltDb - spectralTiltSmoothedDb) * tiltAlpha

        // --- Adaptive tilt range learning ---
        if (pitch > 0 && pitchConfidence > 0.4 && !tiltProfileLearned) {
            tiltProfileSamples.add(spectralTiltSmoothedDb)
            tiltProfileVoicedTime += dt
            if (tiltProfileVoicedTime >= profileLearningDuration || tiltProfileSamples.size > 200) {
                val sorted = tiltProfileSamples.sorted()
                val p10 = sorted[floor(sorted.size * 0.10).toInt()]
                val p90 = sorted[floor(sorted.size * 0.90).toInt()]
                val median = sorted[floor(sorted.size * 0.5).toInt()]
                val spread = max(16.0, p90 - p10)
                tiltProfileMin = median - spread * 0.55
                tiltProfileMax = median + spread * 0.45
                tiltProfileLearned = true
            }
        }

        val heavyAnchorDb = if (tiltProfileLearned) tiltProfileMin else -34.0
        val lightAnchorDb = if (tiltProfileLearned) tiltProfileMax else -4.0
        val normalized = normalizeAgainstRange(spectralTiltSmoothedDb, heavyAnchorDb, lightAnchorDb)
        val tiltConfidenceGate = if (rms > noiseFloor * 1.35) 1.0
        else max(0.0, (rms - noiseFloor) / max(1e-6, noiseFloor * 0.5))
        spectralWeight += (normalized - spectralWeight) * (0.12 + tiltConfidenceGate * 0.2)
        spectralTiltConfidence += (tiltConfidenceGate - spectralTiltConfidence) * 0.2

        // ====== H1-H2 (app.js:882-904) ======
        if (pitch > 0 && pitchConfidence > 0.4 && activeF0 > 0) {
            val hSearch = max(1, floor((activeF0 / fftBinHz) * 0.25).toInt())
            val h1 = harmonicPeakDb(fData, activeF0, fftBinHz, hSearch)
            val h2 = harmonicPeakDb(fData, activeF0 * 2, fftBinHz, hSearch)
            if (h1.isFinite() && h2.isFinite()) {
                h1h2SmoothedDb += ((h1 - h2) - h1h2SmoothedDb) * 0.16
                h1h2Confidence += (clamp01(pitchConfidence) - h1h2Confidence) * 0.2
            }
        } else {
            h1h2Confidence *= 0.9
        }

        // ====== FORMANT / RESONANCE (app.js:906-1018) ======
        val binHz = sampleRate / fftSize

        // Stage 1: band energy for vowel detection
        val eLow = bandEnergy(fData, 250.0, 900.0, binHz)
        val eMid = bandEnergy(fData, 900.0, 2800.0, binHz)
        val eHigh = bandEnergy(fData, 2800.0, 6000.0, binHz)
        val eTotal = eLow + eMid + eHigh + 0.0001

        val vowelRatio = (eLow + eMid) / eTotal
        val fricativeRatio = eHigh / eTotal
        val hasEnough = gatedRms > sustainedThreshold
        val rawVowelLike = if (hasEnough) max(0.0, vowelRatio - fricativeRatio) else 0.0
        vowelLikelihood += (rawVowelLike - vowelLikelihood) * 0.2

        // Stage 2: harmonic-envelope resonance during confident voiced vowels
        if (pitch > 0 && pitchConfidence > 0.4 && vowelLikelihood > 0.25) {
            analyserFormant.getFloatFrequencyData(formantFreqData)
            if (noiseProfile != null) {
                for (i in formantFreqData.indices) {
                    val signalMag = 10.0.pow(formantFreqData[i] / 20.0)
                    val noiseMag = noiseProfile[i]
                    val cleanMag = max(0.01 * signalMag, signalMag - 1.5 * noiseMag)
                    formantFreqData[i] = if (cleanMag > 1e-10) (20.0 * log10(cleanMag)).toFloat() else -200f
                }
            }

            val result = formantEstimator.harmonicEnvelope(
                formantFreqData, pitch, binHz, pitchConfidence, vowelLikelihood,
            )

            // Kalman-filtered formant continuity (method trust 0.7 for harmonic, app.js:977-988)
            val methodTrust = 0.7
            val rBase = 2500.0
            val rScale = max(0.1, result.confidence * methodTrust)
            val r = rBase / (rScale * rScale)

            if (result.f1 > 0) smoothF1 = kalmanF1.update(result.f1, r)
            if (result.f2 > 0) smoothF2 = kalmanF2.update(result.f2, r)
            if (result.f3 > 0) smoothF3 = kalmanF3.update(result.f3, r)
            formantConfidence += (result.confidence - formantConfidence) * 0.15

            // Resonance score: F2-primary with F1 and F3 contributions (app.js:1001-1005)
            val f2Score = clamp01((smoothF2 - 1000) / 1800)
            val f1Score = clamp01((smoothF1 - 300) / 600)
            val f3Score = clamp01((smoothF3 - 2200) / 1200)
            val rawResonance = f2Score * 0.70 + f1Score * 0.15 + f3Score * 0.15
            smoothResonance += (rawResonance - smoothResonance) * (0.05 + result.confidence * 0.08)
        } else {
            // During silence/unvoiced: decay confidence, coast Kalman filters
            formantConfidence *= 0.95
            if (kalmanF1.initialized) smoothF1 = kalmanF1.update(smoothF1, 1e6)
            if (kalmanF2.initialized) smoothF2 = kalmanF2.update(smoothF2, 1e6)
            if (kalmanF3.initialized) smoothF3 = kalmanF3.update(smoothF3, 1e6)
        }

        // ====== METRICS (app.js:1020-1180) ======

        // 1. BOUNCE — pitch variation
        if (pitchHistory.size > 3) {
            var sum = 0.0
            for (p in pitchHistory) sum += p
            val mean = sum / pitchHistory.size
            var sqSum = 0.0
            for (p in pitchHistory) {
                val diff = p - mean
                sqSum += diff * diff
            }
            val variance = sqSum / pitchHistory.size
            mBounce = min(1.0, sqrt(variance) / C.BOUNCE_NORM_DIVISOR)
        } else {
            mBounce *= 0.95
        }

        val baseEnergyRange = max(0.001, energyP90 - energyP50)

        // 3. VOWEL ELONGATION — sustained voicing with vowel-like formants
        val dynamicSustainThreshold = energyP50 + baseEnergyRange * C.VOWEL_SUSTAIN_MULT
        val isVowelSound = gatedRms > dynamicSustainThreshold && pitch > 0 && vowelLikelihood > 0.3
        if (isVowelSound) {
            sustainedDuration += dt * (0.5 + vowelLikelihood * 0.5)
        } else {
            sustainedDuration *= 0.85
        }
        mVowel = min(1.0, max(0.0, sustainedDuration - C.VOWEL_ONSET_SECS) / C.VOWEL_SATURATION_SECS)

        // 4. ARTICULATION — HF bursts with adaptive ceiling
        val hfCeiling = if (hfEnergyWindow.size >= 8) {
            max(hfP90, hfNoiseFloor + 0.02)
        } else {
            max(hfNoiseFloor + 0.02, hfNoiseFloor * 3.5)
        }
        val articTarget = normalizeAgainstPercentiles(hfEnergy, hfNoiseFloor, hfCeiling, C.ARTIC_SENSITIVITY_GAIN)
        mArticulation += (articTarget - mArticulation) * 0.3

        // Energy rise rate feeds the vocal-attack onset-hardness metric
        val riseRate = max(0.0, gatedRms - prevGatedRms) / max(1e-3, dt)
        prevGatedRms = gatedRms

        // 5. SYLLABLE SEPARATION — energy onset detection with hysteresis
        val dynamicSyllableOn = energyP50 + baseEnergyRange * C.SYLLABLE_ON_MULT
        val dynamicSyllableOff = energyP50 + baseEnergyRange * C.SYLLABLE_OFF_MULT
        val syllableOnThreshold = max(0.005, dynamicSyllableOn)
        val syllableOffThreshold = max(0.002, dynamicSyllableOff)
        var syllableOnset = false
        if (gatedRms > syllableOnThreshold && syllableState == "silent") {
            if (now - lastSyllableTime > C.SYLLABLE_DEBOUNCE_SECS) {
                lastSyllableTime = now
                syllableImpulse = 1.0
                syllableOnset = true
                // Open the vocal-attack capture window at this phonation onset
                attackWindowTimer = 0.0
                attackRisePeak = riseRate
                attackPeakTime = 0.0
            }
            syllableState = "voiced"
        } else if (gatedRms < syllableOffThreshold) {
            syllableState = "silent"
        }
        syllableImpulse *= C.SYLLABLE_IMPULSE_DECAY

        // Tempo (watch-only extension; see TempoTracker)
        tempoTracker.update(dt, syllableOnset)

        // 6. VOCAL ATTACK — onset hardness from peak energy-rise rate
        if (attackWindowTimer >= 0) {
            attackWindowTimer += dt
            if (riseRate > attackRisePeak) {
                attackRisePeak = riseRate
                attackPeakTime = attackWindowTimer
            }
            if (attackWindowTimer >= C.ATTACK_RISE_WINDOW_SECS) {
                // Train the ceiling only on reliably-voiced onsets
                if (pitchConfidence > 0.35 || formantConfidence > 0.35) {
                    val k = if (attackRisePeak > attackRiseCeiling) 0.30 else C.ATTACK_RISE_LEARN_RATE
                    attackRiseCeiling += (attackRisePeak - attackRiseCeiling) * k
                }
                val cleanliness = clamp01(pitchConfidence) * (1 - 0.5 * clamp01(mArticulation))
                val onsetAbruptness = 1 - clamp01(attackPeakTime / C.ATTACK_RISE_WINDOW_SECS)
                val hardness = computeAttackHardness(
                    risePeak = attackRisePeak,
                    riseCeiling = attackRiseCeiling,
                    cleanliness = cleanliness,
                    onsetAbruptness = onsetAbruptness,
                    abruptWeight = C.ATTACK_ABRUPT_BLEND,
                )
                attackImpulse = max(attackImpulse, hardness)
                attackRiseHardness = clamp01(attackRisePeak / max(1e-6, attackRiseCeiling))
                attackAbruptness = onsetAbruptness
                attackWindowTimer = -1.0
            }
        }
        attackImpulse *= C.ATTACK_IMPULSE_DECAY
        mAttack = attackImpulse

        val voicedStrength = normalizeAgainstPercentiles(gatedRms, energyP50, energyP90, 1.0)
        val pitchGate = if (pitch > 0) 1.0 else 0.35
        val rel = computeFrameReliability(
            pitchConfidence = pitchConfidence,
            formantConfidence = formantConfidence,
            voicedStrength = voicedStrength,
            spectralTiltConfidence = spectralTiltConfidence,
            wasLastFrameReliable = wasLastFrameReliable,
        )
        wasLastFrameReliable = rel.reliableFrame
        reliableFrameLast = rel.reliableFrame

        // Stricter confidence gating
        if (!rel.reliableFrame && gatedRms < energyP75) {
            mBounce *= 0.95
        } else {
            mBounce *= rel.confidenceGate * pitchGate
        }

        mArticulation *= max(0.25, rel.voicedGate * 0.8 + rel.confidenceGate * 0.2)
        mAttack *= max(0.2, rel.voicedGate)

        val pitchRange = max(50.0, pitchProfileMax - pitchProfileMin)
        mPitch = if (pitch > 0) clamp01((pitch - pitchProfileMin) / pitchRange) else mPitch * 0.95
        mEnergy = normalizeAgainstPercentiles(gatedRms, energyP50, energyP90, 1.1)
        mResonance = smoothResonance

        // 7. WEIGHT — perceived heaviness from tilt + F2 + H1-H2
        val heavinessTilt = 1 - spectralWeight
        var f2Heavy = 0.5
        var f2W = 0.0
        if (formantConfidence > 0.3) {
            f2Heavy = clamp01((2400 - smoothF2) / 1300)
            f2W = C.WEIGHT_F2_BLEND
        }
        val h1h2Light = normalizeAgainstRange(h1h2SmoothedDb, C.H1H2_HEAVY_DB, C.H1H2_LIGHT_DB)
        val weightTarget = computeWeightTarget(
            tiltHeaviness = heavinessTilt,
            tiltWeight = C.WEIGHT_TILT_BASE,
            h1h2Heaviness = 1 - h1h2Light,
            h1h2Weight = C.WEIGHT_H1H2_BLEND * h1h2Confidence,
            f2Heaviness = f2Heavy,
            f2Weight = f2W,
        )
        // Only move while tilt is trustworthy so the metric holds during silence
        if (spectralTiltConfidence > 0.2) {
            weightSmoothed += (weightTarget - weightSmoothed) * (C.WEIGHT_SMOOTH_BASE + spectralTiltConfidence * 0.18)
        }
        mWeight = weightSmoothed

        frameConfidence = if (rel.reliableFrame) rel.confidenceGate else 0.15

        return buildFrame(pitch)
    }

    /** Calibration frame: collect ambient noise stats (app.js:635-721). */
    private fun runCalibrationFrame(dt: Double, rms: Double) {
        noiseCalibrationTimer += dt
        noiseCalibrationSamples.add(rms)

        analyserHF.getByteFrequencyData(hfFrequencyData)
        var hfSample = 0.0
        for (v in hfFrequencyData) hfSample += v
        hfCalibrationSamples.add(hfSample / (hfFrequencyData.size * 255.0))

        analyserMain.getFloatFrequencyData(frequencyData)
        var profile = noiseSpectralProfile
        if (profile == null) {
            profile = DoubleArray(frequencyData.size)
            noiseSpectralProfile = profile
        }
        val fftBinHz = sampleRate / fftSize
        val activeF0 = 160.0 // fixed 160Hz for baseline calibration
        val lowStartHz = max(70.0, activeF0 * 0.5)
        val lowEndHz = min(2200.0, activeF0 * 3.5)
        val highStartHz = 2500.0
        val highEndHz = min(5000.0, sampleRate * 0.5 - fftBinHz)
        val eps = 1e-12

        var eLowTilt = 0.0
        var eHighTilt = 0.0
        for (i in frequencyData.indices) {
            val linearMag = 10.0.pow(frequencyData[i] / 20.0)
            profile[i] += linearMag

            val freqHz = i * fftBinHz
            val powerA = linearMag * linearMag * aWeights[i]
            if (freqHz in lowStartHz..lowEndHz) {
                eLowTilt += powerA
            } else if (freqHz in highStartHz..highEndHz) {
                eHighTilt += powerA
            }
        }
        val rawTiltDb = 10 * log10((eHighTilt + eps) / (eLowTilt + eps))
        if (rawTiltDb.isFinite()) micCalibrationTiltSamples.add(rawTiltDb)

        if (noiseCalibrationTimer >= noiseCalibrationDuration) {
            var sum = 0.0
            var sqSum = 0.0
            for (s in noiseCalibrationSamples) {
                sum += s
                sqSum += s * s
            }
            val mean = sum / noiseCalibrationSamples.size
            val std = sqrt(max(0.0, (sqSum / noiseCalibrationSamples.size) - mean * mean))

            // Floor at mean + 4*std — aggressively above ambient noise (fans, AC)
            noiseFloor = max(0.01, mean + std * 4)
            syllableThreshold = noiseFloor * 1.2
            sustainedThreshold = noiseFloor * 1.5

            var hfSum = 0.0
            var hfSqSum = 0.0
            for (s in hfCalibrationSamples) {
                hfSum += s
                hfSqSum += s * s
            }
            val hfMean = hfSum / hfCalibrationSamples.size
            val hfStd = sqrt(max(0.0, (hfSqSum / hfCalibrationSamples.size) - hfMean * hfMean))
            hfNoiseFloor = hfMean + hfStd * 2
            isCalibrated = true

            if (micCalibrationTiltSamples.isNotEmpty()) {
                val sorted = micCalibrationTiltSamples.sorted()
                micTiltBaselineDb = sorted[sorted.size / 2]
            }

            for (i in profile.indices) {
                profile[i] /= noiseCalibrationSamples.size
            }
        }
    }

    /** Reset calibration so a fresh calibration can run cleanly (app.js:365-372). */
    fun resetCalibration() {
        noiseCalibrationSamples.clear()
        hfCalibrationSamples.clear()
        micCalibrationTiltSamples.clear()
        noiseCalibrationTimer = 0.0
        isCalibrated = false
        noiseSpectralProfile = null
    }

    /** Export learned state so the watch can persist calibration across sessions. */
    fun exportProfile(): VoiceProfile = VoiceProfile(
        pitchMinHz = pitchProfileMin,
        pitchMaxHz = pitchProfileMax,
        pitchLearned = pitchProfileLearned,
        tiltMinDb = tiltProfileMin,
        tiltMaxDb = tiltProfileMax,
        tiltLearned = tiltProfileLearned,
        noiseFloor = noiseFloor,
        hfNoiseFloor = hfNoiseFloor,
        micTiltBaselineDb = micTiltBaselineDb,
    )

    /**
     * Restore previously learned ranges. Noise floor still re-calibrates each
     * session (ambient noise changes), but pitch/tilt ranges carry over.
     */
    fun importProfile(profile: VoiceProfile) {
        if (profile.pitchLearned) {
            pitchProfileMin = profile.pitchMinHz
            pitchProfileMax = profile.pitchMaxHz
            pitchProfileLearned = true
        }
        if (profile.tiltLearned) {
            tiltProfileMin = profile.tiltMinDb
            tiltProfileMax = profile.tiltMaxDb
            tiltProfileLearned = true
        }
        if (profile.micTiltBaselineDb != 0.0) {
            micTiltBaselineDb = profile.micTiltBaselineDb
        }
    }

    private fun buildFrame(pitch: Double = 0.0): VoiceFrame = VoiceFrame(
        metrics = VoiceMetrics(
            bounce = mBounce,
            tempo = tempoTracker.tempoMetric,
            vowel = mVowel,
            articulation = mArticulation,
            syllable = syllableImpulse,
            pitch = mPitch,
            energy = mEnergy,
            resonance = mResonance,
            attack = mAttack,
            weight = mWeight,
        ),
        pitchHz = pitch,
        smoothPitchHz = smoothPitchHz,
        pitchConfidence = pitchConfidence,
        formantConfidence = formantConfidence,
        spectralTiltConfidence = spectralTiltConfidence,
        frameConfidence = frameConfidence,
        reliableFrame = reliableFrameLast,
        spectralTiltDb = spectralTiltSmoothedDb,
        h1h2Db = h1h2SmoothedDb,
        f1Hz = smoothF1,
        f2Hz = smoothF2,
        f3Hz = smoothF3,
        gatedRms = gatedRmsLast,
        isCalibrated = isCalibrated,
        tempoRate = tempoTracker.tempoRate,
        tempoVariance = tempoTracker.tempoVariance,
    )

    // --- Spectrum helpers (app.js:824-835, 888-895, 913-921) ---

    private fun sumBandPowerAWeighted(fData: FloatArray, loHz: Double, hiHz: Double, fftBinHz: Double): Double {
        if (hiHz <= loHz) return 0.0
        val startBin = max(0, floor(loHz / fftBinHz).toInt())
        val endBin = min(fData.size - 1, ceil(hiHz / fftBinHz).toInt())
        if (endBin < startBin) return 0.0
        var sum = 0.0
        for (i in startBin..endBin) {
            val mag = 10.0.pow(fData[i] / 20.0)
            sum += mag * mag * aWeights[i]
        }
        return sum
    }

    private fun harmonicPeakDb(fData: FloatArray, centerHz: Double, fftBinHz: Double, hSearch: Int): Double {
        val center = centerHz / fftBinHz
        val lo = max(1, floor(center).toInt() - hSearch)
        val hi = min(fData.size - 1, ceil(center).toInt() + hSearch)
        var peak = Double.NEGATIVE_INFINITY
        for (i in lo..hi) {
            if (fData[i] > peak) peak = fData[i].toDouble()
        }
        return peak
    }

    private fun bandEnergy(fData: FloatArray, lo: Double, hi: Double, binHz: Double): Double {
        val startBin = floor(lo / binHz).toInt()
        val endBin = min(ceil(hi / binHz).toInt(), fData.size - 1)
        var sum = 0.0
        for (i in startBin..endBin) {
            sum += 10.0.pow(fData[i] / 20.0)
        }
        return sum / max(1, endBin - startBin + 1)
    }
}
