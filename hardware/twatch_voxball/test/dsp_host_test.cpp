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

  // --- Formant dispersion must match the web app's fit, vector for vector -----------------
  // The same input->output pairs dsp-golden.test.mjs asserts on the JS side. This is the only
  // mechanism that catches SEMANTIC drift between the ports: constant codegen keeps the numbers
  // in step, but nothing except a shared vector catches the two ports computing ΔF by different
  // formulas — which is exactly what had happened here (the watch substituted F2-F1 whenever F3
  // went missing, so "resonance 50%" meant a different vocal target on the watch than on the
  // ball the user learned it from).
  {
    auto nearHz = [](float actual, float expected) { return std::fabs(actual - expected) < 0.5f; };
    check("dispersion: ideal tube series F1/F2/F3",
          nearHz(voxFitFormantDispersion(500.0f, 1500.0f, 2500.0f), 1000.0f),
          "dF=" + f2s(voxFitFormantDispersion(500.0f, 1500.0f, 2500.0f)));
    check("dispersion: wider spacing reads wider",
          nearHz(voxFitFormantDispersion(650.0f, 1800.0f, 2900.0f), 10275.0f / 8.75f),
          "dF=" + f2s(voxFitFormantDispersion(650.0f, 1800.0f, 2900.0f)));
    // A missing formant is a missing SLOT. Each of these used to be wrong on the watch.
    check("dispersion: F2 missing keeps F1/F3 in their slots",
          nearHz(voxFitFormantDispersion(500.0f, 0.0f, 2500.0f), 1000.0f),
          "dF=" + f2s(voxFitFormantDispersion(500.0f, 0.0f, 2500.0f)));
    check("dispersion: F3 missing falls back to the F1/F2 fit",
          nearHz(voxFitFormantDispersion(500.0f, 1500.0f, 0.0f), 1000.0f),
          "dF=" + f2s(voxFitFormantDispersion(500.0f, 1500.0f, 0.0f)));
    check("dispersion: one formant cannot fix a tract length",
          voxFitFormantDispersion(500.0f, 0.0f, 0.0f) == 0.0f,
          "dF=" + f2s(voxFitFormantDispersion(500.0f, 0.0f, 0.0f)));
  }

  // --- The scale/pattern split must match the web app, vector for vector (Phase 6) --------
  // Through Phases 1-5 the two ports agreed on formant dispersion and on NOTHING built above
  // it, while the web app moved its entire displayed metric onto the split. These are the same
  // input->output pairs dsp-golden.test.mjs asserts on the JS side. Per DSP_CONTRACT D1 the
  // resonance scale must mean the same thing on the watch as on the ball; constant codegen
  // cannot catch a formula diverging, only a shared vector can.
  {
    auto nearHz = [](float actual, float expected) { return std::fabs(actual - expected) < 0.05f; };
    // Tolerance for the 0..1 fields is looser than the JS leg's 1e-5: this port is float32
    // where the reference is float64, and DSP_CONTRACT's tolerance tiers put the C++ leg wider
    // by design. It is still far tighter than any drift that would change a vocal target.
    auto near01 = [](float actual, float expected) { return std::fabs(actual - expected) < 1e-4f; };

    // Weights derived from the published CVs, not tabulated -- the same derivation the JS side
    // pins. If a port ever hardcodes these and the CVs move, this is what notices.
    check("scale weights: F3 outweighs F2 by ~8x per unit x^2",
          voxFormantScaleWeight(2) > voxFormantScaleWeight(1) * 8.0f,
          "w2=" + f2s(voxFormantScaleWeight(1)) + " w3=" + f2s(voxFormantScaleWeight(2)));

    // An ideal uniform-tube series fits exactly whatever the weights are.
    check("scale: ideal tube series F1/F2/F3",
          nearHz(voxFitFormantScale(500.0f, 1500.0f, 2500.0f, 0.0f), 1000.0f),
          "dF=" + f2s(voxFitFormantScale(500.0f, 1500.0f, 2500.0f, 0.0f)));
    check("scale: an F4 on the same series changes nothing",
          nearHz(voxFitFormantScale(500.0f, 1500.0f, 2500.0f, 3500.0f), 1000.0f),
          "dF=" + f2s(voxFitFormantScale(500.0f, 1500.0f, 2500.0f, 3500.0f)));
    // A real vowel does not lie on a tube, so the weights decide and F3 dominates.
    check("scale: weighted fit on a non-tube frame",
          nearHz(voxFitFormantScale(650.0f, 1800.0f, 2900.0f, 0.0f), 1169.507274f),
          "dF=" + f2s(voxFitFormantScale(650.0f, 1800.0f, 2900.0f, 0.0f)));
    // Array SLOT is the formant number -- the bug class that started the cross-port testing.
    check("scale: F2 missing keeps F1/F3 in their slots",
          nearHz(voxFitFormantScale(500.0f, 0.0f, 2500.0f, 0.0f), 1000.0f),
          "dF=" + f2s(voxFitFormantScale(500.0f, 0.0f, 2500.0f, 0.0f)));
    check("scale: F3 missing falls back to the F1/F2 fit",
          nearHz(voxFitFormantScale(500.0f, 1500.0f, 0.0f, 0.0f), 1000.0f),
          "dF=" + f2s(voxFitFormantScale(500.0f, 1500.0f, 0.0f, 0.0f)));
    check("scale: one formant cannot fix a tract length",
          voxFitFormantScale(500.0f, 0.0f, 0.0f, 0.0f) == 0.0f,
          "dF=" + f2s(voxFitFormantScale(500.0f, 0.0f, 0.0f, 0.0f)));

    // Peterson & Barney adult-male means -- the three vowels that anchor the redesign.
    check("scale: P&B /i/ (heed)",
          nearHz(voxFitFormantScale(270.0f, 2290.0f, 3010.0f, 0.0f), 1179.426039f),
          "dF=" + f2s(voxFitFormantScale(270.0f, 2290.0f, 3010.0f, 0.0f)));
    check("scale: P&B /a/ (hod)",
          nearHz(voxFitFormantScale(730.0f, 1090.0f, 2440.0f, 0.0f), 993.346264f),
          "dF=" + f2s(voxFitFormantScale(730.0f, 1090.0f, 2440.0f, 0.0f)));
    check("scale: P&B rhotic (heard) reads as an impossibly long tract",
          nearHz(voxFitFormantScale(490.0f, 1350.0f, 1690.0f, 0.0f), 702.136086f),
          "dF=" + f2s(voxFitFormantScale(490.0f, 1350.0f, 1690.0f, 0.0f)));

    // resonanceAbsolute on the population axis.
    check("resonanceAbsolute: tube-series speaker",
          near01(voxResonanceAbsolute(1000.0f), 0.463822f),
          "abs=" + f2s(voxResonanceAbsolute(1000.0f)));
    check("resonanceAbsolute: top of the axis is 2x the reference dispersion",
          near01(voxResonanceAbsolute(2.0f * VOX_RESONANCE_V2_REF_DELTA_F_HZ), 1.0f),
          "abs=" + f2s(voxResonanceAbsolute(2.0f * VOX_RESONANCE_V2_REF_DELTA_F_HZ)));
    check("resonanceAbsolute: no scale is no reading, not a very long tract",
          voxResonanceAbsolute(0.0f) == 0.0f,
          "abs=" + f2s(voxResonanceAbsolute(0.0f)));

    // FORMANT PATTERN. A tube reads all-ones; /i/ spreads far either side of it, and that
    // spread is the vowel rather than the speaker.
    float r[4];
    voxFormantPatternResiduals(500.0f, 1500.0f, 2500.0f, 0.0f, 1000.0f, r);
    check("pattern: a uniform tube reads all ones",
          near01(r[0], 1.0f) && near01(r[1], 1.0f) && near01(r[2], 1.0f),
          "r=[" + f2s(r[0]) + ", " + f2s(r[1]) + ", " + f2s(r[2]) + "]");
    voxFormantPatternResiduals(270.0f, 2290.0f, 3010.0f, 0.0f,
                               voxFitFormantScale(270.0f, 2290.0f, 3010.0f, 0.0f), r);
    check("pattern: P&B /i/ residual vector",
          near01(r[0], 0.457850f) && near01(r[1], 1.294415f) && near01(r[2], 1.020836f),
          "r=[" + f2s(r[0]) + ", " + f2s(r[1]) + ", " + f2s(r[2]) + "]");
    voxFormantPatternResiduals(730.0f, 1090.0f, 2440.0f, 0.0f,
                               voxFitFormantScale(730.0f, 1090.0f, 2440.0f, 0.0f), r);
    check("pattern: P&B /a/ residual vector",
          near01(r[0], 1.469780f) && near01(r[1], 0.731534f) && near01(r[2], 0.982538f),
          "r=[" + f2s(r[0]) + ", " + f2s(r[1]) + ", " + f2s(r[2]) + "]");
    voxFormantPatternResiduals(500.0f, 0.0f, 2500.0f, 0.0f, 1000.0f, r);
    check("pattern: an unmeasured formant yields no residual, not a residual of zero",
          r[1] == 0.0f && near01(r[0], 1.0f) && near01(r[2], 1.0f),
          "r2=" + f2s(r[1]));

    // THE IDENTITY: sum(L_i * r_i) == 1 whenever dF was fitted to the same frame. Exact, not
    // approximate. A port with subtly wrong weights would still look plausible on the residual
    // vectors above and would fail right here.
    const float vecs[5][3] = {
      { 500.0f, 1500.0f, 2500.0f }, { 650.0f, 1800.0f, 2900.0f }, { 270.0f, 2290.0f, 3010.0f },
      { 730.0f, 1090.0f, 2440.0f }, { 490.0f, 1350.0f, 1690.0f },
    };
    bool identityHolds = true;
    float worst = 0.0f;
    for (const auto& v : vecs) {
      const float dF = voxFitFormantScale(v[0], v[1], v[2], 0.0f);
      voxFormantPatternResiduals(v[0], v[1], v[2], 0.0f, dF, r);
      const float rho = voxResidualScaleFactor(r, 3);
      worst = fmaxf(worst, std::fabs(rho - 1.0f));
      if (std::fabs(rho - 1.0f) > 1e-4f) identityHolds = false;
    }
    check("pattern: sum(L_i*r_i) == 1 on a self-fitted frame, every vector",
          identityHolds, "max |rho-1|=" + f2s(worst));

    // Pooling: the same vectors dsp-golden.test.mjs pins for poolFormantScale.
    {
      const float d1[8]  = { 900, 950, 1000, 1050, 1100, 1150, 1200, 1250 };
      const float d2[8]  = { 900, 950, 1000, 1050, 1100, 1150, 1200, 2400 };
      const float d3[8]  = { 1000, 1000, 1000, 1000, 1000, 1000, 1000, 3000 };
      const float w1[8]  = { 1, 1, 1, 1, 1, 1, 1, 1 };
      const float w3[8]  = { 1, 1, 1, 1, 1, 1, 1, 9 };
      check("pool: weighted median of eight equally-trusted frames",
            nearHz(voxPoolFormantScale(d1, w1, 8, 8), 1050.0f),
            "pooled=" + f2s(voxPoolFormantScale(d1, w1, 8, 8)));
      // The reason it is a median: one frame whose F3 locked onto F4 must not drag the pool.
      check("pool: a doubled-dF outlier does not move the median",
            nearHz(voxPoolFormantScale(d2, w1, 8, 8), 1050.0f),
            "pooled=" + f2s(voxPoolFormantScale(d2, w1, 8, 8)));
      check("pool: a heavily-weighted frame can win, which is the contract",
            nearHz(voxPoolFormantScale(d3, w3, 8, 8), 3000.0f),
            "pooled=" + f2s(voxPoolFormantScale(d3, w3, 8, 8)));
      check("pool: fewer than eight usable frames is no scale, not a short tract",
            voxPoolFormantScale(d1, w1, 7, 8) == 0.0f,
            "pooled=" + f2s(voxPoolFormantScale(d1, w1, 7, 8)));
    }

    // And it departs from 1 exactly when the scale came from elsewhere -- the rhotic signal.
    voxFormantPatternResiduals(490.0f, 1350.0f, 1690.0f, 0.0f, 968.0f, r);
    const float rhoRhotic = voxResidualScaleFactor(r, 3);
    check("pattern: a rhotic against a pooled scale drives rho well below 1",
          rhoRhotic < 0.8f, "rho=" + f2s(rhoRhotic));
  }

  std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "ALL PASS" : "FAILURES",
              g_failures, g_failures == 1 ? "" : "s");
  return g_failures == 0 ? 0 : 1;
}
