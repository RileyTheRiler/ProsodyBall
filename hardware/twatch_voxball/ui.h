// ui.h — hardware-agnostic UI model for the T-Watch ProsodyBall firmware.
//
// Everything here is pure C++: no Arduino, no TFT_eSPI, no I2S. The sketch
// (twatch_voxball.ino) owns pixels and hardware; this owns *decisions* — what the settings
// are, which rows a menu shows, what a touch means, when a toast expires, what the session
// scoreboard says. Same split as dsp.h/dsp.cpp, and for the same reason: the parts that are
// easy to get subtly wrong are the parts you cannot see on a 240x240 screen, so they get
// compiled and unit-tested on a normal computer (test/ui_host_test.cpp) instead.
#pragma once

#include <stdint.h>
#include <stddef.h>

#include "dsp.h"   // VoxResult + the pitch band the layout maps onto

// ====================================================================
// Screen layout (240x240). Shared so the tests can assert the geometry stays sane.
// ====================================================================
static const int UI_SCR_W = 240;
static const int UI_SCR_H = 240;

static const int UI_STATUS_H = 26;   // top bar: clock, mode, battery
static const int UI_PLOT_TOP = 32;   // ball travel area, top edge
static const int UI_PLOT_BOT = 190;  // ball travel area, bottom edge
static const int UI_PLOT_H   = UI_PLOT_BOT - UI_PLOT_TOP;
static const int UI_BAR_Y    = 193;  // on-target progress bar
static const int UI_BAR_H    = 4;
static const int UI_HUD_Y    = 198;  // bottom readout strip

// Pitch axis gutter on the left; the trace and the target band both start clear of it.
static const int UI_AXIS_W    = 28;
static const int UI_TRACE_X0  = 30;   // left edge of the pitch history trace
static const int UI_TRACE_STEP = 6;   // px between trace samples
static const int UI_TRACE_LEN  = 20;  // samples kept (one per analysis frame, so ~1.3 s)
static const int UI_BALL_X    = 160;  // ball sits right of centre so the trace has room

// ====================================================================
// Scrolling pitch history (Ball view)
// ====================================================================
// A single dot says where your voice is right now; the trace says what your intonation just
// did, which is the thing the training is actually about. Lives here (rather than in the
// sketch) both so it can be tested and because the Arduino build inserts auto-generated
// prototypes above the sketch's own type definitions — a struct used in a function signature
// has to come from a header.
struct TracePt { int16_t y; bool voiced; bool inBand; };

struct PitchTrace {
  TracePt  pts[UI_TRACE_LEN];
  int      len = 0;

  void clear();
  // Append one sample, scrolling the window left once it is full.
  //
  // Call this exactly once per DSP analysis frame — never from the render loop. The DSP
  // emits a frame every ~64 ms while the loop runs at ~60 Hz; sampling the slower signal on
  // the faster, unrelated clock makes the two beat against each other, duplicating and
  // dropping samples in a slow cycle that stair-steps the trace with movement that was never
  // in the voice. Taking the frame as the clock makes that impossible by construction.
  void push(int16_t y, bool voiced, bool inBand);
  // Screen x of sample i.
  static int xAt(int i) { return UI_TRACE_X0 + i * UI_TRACE_STEP; }
};

// ====================================================================
// Settings (persisted to NVS by the sketch)
// ====================================================================
enum Mode      { MODE_BALL = 0, MODE_COLOR = 1 };
enum HueMetric { SRC_PITCH = 0, SRC_BRIGHT, SRC_BOUNCE, SRC_LOUD, SRC_GENDER, SRC_WEIGHT, SRC_COUNT };
enum Haptic    { HAP_OFF = 0, HAP_ONTARGET, HAP_SYLLABLE, HAP_BRIGHT, HAP_LOUD, HAP_COUNT };
enum Effect    { EFF_NONE = 0, EFF_PULSE, EFF_GRADIENT, EFF_METER, EFF_COUNT };
enum Bright    { BRI_LOW = 0, BRI_MED, BRI_HIGH, BRI_COUNT };

struct Settings {
  uint8_t  mode      = MODE_BALL;
  uint8_t  colorSrc  = SRC_PITCH;   // which metric drives the colour
  uint8_t  loColor   = 0;           // palette index at metric=0
  uint8_t  hiColor   = 6;           // palette index at metric=1
  uint8_t  effect    = EFF_NONE;    // Color-mode visual effect
  uint8_t  haptic    = HAP_ONTARGET;
  uint8_t  hapticThr = 50;          // % threshold for the >threshold haptics
  uint8_t  screenBri = BRI_HIGH;    // backlight level
  uint8_t  autoDim   = 1;           // auto-dim + tilt-wake on/off
  uint8_t  showBand  = 1;           // pitch-target band + glow + score on/off
  uint8_t  showTrace = 1;           // pitch history trace on/off (Ball mode)
  uint8_t  showHud   = 1;           // status bar + bottom readout on/off
  uint8_t  orb       = 0;           // BLE companion: drive the LED orb on/off
  uint8_t  tutorial  = 0;           // 1 once the walkthrough has been seen
  uint16_t targetLoHz = 145;
  uint16_t targetHiHz = 175;
  uint16_t bestPct   = 0;           // best on-target % across sessions
};

