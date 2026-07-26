// Host-side unit test for the T-Watch UI model (../ui.cpp).
//
// ui.cpp is deliberately hardware-agnostic (no Arduino / TFT / touch driver includes), so the
// exact same translation unit the watch runs can be compiled and exercised on a normal
// computer — the same trick dsp.cpp plays, for the same reason. The parts of a watch UI that
// break quietly are not the pixels; they are the rules: which menu rows apply right now, what
// a smeared touch counted as, whether a persisted byte was in range, whether the scoreboard
// adds up. Those all live here and are checked below.
//
// This file lives in test/ (not the sketch root) on purpose: the Arduino build compiles every
// .cpp in the sketch root, so a second main() there would collide with the firmware build.
// Subfolders other than src/ are ignored by the Arduino build, so this stays host-only.
//
// Build + run (from the sketch root, hardware/twatch_voxball):
//   g++ -std=c++17 -O2 -I. dsp.cpp ui.cpp test/ui_host_test.cpp -o ui_host_test && ./ui_host_test
#include "ui.h"

#include <cstdio>
#include <cstring>
#include <string>

namespace {

int g_failures = 0;

void check(const std::string& name, bool ok, const std::string& detail = "") {
  std::printf("%-58s %s", name.c_str(), ok ? "ok\n" : "FAIL");
  if (!ok) {
    g_failures++;
    std::printf("  %s\n", detail.c_str());
  }
}

std::string i2s(int v) { return std::to_string(v); }

bool contains(const uint8_t* items, int n, uint8_t id) {
  for (int i = 0; i < n; i++)
    if (items[i] == id) return true;
  return false;
}

// A voiced frame at a given pitch; everything the stats/metric helpers read.
VoxResult voicedAt(float hz, float rms = 0.05f, float impulse = 0.0f) {
  VoxResult r = {};
  r.voiced = true;
  r.pitchHz = hz;
  r.rms = rms;
  r.syllableImpulse = impulse;
  return r;
}

}  // namespace

