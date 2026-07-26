// ui.cpp — implementation of the hardware-agnostic UI model. See ui.h for the rationale.
#include "ui.h"

#include <math.h>
#include <stdio.h>

// ====================================================================
// Name tables
// ====================================================================
const char *const MODE_NAMES[]   = { "Vox Ball", "Color" };
const char *const SRC_NAMES[]    = { "Pitch", "Brightness", "Bounce", "Loudness", "Gender", "Weight" };
const char *const HAPTIC_NAMES[] = { "Off", "On target", "Syllables", "Bright", "Loud" };
const char *const EFFECT_NAMES[] = { "None", "Pulse", "Gradient", "Meter" };
const char *const BRIGHT_NAMES[] = { "Low", "Medium", "High" };
const char *const ONOFF[]        = { "Off", "On" };

const Pal PALETTE[] = {
  {"Blue", 30, 90, 255}, {"Teal", 0, 200, 180}, {"Green", 40, 220, 60},
  {"Purple", 150, 60, 230}, {"Red", 240, 40, 40}, {"Orange", 255, 140, 0},
  {"Pink", 255, 80, 170}, {"White", 240, 240, 240}, {"Cyan", 0, 230, 230},
  {"Magenta", 230, 0, 200}, {"Yellow", 240, 220, 0}, {"Lime", 170, 240, 40},
  {"Indigo", 70, 60, 220}, {"Rose", 255, 130, 150},
};
const int N_PAL = (int)(sizeof(PALETTE) / sizeof(PALETTE[0]));

const Preset PRESETS[] = {
  {"Custom", P_BLUE, P_PINK}, {"Trans", P_BLUE, P_PINK}, {"Fire", P_RED, P_YELLOW},
  {"Ocean", P_INDIGO, P_CYAN}, {"Forest", P_GREEN, P_LIME}, {"Sunset", P_PURPLE, P_ORANGE},
  {"Mono", P_TEAL, P_WHITE}, {"Candy", P_CYAN, P_MAGENTA},
};
const int N_PRESET = (int)(sizeof(PRESETS) / sizeof(PRESETS[0]));

const TutorialCard TUTORIAL[] = {
  { "Speak up",    "The ball follows your",   "pitch: higher voice,",     "higher ball." },
  { "Target band", "Tap the TOP or BOTTOM",   "of the screen to move",    "the green band." },
  { "Quick menu",  "Tap the MIDDLE for mic",  "reset, stats, settings.",  "Hold for settings." },
  { "Two views",   "Swipe left or right to",  "switch Ball and Color.",   "That's it - enjoy!" },
};
const int N_TUTORIAL = (int)(sizeof(TUTORIAL) / sizeof(TUTORIAL[0]));