// Clamp every field to its valid range. NVS can hand back stale or corrupt values after a
// firmware change, and several of these index into name/colour tables.
void uiSanitizeSettings(Settings &s);

// Shift the target band by deltaHz, keeping its width constant and stopping at the edges of
// the analysed pitch range. Returns true if the band actually moved.
bool uiNudgeBand(Settings &s, int deltaHz);

// ====================================================================
// Colour helpers (pure maths; the sketch converts to RGB565)
// ====================================================================
struct Rgb { uint8_t r, g, b; };

// Display names, indexed by the enums above.
extern const char *const MODE_NAMES[];
extern const char *const SRC_NAMES[];
extern const char *const HAPTIC_NAMES[];
extern const char *const EFFECT_NAMES[];
extern const char *const BRIGHT_NAMES[];
extern const char *const ONOFF[];

struct Pal { const char *name; uint8_t r, g, b; };
extern const Pal PALETTE[];
extern const int N_PAL;

// Palette indices, in PALETTE order.
enum { P_BLUE = 0, P_TEAL, P_GREEN, P_PURPLE, P_RED, P_ORANGE, P_PINK, P_WHITE,
       P_CYAN, P_MAGENTA, P_YELLOW, P_LIME, P_INDIGO, P_ROSE };

// Named gradient presets: selecting one sets both the low and high colours.
// "Custom" (index 0) leaves the current colours untouched.
struct Preset { const char *name; uint8_t lo, hi; };
extern const Preset PRESETS[];
extern const int N_PRESET;

float uiClamp(float v, float lo, float hi);

// Format v with `decimals` digits (2 or 4) using integer maths only.
//
// Deliberately not snprintf's "%f": float support in printf is a build-time newlib option on
// the ESP32 toolchain rather than a guarantee, and the one screen that must never lie is the
// diagnostic screen. Doing it by hand costs nothing and removes the question.
void uiFormatFixed(float v, int decimals, char *out, size_t n);
Rgb   uiHsv(float hDeg, float s, float v);                       // h in degrees, s/v 0..1
Rgb   uiBlendPal(int loIdx, int hiIdx, float t, float v);        // blend by t, scaled by v
float uiMetricValue(const VoxResult &r, uint8_t src);            // the chosen metric, 0..1
float uiLoudness(const VoxResult &r);                            // rms -> 0..1
int   uiHzToY(float hz);                                         // pitch -> plot row

// ====================================================================
// Settings menu model
// ====================================================================
// Rows are filtered by context: the Color-mode rows are pointless in Ball mode (and vice
// versa), and a haptic threshold means nothing unless a threshold-based trigger is selected.
// Hiding them is what turns a wall of 14 options into two short, relevant pages.
enum ItemId {
  IT_MODE = 0, IT_SRC, IT_PRESET, IT_LO, IT_HI, IT_EFFECT,
  IT_BAND, IT_TRACE, IT_HAPTIC, IT_HTHR, IT_BRIGHT, IT_AUTODIM,
  IT_HUD, IT_ORB, IT_HELP, IT_DIAG, IT_COUNT
};

static const int UI_ROWS_PER_PAGE = 6;
static const int UI_MAX_ITEMS     = IT_COUNT;

// Tapping a row usually just cycles its value; a few rows are actions instead.
enum ItemAction { ACT_VALUE = 0, ACT_HELP, ACT_DIAG };

// Visible rows for the current settings, in display order. Returns the count written.
int uiVisibleItems(const Settings &s, uint8_t *out, int maxOut);
int uiPageCount(const Settings &s);
// Rows on `page` (0-based). Returns the count written; 0 if the page is out of range.
int uiPageItems(const Settings &s, int page, uint8_t *out, int maxOut);

void       uiItemLabel(uint8_t id, char *out, size_t n);
void       uiItemValue(const Settings &s, int presetIdx, uint8_t id, char *out, size_t n);
// Advance the row's value (wrapping). presetIdx is runtime-only state: picking a preset sets
// both colours, and picking a colour by hand drops back to "Custom".
ItemAction uiCycleItem(Settings &s, int &presetIdx, uint8_t id);
// True when the row shows a colour swatch next to its value.
bool       uiItemHasSwatch(uint8_t id);

// ====================================================================
// Touch gestures
// ====================================================================
// One place decides what a touch *meant*, so the run screen, the menus and the walkthrough
// all agree on what counts as a tap versus a swipe versus a long press.
enum TouchKind {
  TE_NONE = 0,
  TE_DOWN,      // finger landed (used for row highlights)
  TE_TAP,
  TE_LONG,      // fires once, while still held
  TE_SWIPE_L,
  TE_SWIPE_R
};