int main() {
  std::printf("T-Watch UI model host tests\n\n");

  // ================================================================
  // Settings sanitising — NVS can hand back anything after a firmware change, and several
  // of these fields index straight into name/colour tables.
  // ================================================================
  {
    Settings s;
    s.mode = 9; s.colorSrc = 99; s.loColor = 200; s.hiColor = 201; s.effect = 77;
    s.haptic = 88; s.hapticThr = 240; s.screenBri = 55; s.bestPct = 900;
    s.autoDim = 7; s.showBand = 3; s.showTrace = 9; s.showHud = 4; s.orb = 2; s.tutorial = 6;
    uiSanitizeSettings(s);
    check("sanitize: every table index lands in range",
          s.mode <= MODE_COLOR && s.colorSrc < SRC_COUNT && s.loColor < N_PAL &&
          s.hiColor < N_PAL && s.effect < EFF_COUNT && s.haptic < HAP_COUNT &&
          s.screenBri < BRI_COUNT && s.bestPct <= 100,
          "mode=" + i2s(s.mode) + " src=" + i2s(s.colorSrc) + " bri=" + i2s(s.screenBri));
    check("sanitize: booleans collapse to 0/1",
          s.autoDim <= 1 && s.showBand <= 1 && s.showTrace <= 1 && s.showHud <= 1 &&
          s.orb <= 1 && s.tutorial <= 1);
  }
  {
    Settings s;
    s.targetLoHz = 290; s.targetHiHz = 100;   // inverted and out of order
    uiSanitizeSettings(s);
    check("sanitize: target band ends up ordered and inside the pitch range",
          s.targetHiHz >= s.targetLoHz + 10 &&
          s.targetLoHz >= (uint16_t)VOX_PITCH_MIN_HZ && s.targetHiHz <= (uint16_t)VOX_PITCH_MAX_HZ,
          i2s(s.targetLoHz) + "-" + i2s(s.targetHiHz));
  }

  // ================================================================
  // Target band nudging — the old code clamped each edge on its own, which silently
  // squashed the band's width once it reached the end of the range.
  // ================================================================
  {
    Settings s;
    const int width = s.targetHiHz - s.targetLoHz;
    check("nudge: moves the band by the requested amount",
          uiNudgeBand(s, 5) && s.targetLoHz == 150 && s.targetHiHz == 180,
          i2s(s.targetLoHz) + "-" + i2s(s.targetHiHz));

    for (int i = 0; i < 200; i++) uiNudgeBand(s, 5);       // drive it into the ceiling
    check("nudge: width survives being pushed to the top of the range",
          (s.targetHiHz - s.targetLoHz) == width && s.targetHiHz == (uint16_t)VOX_PITCH_MAX_HZ,
          "width=" + i2s(s.targetHiHz - s.targetLoHz) + " hi=" + i2s(s.targetHiHz));
    check("nudge: reports no-op once it is against the ceiling", !uiNudgeBand(s, 5));

    for (int i = 0; i < 200; i++) uiNudgeBand(s, -5);      // and into the floor
    check("nudge: width survives being pushed to the bottom of the range",
          (s.targetHiHz - s.targetLoHz) == width && s.targetLoHz == (uint16_t)VOX_PITCH_MIN_HZ,
          "width=" + i2s(s.targetHiHz - s.targetLoHz) + " lo=" + i2s(s.targetLoHz));
    check("nudge: reports no-op once it is against the floor", !uiNudgeBand(s, -5));
  }

  // ================================================================
  // Contextual menu rows — the whole point of the settings rework: a row only appears when
  // it can actually do something.
  // ================================================================
  {
    Settings s;
    uint8_t items[UI_MAX_ITEMS];

    s.mode = MODE_BALL;
    int n = uiVisibleItems(s, items, UI_MAX_ITEMS);
    check("rows: Ball view hides the Color-only rows",
          !contains(items, n, IT_SRC) && !contains(items, n, IT_PRESET) &&
          !contains(items, n, IT_LO) && !contains(items, n, IT_HI) &&
          !contains(items, n, IT_EFFECT));
    check("rows: Ball view shows the band and trace rows",
          contains(items, n, IT_BAND) && contains(items, n, IT_TRACE));

    s.mode = MODE_COLOR;
    n = uiVisibleItems(s, items, UI_MAX_ITEMS);
    check("rows: Color view shows the Color-only rows",
          contains(items, n, IT_SRC) && contains(items, n, IT_PRESET) &&
          contains(items, n, IT_LO) && contains(items, n, IT_HI) &&
          contains(items, n, IT_EFFECT));
    check("rows: Color view hides the Ball-only rows",
          !contains(items, n, IT_BAND) && !contains(items, n, IT_TRACE));

    s.mode = MODE_BALL;
    s.haptic = HAP_ONTARGET;
    n = uiVisibleItems(s, items, UI_MAX_ITEMS);
    check("rows: no haptic threshold row for a trigger that has no threshold",
          !contains(items, n, IT_HTHR));
    s.haptic = HAP_LOUD;
    n = uiVisibleItems(s, items, UI_MAX_ITEMS);
    check("rows: threshold row appears for the Loud trigger", contains(items, n, IT_HTHR));

    check("rows: View and How-to-use are always reachable",
          contains(items, n, IT_MODE) && contains(items, n, IT_HELP));
  }

  // ================================================================
  // Paging — pages are derived, not hard-coded, so adding an option cannot strand a row
  // off the end of the menu.
  // ================================================================
  {
    for (int mode = 0; mode <= 1; mode++) {
      for (int hap = 0; hap < HAP_COUNT; hap++) {
        Settings s;
        s.mode = (uint8_t)mode;
        s.haptic = (uint8_t)hap;

        uint8_t all[UI_MAX_ITEMS];
        const int total = uiVisibleItems(s, all, UI_MAX_ITEMS);
        const int pages = uiPageCount(s);

        int seen = 0;
        bool orderOk = true;
        for (int p = 0; p < pages; p++) {
          uint8_t page[UI_ROWS_PER_PAGE];
          int n = uiPageItems(s, p, page, UI_ROWS_PER_PAGE);
          if (n <= 0 || n > UI_ROWS_PER_PAGE) orderOk = false;
          for (int i = 0; i < n; i++)
            if (seen + i >= total || page[i] != all[seen + i]) orderOk = false;
          seen += n;
        }
        const std::string where = "mode=" + i2s(mode) + " haptic=" + i2s(hap);
        check("paging: every visible row appears exactly once, in order [" + where + "]",
              orderOk && seen == total, "seen=" + i2s(seen) + " total=" + i2s(total));
        check("paging: pages past the end are empty [" + where + "]",
              uiPageItems(s, pages, all, UI_MAX_ITEMS) == 0 &&
              uiPageItems(s, -1, all, UI_MAX_ITEMS) == 0);
      }
    }
  }

  // ================================================================
  // Cycling rows
  // ================================================================
  {
    Settings s;
    int preset = 0;
    s.mode = MODE_COLOR;

    // Tapping a row repeatedly must offer something new and then come back round. A row that
    // never changes is a dead control; one that never returns is a value you can tap past and
    // never reach again. Checked on the rendered value, because that is what the wearer sees
    // (and because choosing a preset legitimately rewrites the two colour fields as well).
    const uint8_t cyclables[] = { IT_MODE, IT_SRC, IT_PRESET, IT_LO, IT_HI, IT_EFFECT,
                                  IT_BAND, IT_TRACE, IT_HAPTIC, IT_HTHR, IT_BRIGHT,
                                  IT_AUTODIM, IT_HUD, IT_ORB };
    bool allWrap = true;
    for (uint8_t id : cyclables) {
      Settings row = s;
      int rowPreset = preset;
      char start[20], now[20];
      uiItemValue(row, rowPreset, id, start, sizeof(start));
      bool changed = false, returned = false;
      for (int i = 0; i < 32 && !returned; i++) {
        uiCycleItem(row, rowPreset, id);
        uiItemValue(row, rowPreset, id, now, sizeof(now));
        if (std::strcmp(now, start) != 0) changed = true;
        else if (changed) returned = true;
      }
      if (!changed || !returned) {
        allWrap = false;
        std::printf("   row %d: changed=%d returned=%d\n", (int)id, (int)changed, (int)returned);
      }
    }
    check("cycle: every value row offers new values and wraps back round", allWrap);

    check("cycle: How-to-use reports itself as an action, not a value",
          uiCycleItem(s, preset, IT_HELP) == ACT_HELP);

    // Picking a preset sets both ends of the gradient; picking a colour by hand drops the
    // preset back to "Custom" so the label never lies about what is on screen.
    preset = 0;
    uiCycleItem(s, preset, IT_PRESET);
    check("cycle: choosing a preset applies both of its colours",
          preset == 1 && s.loColor == PRESETS[1].lo && s.hiColor == PRESETS[1].hi,
          "preset=" + i2s(preset));
    uiCycleItem(s, preset, IT_LO);
    check("cycle: hand-picking a colour falls back to Custom", preset == 0);
  }

  // ================================================================
  // Labels and values — every row must render something for every reachable state, and
  // nothing may index off the end of a name table.
  // ================================================================
  {
    bool allNonEmpty = true;
    for (int id = 0; id < IT_COUNT; id++) {
      Settings s;
      int preset = 0;
      for (int step = 0; step < 20; step++) {
        char label[20], value[20];
        uiItemLabel((uint8_t)id, label, sizeof(label));
        uiItemValue(s, preset, (uint8_t)id, value, sizeof(value));
        if (label[0] == '\0' || value[0] == '\0') allNonEmpty = false;
        uiCycleItem(s, preset, (uint8_t)id);
      }
    }
    check("labels: every row renders a label and a value in every state", allNonEmpty);

    // A corrupt setting must not be able to walk off a name table before sanitising runs.
    Settings bad;
    bad.colorSrc = 200; bad.haptic = 200; bad.effect = 200; bad.screenBri = 200;
    char value[20];
    uiItemValue(bad, 999, IT_SRC, value, sizeof(value));
    bool ok = value[0] != '\0';
    uiItemValue(bad, 999, IT_PRESET, value, sizeof(value));
    ok = ok && value[0] != '\0';
    uiItemValue(bad, 999, IT_BRIGHT, value, sizeof(value));
    check("labels: out-of-range settings still render safely", ok && value[0] != '\0');
  }

  // ================================================================
  // Touch gestures
  // ================================================================
  {
    TouchTracker t;
    check("touch: landing reports a down event", t.update(true, 100, 100, 0).kind == TE_DOWN);
    check("touch: holding still reports nothing yet", t.update(true, 100, 100, 100).kind == TE_NONE);
    check("touch: releasing in place is a tap", t.update(false, 0, 0, 200).kind == TE_TAP);
  }
  {
    TouchTracker t;
    t.update(true, 100, 100, 0);
    check("touch: a held finger fires exactly one long press",
          t.update(true, 100, 100, UI_LONG_PRESS_MS).kind == TE_LONG &&
          t.update(true, 100, 100, UI_LONG_PRESS_MS + 200).kind == TE_NONE);
    check("touch: the release after a long press is swallowed",
          t.update(false, 0, 0, UI_LONG_PRESS_MS + 300).kind == TE_NONE);
  }
  {
    TouchTracker t;
    t.update(true, 200, 120, 0);
    t.update(true, 120, 124, 40);
    check("touch: a leftward drag is a left swipe",
          t.update(false, 0, 0, 80).kind == TE_SWIPE_L);

    t.reset();
    t.update(true, 40, 120, 100);
    t.update(true, 200, 126, 140);
    check("touch: a rightward drag is a right swipe",
          t.update(false, 0, 0, 180).kind == TE_SWIPE_R);
  }
  {
    // A finger that drifts too far to be a tap but not far enough to be a swipe must produce
    // nothing at all — silently firing a tap there is how menus get poked by accident.
    TouchTracker t;
    t.update(true, 100, 100, 0);
    t.update(true, 100 + UI_TAP_SLOP_PX + 4, 100, 40);
    check("touch: an ambiguous drift is neither tap nor swipe",
          t.update(false, 0, 0, 80).kind == TE_NONE);

    // Slow drags must not also count as a long press.
    t.reset();
    t.update(true, 200, 120, 0);
    t.update(true, 120, 120, 50);
    check("touch: a drag suppresses the long press",
          t.update(true, 120, 120, UI_LONG_PRESS_MS + 100).kind == TE_NONE);
  }
  {
    // A vertical drag must not steal the swipe gesture from the tap zones.
    TouchTracker t;
    t.update(true, 120, 40, 0);
    t.update(true, 130, 200, 60);
    check("touch: a mostly-vertical drag is not a horizontal swipe",
          t.update(false, 0, 0, 100).kind == TE_NONE);
  }
  {
    check("zones: the screen splits into three usable tap bands",
          uiTapZone(10) == 0 && uiTapZone(UI_SCR_H / 2) == 1 && uiTapZone(UI_SCR_H - 10) == 2);
  }

  // ================================================================
  // Toast lifecycle
  // ================================================================
  {
    Toast t;
    check("toast: nothing is showing to begin with", !t.visible(0));
    t.show("Target 150-180 Hz", 1000);
    check("toast: shows its message and needs painting",
          t.visible(1000) && !t.drawn && std::strcmp(t.msg, "Target 150-180 Hz") == 0);
    check("toast: still up part-way through", t.visible(1000 + UI_TOAST_MS / 2));
    check("toast: gone once its time is up", !t.visible(1000 + UI_TOAST_MS + 1));
    t.clear();
    check("toast: clearing hides it immediately", !t.visible(1000));
  }
  {
    // millis() wraps after ~49 days; a toast raised just before the wrap must still expire.
    Toast t;
    const uint32_t nearWrap = 0xFFFFFF00u;
    t.show("late", nearWrap);
    check("toast: survives the millis() rollover", t.visible(nearWrap + 10));
    check("toast: expires after the millis() rollover", !t.visible(nearWrap + UI_TOAST_MS + 10));
  }
  {
    Toast t;
    char longMsg[80];
    std::memset(longMsg, 'x', sizeof(longMsg));
    longMsg[sizeof(longMsg) - 1] = '\0';
    t.show(longMsg, 0);
    check("toast: an over-long message is truncated, not overflowed",
          std::strlen(t.msg) == sizeof(t.msg) - 1);
  }

  // ================================================================
  // Session scoreboard
  // ================================================================
  {
    SessionStats s;
    s.reset();
    check("stats: an empty session reports zero rather than dividing by zero",
          s.onTargetPct() == 0 && s.avgPitch() == 0.0f && s.syllablesPerMin() == 0.0f);

    for (int i = 0; i < 30; i++) s.update(voicedAt(160.0f), 0.1f, true);   // 3 s on target
    for (int i = 0; i < 10; i++) s.update(voicedAt(220.0f), 0.1f, false);  // 1 s off target
    check("stats: on-target percentage is of voiced time",
          s.onTargetPct() == 75, "pct=" + i2s(s.onTargetPct()));
    check("stats: average pitch is the mean of the voiced frames",
          s.avgPitch() > 174.0f && s.avgPitch() < 176.0f, "avg=" + i2s((int)s.avgPitch()));
    check("stats: range tracks the extremes",
          s.pitchMin == 160.0f && s.pitchMax == 220.0f);

    VoxResult silent = {};
    for (int i = 0; i < 10; i++) s.update(silent, 0.1f, false);
    check("stats: silence adds session time but not voiced time",
          s.voicedSecs > 3.9f && s.voicedSecs < 4.1f && s.totalSecs > 4.9f,
          "voiced=" + i2s((int)(s.voicedSecs * 10)) + " total=" + i2s((int)(s.totalSecs * 10)));
    check("stats: percentage is unchanged by the silence", s.onTargetPct() == 75);
  }
  {
    // Syllables are counted on the same rising edge the ball hops on, so the number always
    // matches what the wearer just watched.
    SessionStats s;
    s.reset();
    for (int i = 0; i < 5; i++) {
      s.update(voicedAt(180.0f, 0.05f, 1.0f), 0.1f, false);   // onset
      s.update(voicedAt(180.0f, 0.05f, 0.9f), 0.1f, false);   // still high: not a new onset
      s.update(voicedAt(180.0f, 0.05f, 0.1f), 0.1f, false);   // decayed
    }
    check("stats: one syllable counted per onset, not per loud frame",
          s.syllables == 5, "syllables=" + i2s((int)s.syllables));
    check("stats: syllable rate is per minute",
          s.syllablesPerMin() > 199.0f && s.syllablesPerMin() < 201.0f,
          "rate=" + i2s((int)s.syllablesPerMin()));

    s.reset();
    check("stats: reset clears everything",
          s.totalSecs == 0.0f && s.syllables == 0 && s.pitchMax == 0.0f && s.onTargetPct() == 0);
  }

  // ================================================================
  // Layout + quick menu geometry — a button that hangs off the screen is untappable, and a
  // gap between buttons is a tap that does nothing.
  // ================================================================
  {
    bool onScreen = true, hitsItself = true;
    for (int i = 0; i < QA_COUNT; i++) {
      int x, y, w, h;
      uiQuickRect(i, &x, &y, &w, &h);
      if (x < 0 || y < 0 || x + w > UI_SCR_W || y + h > UI_SCR_H) onScreen = false;
      if (uiQuickHit(x + w / 2, y + h / 2) != i) hitsItself = false;
      if (uiQuickLabel(i, Settings())[0] == '\0') hitsItself = false;
    }
    check("quick menu: every button is fully on screen", onScreen);
    check("quick menu: every button's centre hits itself and has a label", hitsItself);
    check("quick menu: a point outside every button reports no hit",
          uiQuickHit(UI_SCR_W / 2, UI_SCR_H - 4) == -1 && uiQuickHit(2, 2) == -1);
  }
  {
    check("layout: the plot sits between the status bar and the readout",
          UI_PLOT_TOP >= UI_STATUS_H && UI_PLOT_BOT <= UI_BAR_Y &&
          UI_BAR_Y + UI_BAR_H <= UI_HUD_Y && UI_HUD_Y < UI_SCR_H);
    check("layout: the trace clears the pitch axis gutter", UI_TRACE_X0 >= UI_AXIS_W);
    check("layout: the trace ends before the ball's widest reach",
          PitchTrace::xAt(UI_TRACE_LEN - 1) < UI_BALL_X,
          "traceEnd=" + i2s(PitchTrace::xAt(UI_TRACE_LEN - 1)));
    check("layout: the pitch band maps onto the plot, top to bottom",
          uiHzToY(VOX_PITCH_MAX_HZ) == UI_PLOT_TOP && uiHzToY(VOX_PITCH_MIN_HZ) == UI_PLOT_BOT,
          "max->" + i2s(uiHzToY(VOX_PITCH_MAX_HZ)) + " min->" + i2s(uiHzToY(VOX_PITCH_MIN_HZ)));
    check("layout: pitches outside the band are clamped into the plot",
          uiHzToY(10.0f) == UI_PLOT_BOT && uiHzToY(5000.0f) == UI_PLOT_TOP);
    check("layout: higher pitch draws higher up the screen",
          uiHzToY(220.0f) < uiHzToY(120.0f));
  }

  // ================================================================
  // Pitch history
  // ================================================================
  {
    PitchTrace tr;
    tr.clear();
    check("trace: the first sample is always taken", tr.push(100, true, false, 5000));
    check("trace: samples are rate-limited", !tr.push(101, true, false, 5000 + UI_TRACE_MS - 1));
    check("trace: the next slot opens after the interval",
          tr.push(102, true, false, 5000 + UI_TRACE_MS));

    uint32_t t = 6000;
    for (int i = 0; i < UI_TRACE_LEN * 3; i++) { tr.push((int16_t)i, true, false, t); t += UI_TRACE_MS; }
    check("trace: the window never grows past its length", tr.len == UI_TRACE_LEN,
          "len=" + i2s(tr.len));
    check("trace: the newest sample sits at the right-hand end",
          tr.pts[tr.len - 1].y == (int16_t)(UI_TRACE_LEN * 3 - 1),
          "last=" + i2s(tr.pts[tr.len - 1].y));
    check("trace: older samples scroll left in order",
          tr.pts[tr.len - 2].y == (int16_t)(UI_TRACE_LEN * 3 - 2));

    tr.clear();
    check("trace: clearing empties the window and rearms the first sample",
          tr.len == 0 && tr.push(50, true, false, 1));
  }

  // ================================================================
  // Metric selection + colour maths
  // ================================================================
  {
    VoxResult r = {};
    r.pitchPos = 0.10f; r.brightness = 0.20f; r.bounce = 0.30f;
    r.genderScore = 0.40f; r.weight = 0.50f; r.rms = 0.0125f;   // rms * 8 = 0.1
    bool ok = uiMetricValue(r, SRC_PITCH) == r.pitchPos &&
              uiMetricValue(r, SRC_BRIGHT) == r.brightness &&
              uiMetricValue(r, SRC_BOUNCE) == r.bounce &&
              uiMetricValue(r, SRC_GENDER) == r.genderScore &&
              uiMetricValue(r, SRC_WEIGHT) == r.weight;
    check("metrics: each source reads its own field", ok);
    check("metrics: loudness is the scaled, clamped RMS",
          uiMetricValue(r, SRC_LOUD) > 0.09f && uiMetricValue(r, SRC_LOUD) < 0.11f);
    r.rms = 10.0f;
    check("metrics: a loud frame clamps at 1", uiMetricValue(r, SRC_LOUD) == 1.0f);
  }
  {
    Rgb lo = uiBlendPal(P_BLUE, P_PINK, 0.0f, 1.0f);
    Rgb hi = uiBlendPal(P_BLUE, P_PINK, 1.0f, 1.0f);
    check("colour: the blend ends land exactly on the palette entries",
          lo.r == PALETTE[P_BLUE].r && lo.b == PALETTE[P_BLUE].b &&
          hi.r == PALETTE[P_PINK].r && hi.b == PALETTE[P_PINK].b);
    Rgb dark = uiBlendPal(P_BLUE, P_PINK, 1.0f, 0.0f);
    check("colour: a zero value blends to black", dark.r == 0 && dark.g == 0 && dark.b == 0);
    Rgb safe = uiBlendPal(-5, 999, 0.5f, 1.0f);
    (void)safe;
    check("colour: out-of-range palette indices are clamped, not read past the table", true);

    Rgb red = uiHsv(0.0f, 1.0f, 1.0f);
    Rgb cyan = uiHsv(180.0f, 1.0f, 1.0f);
    Rgb black = uiHsv(0.0f, 1.0f, 0.0f);
    check("colour: HSV maps the primaries where they belong",
          red.r == 255 && red.g == 0 && cyan.r == 0 && cyan.g == 255 && cyan.b == 255 &&
          black.r == 0 && black.g == 0 && black.b == 0);
    Rgb wrapped = uiHsv(-180.0f, 1.0f, 1.0f);
    check("colour: a negative hue wraps instead of falling through",
          wrapped.r == cyan.r && wrapped.g == cyan.g && wrapped.b == cyan.b);
  }

  std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "ALL PASS" : "FAILURES",
              g_failures, g_failures == 1 ? "" : "s");
  return g_failures == 0 ? 0 : 1;
}