// ====================================================================
// Small helpers
// ====================================================================
float uiClamp(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

static int absi(int v) { return v < 0 ? -v : v; }
static int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

void uiFormatFixed(float v, int decimals, char *out, size_t n) {
  const bool neg = (v < 0.0f);
  if (neg) v = -v;
  const long scale = (decimals >= 4) ? 10000L : 100L;
  // Guard the cast: an inf/NaN or absurd value would otherwise wrap the integer silently.
  if (!(v >= 0.0f) || v > 1.0e6f) { snprintf(out, n, "--"); return; }
  const long scaled = (long)(v * (float)scale + 0.5f);
  const long whole = scaled / scale, frac = scaled % scale;
  const char *sign = neg ? "-" : "";
  if (decimals >= 4) snprintf(out, n, "%s%ld.%04ld", sign, whole, frac);
  else               snprintf(out, n, "%s%ld.%02ld", sign, whole, frac);
}

// ====================================================================
// Settings
// ====================================================================
void uiSanitizeSettings(Settings &s) {
  if (s.mode > MODE_COLOR) s.mode = MODE_BALL;
  if (s.colorSrc >= SRC_COUNT) s.colorSrc = SRC_PITCH;
  if (s.loColor >= N_PAL) s.loColor = P_BLUE;
  if (s.hiColor >= N_PAL) s.hiColor = P_PINK;
  if (s.effect >= EFF_COUNT) s.effect = EFF_NONE;
  if (s.haptic >= HAP_COUNT) s.haptic = HAP_OFF;
  if (s.hapticThr > 100) s.hapticThr = 50;
  if (s.screenBri >= BRI_COUNT) s.screenBri = BRI_HIGH;
  s.autoDim   = s.autoDim ? 1 : 0;
  s.showBand  = s.showBand ? 1 : 0;
  s.showTrace = s.showTrace ? 1 : 0;
  s.showHud   = s.showHud ? 1 : 0;
  s.orb       = s.orb ? 1 : 0;
  s.tutorial  = s.tutorial ? 1 : 0;
  if (s.bestPct > 100) s.bestPct = 100;

  const uint16_t minHz = (uint16_t)VOX_PITCH_MIN_HZ, maxHz = (uint16_t)VOX_PITCH_MAX_HZ;
  if (s.targetLoHz < minHz || s.targetLoHz > maxHz - 10) s.targetLoHz = 145;
  if (s.targetHiHz < minHz + 10 || s.targetHiHz > maxHz) s.targetHiHz = 175;
  if (s.targetHiHz < s.targetLoHz + 10) s.targetHiHz = s.targetLoHz + 10;
}

bool uiNudgeBand(Settings &s, int deltaHz) {
  // Move the whole band, not each edge independently: clamping the edges separately would
  // silently squash the band's width once it reached the end of the pitch range.
  const int minHz = (int)VOX_PITCH_MIN_HZ, maxHz = (int)VOX_PITCH_MAX_HZ;
  int lo = (int)s.targetLoHz, hi = (int)s.targetHiHz;
  int shift = deltaHz;
  if (lo + shift < minHz) shift = minHz - lo;
  if (hi + shift > maxHz) shift = maxHz - hi;
  if (shift == 0) return false;
  s.targetLoHz = (uint16_t)(lo + shift);
  s.targetHiHz = (uint16_t)(hi + shift);
  return true;
}

// ====================================================================
// Colour maths
// ====================================================================
Rgb uiHsv(float hDeg, float s, float v) {
  hDeg = fmodf(hDeg, 360.0f); if (hDeg < 0) hDeg += 360.0f;
  float c = v * s, x = c * (1 - fabsf(fmodf(hDeg / 60.0f, 2.0f) - 1)), m = v - c;
  float r, g, b;
  if      (hDeg < 60)  { r = c; g = x; b = 0; }
  else if (hDeg < 120) { r = x; g = c; b = 0; }
  else if (hDeg < 180) { r = 0; g = c; b = x; }
  else if (hDeg < 240) { r = 0; g = x; b = c; }
  else if (hDeg < 300) { r = x; g = 0; b = c; }
  else                 { r = c; g = 0; b = x; }
  Rgb out;
  out.r = (uint8_t)((r + m) * 255);
  out.g = (uint8_t)((g + m) * 255);
  out.b = (uint8_t)((b + m) * 255);
  return out;
}

Rgb uiBlendPal(int loIdx, int hiIdx, float t, float v) {
  loIdx = clampi(loIdx, 0, N_PAL - 1);
  hiIdx = clampi(hiIdx, 0, N_PAL - 1);
  const Pal &a = PALETTE[loIdx], &b = PALETTE[hiIdx];
  t = uiClamp(t, 0, 1); v = uiClamp(v, 0, 1);
  Rgb out;
  out.r = (uint8_t)((a.r + (b.r - a.r) * t) * v);
  out.g = (uint8_t)((a.g + (b.g - a.g) * t) * v);
  out.b = (uint8_t)((a.b + (b.b - a.b) * t) * v);
  return out;
}

float uiLoudness(const VoxResult &r) { return uiClamp(r.rms * 8.0f, 0.0f, 1.0f); }

float uiMetricValue(const VoxResult &r, uint8_t src) {
  switch (src) {
    case SRC_PITCH:  return r.pitchPos;
    case SRC_BRIGHT: return r.brightness;
    case SRC_BOUNCE: return r.bounce;
    case SRC_GENDER: return r.genderScore;   // 0 masc .. 1 fem
    case SRC_WEIGHT: return r.weight;        // 0 light/breathy .. 1 heavy/pressed
    default:         return uiLoudness(r);   // SRC_LOUD
  }
}

int uiHzToY(float hz) {
  float pos = uiClamp((hz - VOX_PITCH_MIN_HZ) / (VOX_PITCH_MAX_HZ - VOX_PITCH_MIN_HZ), 0, 1);
  return UI_PLOT_TOP + (int)((1.0f - pos) * UI_PLOT_H);
}

// ====================================================================
// Settings menu model
// ====================================================================
// A row is shown only when it can actually do something in the current configuration.
static bool itemVisible(const Settings &s, uint8_t id) {
  switch (id) {
    case IT_SRC: case IT_PRESET: case IT_LO: case IT_HI: case IT_EFFECT:
      return s.mode == MODE_COLOR;
    case IT_BAND: case IT_TRACE:
      return s.mode == MODE_BALL;
    case IT_HTHR:
      return s.haptic == HAP_BRIGHT || s.haptic == HAP_LOUD;
    default:
      return true;
  }
}

int uiVisibleItems(const Settings &s, uint8_t *out, int maxOut) {
  int n = 0;
  for (int id = 0; id < IT_COUNT && n < maxOut; id++)
    if (itemVisible(s, (uint8_t)id)) out[n++] = (uint8_t)id;
  return n;
}

int uiPageCount(const Settings &s) {
  uint8_t items[UI_MAX_ITEMS];
  int n = uiVisibleItems(s, items, UI_MAX_ITEMS);
  return (n + UI_ROWS_PER_PAGE - 1) / UI_ROWS_PER_PAGE;
}

int uiPageItems(const Settings &s, int page, uint8_t *out, int maxOut) {
  uint8_t items[UI_MAX_ITEMS];
  int n = uiVisibleItems(s, items, UI_MAX_ITEMS);
  int start = page * UI_ROWS_PER_PAGE;
  if (page < 0 || start >= n) return 0;
  int count = n - start;
  if (count > UI_ROWS_PER_PAGE) count = UI_ROWS_PER_PAGE;
  if (count > maxOut) count = maxOut;
  for (int i = 0; i < count; i++) out[i] = items[start + i];
  return count;
}

void uiItemLabel(uint8_t id, char *out, size_t n) {
  const char *t;
  switch (id) {
    case IT_MODE:    t = "View";        break;
    case IT_SRC:     t = "Color from";  break;
    case IT_PRESET:  t = "Preset";      break;
    case IT_LO:      t = "Low color";   break;
    case IT_HI:      t = "High color";  break;
    case IT_EFFECT:  t = "Effect";      break;
    case IT_BAND:    t = "Target band"; break;
    case IT_TRACE:   t = "Pitch trace"; break;
    case IT_HAPTIC:  t = "Buzz on";     break;
    case IT_HTHR:    t = "Buzz above";  break;
    case IT_BRIGHT:  t = "Brightness";  break;
    case IT_AUTODIM: t = "Auto-dim";    break;
    case IT_HUD:     t = "Text + bars"; break;
    case IT_ORB:     t = "LED orb";     break;
    case IT_HELP:    t = "How to use";  break;
    default:         t = "Signal check"; break;  // IT_DIAG
  }
  snprintf(out, n, "%s", t);
}

void uiItemValue(const Settings &s, int presetIdx, uint8_t id, char *out, size_t n) {
  switch (id) {
    case IT_MODE:    snprintf(out, n, "%s", MODE_NAMES[s.mode % 2]); break;
    case IT_SRC:     snprintf(out, n, "%s", SRC_NAMES[s.colorSrc % SRC_COUNT]); break;
    case IT_PRESET:  snprintf(out, n, "%s", PRESETS[clampi(presetIdx, 0, N_PRESET - 1)].name); break;
    case IT_LO:      snprintf(out, n, "%s", PALETTE[clampi(s.loColor, 0, N_PAL - 1)].name); break;
    case IT_HI:      snprintf(out, n, "%s", PALETTE[clampi(s.hiColor, 0, N_PAL - 1)].name); break;
    case IT_EFFECT:  snprintf(out, n, "%s", EFFECT_NAMES[s.effect % EFF_COUNT]); break;
    case IT_BAND:    snprintf(out, n, "%s", ONOFF[s.showBand ? 1 : 0]); break;
    case IT_TRACE:   snprintf(out, n, "%s", ONOFF[s.showTrace ? 1 : 0]); break;
    case IT_HAPTIC:  snprintf(out, n, "%s", HAPTIC_NAMES[s.haptic % HAP_COUNT]); break;
    case IT_HTHR:    snprintf(out, n, "%d%%", s.hapticThr); break;
    case IT_BRIGHT:  snprintf(out, n, "%s", BRIGHT_NAMES[s.screenBri % BRI_COUNT]); break;
    case IT_AUTODIM: snprintf(out, n, "%s", ONOFF[s.autoDim ? 1 : 0]); break;
    case IT_HUD:     snprintf(out, n, "%s", ONOFF[s.showHud ? 1 : 0]); break;
    case IT_ORB:     snprintf(out, n, "%s", ONOFF[s.orb ? 1 : 0]); break;
    default:         snprintf(out, n, "Show"); break;   // IT_HELP, IT_DIAG
  }
}

ItemAction uiCycleItem(Settings &s, int &presetIdx, uint8_t id) {
  switch (id) {
    case IT_MODE:    s.mode = (s.mode + 1) % 2; break;
    case IT_SRC:     s.colorSrc = (s.colorSrc + 1) % SRC_COUNT; break;
    case IT_PRESET:
      presetIdx = (presetIdx + 1) % N_PRESET;
      if (presetIdx > 0) { s.loColor = PRESETS[presetIdx].lo; s.hiColor = PRESETS[presetIdx].hi; }
      break;
    case IT_LO:      s.loColor = (s.loColor + 1) % N_PAL; presetIdx = 0; break;
    case IT_HI:      s.hiColor = (s.hiColor + 1) % N_PAL; presetIdx = 0; break;
    case IT_EFFECT:  s.effect = (s.effect + 1) % EFF_COUNT; break;
    case IT_BAND:    s.showBand = !s.showBand; break;
    case IT_TRACE:   s.showTrace = !s.showTrace; break;
    case IT_HAPTIC:  s.haptic = (s.haptic + 1) % HAP_COUNT; break;
    case IT_HTHR:    s.hapticThr = (s.hapticThr >= 75) ? 25 : (uint8_t)(s.hapticThr + 25); break;
    case IT_BRIGHT:  s.screenBri = (s.screenBri + 1) % BRI_COUNT; break;
    case IT_AUTODIM: s.autoDim = !s.autoDim; break;
    case IT_HUD:     s.showHud = !s.showHud; break;
    case IT_ORB:     s.orb = !s.orb; break;
    case IT_HELP:    return ACT_HELP;
    default:         return ACT_DIAG;   // IT_DIAG
  }
  return ACT_VALUE;
}

bool uiItemHasSwatch(uint8_t id) { return id == IT_LO || id == IT_HI || id == IT_PRESET; }

// ====================================================================
// Touch gestures
// ====================================================================
void TouchTracker::reset() {
  down = false; longFired = false; moved = false;
}

TouchEvent TouchTracker::update(bool touched, int x, int y, uint32_t nowMs) {
  TouchEvent ev;

  if (touched && !down) {                      // finger lands
    down = true; longFired = false; moved = false;
    x0 = lastX = x; y0 = lastY = y; downMs = nowMs;
    ev.kind = TE_DOWN; ev.x = x; ev.y = y;
    return ev;
  }

  if (touched) {                               // still held
    lastX = x; lastY = y;
    if (absi(x - x0) > UI_TAP_SLOP_PX || absi(y - y0) > UI_TAP_SLOP_PX) moved = true;
    if (!longFired && !moved && (nowMs - downMs) >= UI_LONG_PRESS_MS) {
      longFired = true;
      ev.kind = TE_LONG; ev.x = x0; ev.y = y0;
    }
    return ev;
  }

  if (down) {                                  // released
    down = false;
    int dx = lastX - x0, dy = lastY - y0;
    bool wasLong = longFired;
    longFired = false; moved = false;
    if (!wasLong) {
      if (absi(dx) >= UI_SWIPE_MIN_PX && absi(dx) > absi(dy)) {
        ev.kind = (dx < 0) ? TE_SWIPE_L : TE_SWIPE_R;
        ev.x = x0; ev.y = y0;
      } else if (absi(dx) <= UI_TAP_SLOP_PX && absi(dy) <= UI_TAP_SLOP_PX) {
        ev.kind = TE_TAP; ev.x = x0; ev.y = y0;
      }
    }
  }
  return ev;
}

int uiTapZone(int y) {
  if (y < UI_SCR_H / 3) return 0;
  if (y > 2 * UI_SCR_H / 3) return 2;
  return 1;
}

// ====================================================================
// Pitch history
// ====================================================================
void PitchTrace::clear() { len = 0; }

void PitchTrace::push(int16_t y, bool voiced, bool inBand) {
  if (len >= UI_TRACE_LEN) {                       // scroll the window left by one
    for (int i = 1; i < UI_TRACE_LEN; i++) pts[i - 1] = pts[i];
    len = UI_TRACE_LEN - 1;
  }
  TracePt p;
  p.y = y; p.voiced = voiced; p.inBand = inBand;
  pts[len++] = p;
}

// ====================================================================
// Signal probe
// ====================================================================
void SignalProbe::reset() {
  frames = voicedFrames = atCeiling = atFloor = 0;
  peakHz = lowHz = peakRms = 0.0f;
}

void SignalProbe::update(const VoxResult &r) {
  frames++;
  if (r.rms > peakRms) peakRms = r.rms;
  if (!r.voiced) return;
  voicedFrames++;
  if (r.pitchHz > peakHz) peakHz = r.pitchHz;
  if (lowHz == 0.0f || r.pitchHz < lowHz) lowHz = r.pitchHz;
  if (r.pitchHz >= VOX_PITCH_MAX_HZ) atCeiling++;
  if (r.pitchHz <= VOX_PITCH_MIN_HZ) atFloor++;
}

int SignalProbe::ceilingPct() const {
  return voicedFrames ? (int)(100.0f * atCeiling / voicedFrames + 0.5f) : 0;
}
int SignalProbe::floorPct() const {
  return voicedFrames ? (int)(100.0f * atFloor / voicedFrames + 0.5f) : 0;
}

// ====================================================================
// Toast
// ====================================================================
void Toast::show(const char *m, uint32_t nowMs, uint32_t durMs) {
  snprintf(msg, sizeof(msg), "%s", m ? m : "");
  untilMs = nowMs + durMs;
  drawn = false;
}
bool Toast::visible(uint32_t nowMs) const {
  return msg[0] != '\0' && (int32_t)(untilMs - nowMs) > 0;
}
void Toast::clear() { msg[0] = '\0'; untilMs = 0; drawn = false; }

// ====================================================================
// Session scoreboard
// ====================================================================
void SessionStats::reset() {
  totalSecs = voicedSecs = inTargetSecs = pitchSum = 0.0f;
  pitchCount = 0; syllables = 0;
  pitchMin = pitchMax = 0.0f;
  prevImpulse = 0.0f;
}

void SessionStats::update(const VoxResult &r, float dt, bool inTarget) {
  if (dt < 0.0f) dt = 0.0f;
  totalSecs += dt;
  if (r.voiced) {
    voicedSecs += dt;
    if (inTarget) inTargetSecs += dt;
    if (r.pitchHz > 0.0f) {
      pitchSum += r.pitchHz;
      pitchCount++;
      if (pitchMin == 0.0f || r.pitchHz < pitchMin) pitchMin = r.pitchHz;
      if (r.pitchHz > pitchMax) pitchMax = r.pitchHz;
    }
  }
  // Same rising-edge test the ball's hop uses, so the count matches what you see.
  if (r.syllableImpulse > 0.6f && prevImpulse <= 0.6f) syllables++;
  prevImpulse = r.syllableImpulse;
}

int SessionStats::onTargetPct() const {
  if (voicedSecs <= 0.2f) return 0;
  return (int)(100.0f * inTargetSecs / voicedSecs + 0.5f);
}
float SessionStats::avgPitch() const {
  return pitchCount ? (pitchSum / (float)pitchCount) : 0.0f;
}
float SessionStats::syllablesPerMin() const {
  return totalSecs > 1.0f ? (syllables * 60.0f / totalSecs) : 0.0f;
}

// ====================================================================
// Quick menu
// ====================================================================
void uiQuickRect(int idx, int *x, int *y, int *w, int *h) {
  idx = clampi(idx, 0, QA_COUNT - 1);
  int col = idx % UI_QUICK_COLS, row = idx / UI_QUICK_COLS;
  *x = UI_QUICK_X0 + col * (UI_QUICK_W + UI_QUICK_GAP);
  *y = UI_QUICK_Y0 + row * (UI_QUICK_H + UI_QUICK_GAP);
  *w = UI_QUICK_W;
  *h = UI_QUICK_H;
}

int uiQuickHit(int x, int y) {
  for (int i = 0; i < QA_COUNT; i++) {
    int bx, by, bw, bh;
    uiQuickRect(i, &bx, &by, &bw, &bh);
    if (x >= bx && x < bx + bw && y >= by && y < by + bh) return i;
  }
  return -1;
}

const char *uiQuickLabel(int idx, const Settings &s) {
  switch (idx) {
    case QA_MODE:     return MODE_NAMES[s.mode % 2];
    case QA_RECAL:    return "Recalibrate";
    case QA_RESET:    return "Reset score";
    case QA_STATS:    return "Stats";
    case QA_SETTINGS: return "Settings";
    default:          return "Close";
  }
}

const char *uiQuickCaption(int idx) {
  switch (idx) {
    case QA_MODE:     return "VIEW";
    case QA_RECAL:    return "MIC";
    case QA_RESET:    return "SESSION";
    case QA_STATS:    return "SESSION";
    case QA_SETTINGS: return "ALL";
    default:          return "";
  }
}
