// Host-side unit test for the T-Watch VoxBall DSP (../dsp.cpp).
//
// dsp.cpp is deliberately hardware-agnostic (no Arduino / I2S / display includes), so the
// exact same translation unit the watch runs can be compiled and exercised on a normal
// computer. This guards the voice math that is shared, by contract, with the web app
// (app.js / dsp-utils.js): if a ported constant or algorithm drifts, these checks fail in CI
// long before anyone flashes a watch.
//
// This file lives in test/ (not the sketch root) on purpose: the Arduino build compiles every
// .cpp in the sketch root, so a second main() there would collide with the firmware build.
// Subfolders other than src/ are ignored by the Arduino build, so this stays host-only.
//
// The assertions are derived from first principles, not memorised magic numbers:
//   * a pure sine of known frequency must be detected at that frequency (YIN ground truth),
//   * a higher tone must map to a higher normalised pitch position,
//   * a constant pitch must produce ~zero "bounce" (intonation variance),
//   * a high-centroid tone must read brighter than a low-centroid one,
//   * silence must read unvoiced, and a loud onset after quiet must fire a syllable impulse.
//
// Build + run (from the sketch root, hardware/twatch_voxball):
//   g++ -std=c++17 -O2 -I. dsp.cpp test/dsp_host_test.cpp -o dsp_host_test && ./dsp_host_test
#include "dsp.h"

#include <cmath>
#include <cstdio>
#include <string>

namespace {

const float kDt = (float)VOX_FRAME_SAMPLES / (float)VOX_SAMPLE_RATE; // ~0.064 s
int g_failures = 0;

// A continuous-phase sine source so frames stitch together cleanly across calls (a phase
// discontinuity at every frame boundary would smear the pitch estimate).
struct SineGen {
  double phase = 0.0;
  double freq;
  double amp;
  explicit SineGen(double f, double a = 0.3) : freq(f), amp(a) {}
  void fill(float* out, int n) {
    const double step = 2.0 * M_PI * freq / (double)VOX_SAMPLE_RATE;
    for (int i = 0; i < n; i++) {
      out[i] = (float)(amp * std::sin(phase));
      phase += step;
      if (phase > 2.0 * M_PI) phase -= 2.0 * M_PI;
    }
  }
};

void fillSilence(float* out, int n) {
  for (int i = 0; i < n; i++) out[i] = 0.0f;
}

// Run `frames` of silence through the DSP to establish a low noise floor (the first
// CALIB_TARGET_FRAMES frames are averaged into it), so subsequent tones aren't gated out.
void calibrateQuiet(VoxDsp& dsp, int frames = 20) {
  float buf[VOX_FRAME_SAMPLES];
  for (int f = 0; f < frames; f++) {
    fillSilence(buf, VOX_FRAME_SAMPLES);
    dsp.process(buf, VOX_FRAME_SAMPLES, kDt);
  }
}

// Feed a steady tone for `frames` frames; return the final frame's result.
VoxResult runTone(VoxDsp& dsp, double freq, int frames, double amp = 0.3) {
  SineGen gen(freq, amp);
  float buf[VOX_FRAME_SAMPLES];
  VoxResult last = {};
  for (int f = 0; f < frames; f++) {
    gen.fill(buf, VOX_FRAME_SAMPLES);
    last = dsp.process(buf, VOX_FRAME_SAMPLES, kDt);
  }
  return last;
}

void check(const std::string& name, bool ok, const std::string& detail = "") {
  std::printf("%s  %s%s%s\n", ok ? "[PASS]" : "[FAIL]", name.c_str(),
              detail.empty() ? "" : "  -> ", detail.c_str());
  if (!ok) g_failures++;
}

std::string f2s(float v) { char b[48]; std::snprintf(b, sizeof(b), "%.3f", v); return b; }

} // namespace

int main() {
  std::printf("VoxBall DSP host tests (sr=%d, frame=%d)\n", VOX_SAMPLE_RATE, VOX_FRAME_SAMPLES);

  // --- Silence reads unvoiced and inert -------------------------------------------------
  {
    VoxDsp dsp;
    calibrateQuiet(dsp);
    float buf[VOX_FRAME_SAMPLES];
    VoxResult r = {};
    for (int f = 0; f < 5; f++) { fillSilence(buf, VOX_FRAME_SAMPLES); r = dsp.process(buf, VOX_FRAME_SAMPLES, kDt); }
    check("silence: not voiced", !r.voiced);
    check("silence: rms ~0", r.rms < 0.01f, "rms=" + f2s(r.rms));
    check("silence: bounce 0", r.bounce == 0.0f, "bounce=" + f2s(r.bounce));
  }

  // --- Known-frequency sines are detected at that frequency -----------------------------
  float pos120 = 0.0f, pos220 = 0.0f;
  {
    VoxDsp dsp;
    calibrateQuiet(dsp);
    VoxResult r = runTone(dsp, 120.0, 12);
    pos120 = r.pitchPos;
    check("120 Hz: voiced", r.voiced);
    check("120 Hz: pitch within 6 Hz", std::fabs(r.pitchHz - 120.0f) < 6.0f, "pitchHz=" + f2s(r.pitchHz));
  }
  {
    VoxDsp dsp;
    calibrateQuiet(dsp);
    VoxResult r = runTone(dsp, 220.0, 12);
    pos220 = r.pitchPos;
    check("220 Hz: voiced", r.voiced);
    check("220 Hz: pitch within 8 Hz", std::fabs(r.pitchHz - 220.0f) < 8.0f, "pitchHz=" + f2s(r.pitchHz));
  }
  check("pitchPos increases with pitch", pos220 > pos120,
        "pos120=" + f2s(pos120) + " pos220=" + f2s(pos220));

  // --- A constant pitch should have near-zero intonation "bounce" -----------------------
  {
    VoxDsp dsp;
    calibrateQuiet(dsp);
    VoxResult r = runTone(dsp, 150.0, 30);
    check("constant 150 Hz: low bounce", r.bounce < 0.15f, "bounce=" + f2s(r.bounce));
  }

  // --- Spectral brightness: a high-centroid tone reads brighter than a low one ----------
  {
    VoxDsp dull;  calibrateQuiet(dull);
    VoxDsp bright; calibrateQuiet(bright);
    VoxResult rDull = runTone(dull, 300.0, 25);
    VoxResult rBright = runTone(bright, 3000.0, 25);
    check("brightness: 3 kHz brighter than 300 Hz", rBright.brightness > rDull.brightness + 0.3f,
          "dull=" + f2s(rDull.brightness) + " bright=" + f2s(rBright.brightness));
  }

  // --- A loud onset after quiet must fire a syllable impulse ----------------------------
  {
    VoxDsp dsp;
    calibrateQuiet(dsp);
    SineGen gen(180.0, 0.4);
    float buf[VOX_FRAME_SAMPLES];
    float maxImpulse = 0.0f;
    for (int f = 0; f < 6; f++) {
      gen.fill(buf, VOX_FRAME_SAMPLES);
      VoxResult r = dsp.process(buf, VOX_FRAME_SAMPLES, kDt);
      if (r.syllableImpulse > maxImpulse) maxImpulse = r.syllableImpulse;
    }
    check("syllable: onset after quiet fires impulse", maxImpulse > 0.5f, "maxImpulse=" + f2s(maxImpulse));
  }

  std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "ALL PASS" : "FAILURES",
              g_failures, g_failures == 1 ? "" : "s");
  return g_failures == 0 ? 0 : 1;
}