struct TouchEvent {
  uint8_t kind = TE_NONE;
  int     x = 0, y = 0;   // for TAP/DOWN: where; for swipes: where the finger landed
};

static const uint32_t UI_LONG_PRESS_MS = 700;
static const int      UI_SWIPE_MIN_PX  = 40;  // horizontal travel that counts as a swipe
static const int      UI_TAP_SLOP_PX   = 18;  // movement still allowed for a tap/long press

struct TouchTracker {
  bool     down = false;
  bool     longFired = false;
  bool     moved = false;
  int      x0 = 0, y0 = 0, lastX = 0, lastY = 0;
  uint32_t downMs = 0;

  // Feed the raw touch state once per frame; returns at most one event.
  TouchEvent update(bool touched, int x, int y, uint32_t nowMs);
  // Drop any in-flight press so a screen change doesn't inherit the touch that caused it.
  void reset();
};

// Vertical thirds of the run screen: 0 = top (raise target), 1 = middle (menu), 2 = bottom.
int uiTapZone(int y);

// ====================================================================
// Toast — transient confirmation of an action
// ====================================================================
// Every control that changes something says so. Without this, nudging the target band or
// switching mode is a silent 5 Hz change you have to squint at the HUD to notice.
static const uint32_t UI_TOAST_MS = 1500;

struct Toast {
  char     msg[30] = {0};
  uint32_t untilMs = 0;
  bool     drawn = false;   // owned by the renderer: has this toast been painted yet?

  void show(const char *m, uint32_t nowMs, uint32_t durMs = UI_TOAST_MS);
  bool visible(uint32_t nowMs) const;
  void clear();
};

// ====================================================================
// Session scoreboard
// ====================================================================
struct SessionStats {
  float    totalSecs = 0.0f;
  float    voicedSecs = 0.0f;
  float    inTargetSecs = 0.0f;
  float    pitchSum = 0.0f;
  uint32_t pitchCount = 0;
  float    pitchMin = 0.0f;   // 0 until a voiced frame arrives
  float    pitchMax = 0.0f;
  uint32_t syllables = 0;
  float    prevImpulse = 0.0f;

  void reset();
  void update(const VoxResult &r, float dt, bool inTarget);

  int   onTargetPct() const;      // 0 until there is enough voiced audio to be meaningful
  float avgPitch() const;         // 0 if nothing voiced yet
  float syllablesPerMin() const;  // speech-rate proxy
};

// ====================================================================
// Signal probe — evidence for "is it tracking my voice, or is the display lying?"
// ====================================================================
// The analysis range and the drawable range are the same 80..300 Hz, so a voice above the
// top of it reads as a flat line pinned to the top of the plot rather than as an error. That
// is indistinguishable, by eye, from the pitch detector simply being wrong. This counts how
// often the pitch actually lands on the ends of the range, which tells the two apart.
struct SignalProbe {
  uint32_t frames = 0;
  uint32_t voicedFrames = 0;
  uint32_t atCeiling = 0;      // voiced frames at/above VOX_PITCH_MAX_HZ (undrawable)
  uint32_t atFloor = 0;        // voiced frames at/below VOX_PITCH_MIN_HZ
  float    peakHz = 0.0f;
  float    lowHz = 0.0f;       // 0 until a voiced frame arrives
  float    peakRms = 0.0f;

  void reset();
  // Call once per DSP analysis frame.
  void update(const VoxResult &r);
  int  ceilingPct() const;     // % of voiced time the plot cannot represent
  int  floorPct() const;
};

// ====================================================================
// Screens
// ====================================================================
enum UiScreen { SCR_RUN = 0, SCR_QUICK, SCR_STATS, SCR_SETTINGS, SCR_TUTORIAL, SCR_DIAG };

// Quick menu: six large targets, laid out 2 columns x 3 rows.
enum QuickAction { QA_MODE = 0, QA_RECAL, QA_RESET, QA_STATS, QA_SETTINGS, QA_CLOSE, QA_COUNT };
static const int UI_QUICK_COLS = 2;
static const int UI_QUICK_X0   = 8;
static const int UI_QUICK_Y0   = 34;
static const int UI_QUICK_W    = 108;
static const int UI_QUICK_H    = 56;
static const int UI_QUICK_GAP  = 8;

void uiQuickRect(int idx, int *x, int *y, int *w, int *h);
// Which quick-menu button contains (x, y), or -1 for none.
int  uiQuickHit(int x, int y);
const char *uiQuickLabel(int idx, const Settings &s);
const char *uiQuickCaption(int idx);   // small caption above the label

// Walkthrough cards. Each is a title plus up to three short lines.
struct TutorialCard { const char *title; const char *l1; const char *l2; const char *l3; };
extern const TutorialCard TUTORIAL[];
extern const int N_TUTORIAL;
