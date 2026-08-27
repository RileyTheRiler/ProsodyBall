// Host-side unit test for the ProsodyBall necklace DSP (../dsp.cpp).
//
// This port had NO host test until Phase 6 of docs/RESONANCE_REDESIGN.md, and that is exactly
// how it kept a formant-dispersion bug the other two ports had already fixed. The web app and
// the T-Watch both moved onto the least-squares uniform-tube fit; docs/DSP_CONTRACT.md recorded
// that "both ports" were fixed, and this third port was simply never in the count. It went on
// computing ΔF as an endpoint difference over a compacted formant list -- (F3-F1)/2, with
// F2-F1 substituted whenever F3 went missing -- with nothing to notice.
//
// So the point of this file is narrow and specific: hold this port to the SAME golden vectors
// dsp-golden.test.mjs pins on the web side and hardware/twatch_voxball/test/dsp_host_test.cpp
// asserts on the watch. Shared vectors are the only mechanism that catches two ports computing
// the same field by different formulas; constant codegen cannot.
//
// dsp.cpp here is hardware-agnostic (no Arduino / I2S / LED includes), so the same translation
// unit the necklace flashes compiles and runs on a normal computer. This lives in test/ because
// the Arduino build compiles every .cpp in the sketch root and a second main() there would
// collide with the firmware build.
//
// Build + run (from the sketch root, hardware/prosody_necklace):
//   g++ -std=c++17 -O2 -Wall -I. dsp.cpp test/dsp_host_test.cpp -o dsp_host_test && ./dsp_host_test
#include "dsp.h"

#include <cmath>
#include <cstdio>
#include <string>

namespace {

int g_failures = 0;

std::string f2s(float v) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.3f", (double)v);
  return std::string(buf);
}

void check(const char* name, bool ok, const std::string& detail = "") {
  if (!ok) g_failures++;
  std::printf("[%s]  %s%s%s\n", ok ? "PASS" : "FAIL", name,
              detail.empty() ? "" : "  -> ", detail.c_str());
}

}  // namespace

int main() {
  std::printf("ProsodyBall necklace DSP host tests\n\n");

  auto nearHz = [](float actual, float expected) { return std::fabs(actual - expected) < 0.05f; };
  // Looser than the JS leg's 1e-5: this port is float32 against a float64 reference, and
  // DSP_CONTRACT's tolerance tiers put the firmware legs wider by design. Still far tighter
  // than any drift that would change a vocal target.
  auto near01 = [](float actual, float expected) { return std::fabs(actual - expected) < 1e-4f; };

  // --- Formant dispersion: the vectors the other two ports already reproduce --------------
  {
    check("dispersion: ideal tube series F1/F2/F3",
          nearHz(voxFitFormantDispersion(500.0f, 1500.0f, 2500.0f), 1000.0f),
          "dF=" + f2s(voxFitFormantDispersion(500.0f, 1500.0f, 2500.0f)));
    check("dispersion: wider spacing reads wider",
          nearHz(voxFitFormantDispersion(650.0f, 1800.0f, 2900.0f), 10275.0f / 8.75f),
          "dF=" + f2s(voxFitFormantDispersion(650.0f, 1800.0f, 2900.0f)));

    // THE REGRESSION THIS FILE EXISTS FOR. Under the old endpoint arithmetic a dropped F2 gave
    // (F3-F1)/2 = 1000 only by luck of this vector; what it actually did was read F1 and F3 as
    // ADJACENT, so the general case doubled ΔF. And a dropped F3 fell back to F2-F1 = 1000 here
    // but to ~2200 on /i/ and ~700 on /u/ -- a vowel identity reported as a tract length.
    check("dispersion: F2 missing keeps F1/F3 in their slots",
          nearHz(voxFitFormantDispersion(500.0f, 0.0f, 2500.0f), 1000.0f),
          "dF=" + f2s(voxFitFormantDispersion(500.0f, 0.0f, 2500.0f)));
    check("dispersion: F3 missing falls back to the F1/F2 fit, not to F2-F1",
          nearHz(voxFitFormantDispersion(500.0f, 1500.0f, 0.0f), 1000.0f),
          "dF=" + f2s(voxFitFormantDispersion(500.0f, 1500.0f, 0.0f)));
    // /i/ with F3 missing: the old F2-F1 fallback returned 2020 Hz here, an apparent tract of
    // 8.7 cm -- shorter than any adult's, and pinned hard at the bright rail. The fit returns
    // a plausible tract from the same two formants.
    const float iNoF3 = voxFitFormantDispersion(270.0f, 2290.0f, 0.0f);
    check("dispersion: /i/ without F3 no longer reads as an 8.7 cm tract",
          iNoF3 > 900.0f && iNoF3 < 1600.0f,
          "dF=" + f2s(iNoF3) + " (old F2-F1 gave 2020)");
    check("dispersion: one formant cannot fix a tract length",
          voxFitFormantDispersion(500.0f, 0.0f, 0.0f) == 0.0f,
          "dF=" + f2s(voxFitFormantDispersion(500.0f, 0.0f, 0.0f)));
  }

  // --- The scale/pattern split, same vectors as the web and the watch ---------------------
  {
    check("scale weights: F3 outweighs F2 by ~8x per unit x^2",
          voxFormantScaleWeight(2) > voxFormantScaleWeight(1) * 8.0f,
          "w2=" + f2s(voxFormantScaleWeight(1) * 1e6f) + "e-6 w3=" + f2s(voxFormantScaleWeight(2) * 1e6f) + "e-6");
    check("scale: ideal tube series",
          nearHz(voxFitFormantScale(500.0f, 1500.0f, 2500.0f, 0.0f), 1000.0f),
          "dF=" + f2s(voxFitFormantScale(500.0f, 1500.0f, 2500.0f, 0.0f)));
    check("scale: weighted fit on a non-tube frame",
          nearHz(voxFitFormantScale(650.0f, 1800.0f, 2900.0f, 0.0f), 1169.507274f),
          "dF=" + f2s(voxFitFormantScale(650.0f, 1800.0f, 2900.0f, 0.0f)));
    check("scale: P&B /i/ (heed)",
          nearHz(voxFitFormantScale(270.0f, 2290.0f, 3010.0f, 0.0f), 1179.426039f),
          "dF=" + f2s(voxFitFormantScale(270.0f, 2290.0f, 3010.0f, 0.0f)));
    check("scale: P&B /a/ (hod)",
          nearHz(voxFitFormantScale(730.0f, 1090.0f, 2440.0f, 0.0f), 993.346264f),
          "dF=" + f2s(voxFitFormantScale(730.0f, 1090.0f, 2440.0f, 0.0f)));
    check("scale: one formant cannot fix a tract length",
          voxFitFormantScale(500.0f, 0.0f, 0.0f, 0.0f) == 0.0f,
          "dF=" + f2s(voxFitFormantScale(500.0f, 0.0f, 0.0f, 0.0f)));

    check("resonanceAbsolute: tube-series speaker",
          near01(voxResonanceAbsolute(1000.0f), 0.463822f),
          "abs=" + f2s(voxResonanceAbsolute(1000.0f)));
    check("resonanceAbsolute: no scale is no reading",
          voxResonanceAbsolute(0.0f) == 0.0f,
          "abs=" + f2s(voxResonanceAbsolute(0.0f)));

    float r[4];
    voxFormantPatternResiduals(270.0f, 2290.0f, 3010.0f, 0.0f,
                               voxFitFormantScale(270.0f, 2290.0f, 3010.0f, 0.0f), r);
    check("pattern: P&B /i/ residual vector",
          near01(r[0], 0.457850f) && near01(r[1], 1.294415f) && near01(r[2], 1.020836f),
          "r=[" + f2s(r[0]) + ", " + f2s(r[1]) + ", " + f2s(r[2]) + "]");
    voxFormantPatternResiduals(500.0f, 0.0f, 2500.0f, 0.0f, 1000.0f, r);
    check("pattern: an unmeasured formant yields no residual, not a residual of zero",
          r[1] == 0.0f, "r2=" + f2s(r[1]));

    // The identity: sum(L_i*r_i) == 1 on a self-fitted frame. A port with subtly wrong weights
    // still looks plausible on the residual vectors above and fails here.
    const float vecs[4][3] = {
      { 500.0f, 1500.0f, 2500.0f }, { 650.0f, 1800.0f, 2900.0f },
      { 270.0f, 2290.0f, 3010.0f }, { 730.0f, 1090.0f, 2440.0f },
    };
    bool identityHolds = true;
    float worst = 0.0f;
    for (const auto& v : vecs) {
      voxFormantPatternResiduals(v[0], v[1], v[2], 0.0f,
                                 voxFitFormantScale(v[0], v[1], v[2], 0.0f), r);
      const float rho = voxResidualScaleFactor(r, 3);
      worst = fmaxf(worst, std::fabs(rho - 1.0f));
      if (std::fabs(rho - 1.0f) > 1e-4f) identityHolds = false;
    }
    check("pattern: sum(L_i*r_i) == 1 on a self-fitted frame",
          identityHolds, "max |rho-1|=" + f2s(worst));
  }

  std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "ALL PASS" : "FAILURES",
              g_failures, g_failures == 1 ? "" : "s");
  return g_failures == 0 ? 0 : 1;
}
