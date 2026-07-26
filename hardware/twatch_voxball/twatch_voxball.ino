/**
 * ProsodyBall — standalone voice trainer for the LilyGo T-Watch 2020 V3
 * --------------------------------------------------------------------
 * Self-contained: the watch captures its OWN voice from the V3's PDM microphone, runs
 * pitch + energy + brightness DSP on-device (dsp.cpp — a port of app.js / dsp-utils.js),
 * and visualises it locally on the 240x240 screen.
 *
 * Two visualisations:
 *   - VOX BALL : a ball whose height/colour follow pitch and that hops on each syllable,
 *                over a labelled pitch axis, with a scrolling trace of your recent pitch.
 *   - COLOR    : the whole screen colours from a chosen metric, blended between two
 *                user-picked colours (e.g. pitch low->Blue, high->Pink).
 *
 * Screens: RUN (either visualisation) / QUICK menu / STATS / SETTINGS / TUTORIAL.
 *
 * Controls (all taught by the first-run walkthrough, and re-openable from Settings):
 *   - Tap top / bottom  : move the pitch target band up / down (Ball view, band on)
 *   - Tap middle        : quick menu — recalibrate, reset, stats, settings
 *   - Long press        : straight to Settings
 *   - Swipe left/right  : switch between the Ball and Color views
 *
 * This file owns pixels and hardware only. The decisions behind the UI — the settings
 * model, which menu rows apply right now, what a touch meant, when a toast expires, the
 * session scoreboard — live in ui.h/ui.cpp, which is pure C++ and unit-tested on the host
 * (test/ui_host_test.cpp), exactly like dsp.cpp.
 *
 * Audio + DSP run on core 0; rendering/input on core 1 (Arduino loop), decoupled by a
 * 1-slot queue — the same producer/consumer shape as the orb sketch.
 *
 * Requires (Arduino IDE): "esp32" boards package + "TTGO TWatch Library" (Library Manager).
 */
// IMPORTANT — include order: <BLEDevice.h> MUST come before LilyGoWatch.h (pulled in by
// config.h). If the TTGO library is included first, the BLE 4.2 GAP types (esp_ble_adv_data_t,
// esp_ble_adv_params_t, ...) end up undefined and the ESP32 core's own BLE headers fail to
// compile ("esp_ble_adv_data_t does not name a type"). Pulling in BLEDevice.h first sets up the
// Bluedroid config correctly. Verified on esp32 core 2.0.14 + TTGO TWatch Library; do not reorder.
#include <BLEDevice.h>       // BLE client for the optional orb companion mode (include FIRST)
#include "config.h"          // selects LILYGO_WATCH_2020_V3 then includes <LilyGoWatch.h>
#include <driver/i2s.h>
#include <Preferences.h>
#include <string.h>
#include "dsp.h"
#include "ui.h"

// --- PDM microphone pins / port (from the library's TwatcV3Special/Microphone example) ---
#define MIC_DATA   2
#define MIC_CLOCK  0
#define MIC_PORT   I2S_NUM_0

TTGOClass *ttgo = nullptr;

// --- cross-core handoff ---
static QueueHandle_t gResultQueue;      // length 1, overwritten with the latest frame
static VoxDsp        gDsp;              // owned by the audio task (core 0)
static volatile bool gRecalRequest = false;

// --- UI state (the model lives in ui.h; these are this screen's instances of it) ---
static Settings     gCfg;
static Preferences  gPrefs;
static int          gPreset = 0;        // runtime only; the low/high colours are what persist
static SessionStats gStats;
static Toast        gToast;
static TouchTracker gTouch;
static UiScreen     gScreen = SCR_RUN;
static int          gPage = 0;          // settings page
static int          gTutPage = 0;
static bool         gTutFromSettings = false;
static uint32_t     gQuickIdleMs = 0;   // quick menu auto-closes when untouched
static uint32_t     gHintUntilMs = 0;   // "what do the taps do" overlay
static bool         gStatusForce = true;
static bool         gHudDirty = true;
// Which control is currently held down, so it can be un-highlighted however the finger
// leaves it — including the drag-away that produces no gesture at all.
static int          gPressedQuick = -1, gPressedRow = -1;

// ====================================================================
// Persistence (NVS)
// ====================================================================
static void loadSettings() {
  gPrefs.begin("voxball", true);
  gCfg.mode       = gPrefs.getUChar("mode", gCfg.mode);
  gCfg.colorSrc   = gPrefs.getUChar("src", gCfg.colorSrc);
  gCfg.loColor    = gPrefs.getUChar("lo", gCfg.loColor);
  gCfg.hiColor    = gPrefs.getUChar("hi", gCfg.hiColor);
  gCfg.effect     = gPrefs.getUChar("eff", gCfg.effect);
  gCfg.haptic     = gPrefs.getUChar("hap", gCfg.haptic);
  gCfg.hapticThr  = gPrefs.getUChar("hthr", gCfg.hapticThr);
  gCfg.screenBri  = gPrefs.getUChar("bri", gCfg.screenBri);
  gCfg.autoDim    = gPrefs.getUChar("adim", gCfg.autoDim);
  gCfg.showBand   = gPrefs.getUChar("band", gCfg.showBand);
  gCfg.showTrace  = gPrefs.getUChar("trc", gCfg.showTrace);
  gCfg.showHud    = gPrefs.getUChar("hud", gCfg.showHud);
  gCfg.orb        = gPrefs.getUChar("orb", gCfg.orb);
  gCfg.tutorial   = gPrefs.getUChar("tut", gCfg.tutorial);
  gCfg.targetLoHz = gPrefs.getUShort("tlo", gCfg.targetLoHz);
  gCfg.targetHiHz = gPrefs.getUShort("thi", gCfg.targetHiHz);
  gCfg.bestPct    = gPrefs.getUShort("best", gCfg.bestPct);
  gPrefs.end();
  uiSanitizeSettings(gCfg);
}

static void saveSettings() {
  gPrefs.begin("voxball", false);
  gPrefs.putUChar("mode", gCfg.mode);
  gPrefs.putUChar("src", gCfg.colorSrc);
  gPrefs.putUChar("lo", gCfg.loColor);
  gPrefs.putUChar("hi", gCfg.hiColor);
  gPrefs.putUChar("eff", gCfg.effect);
  gPrefs.putUChar("hap", gCfg.haptic);
  gPrefs.putUChar("hthr", gCfg.hapticThr);
  gPrefs.putUChar("bri", gCfg.screenBri);
  gPrefs.putUChar("adim", gCfg.autoDim);
  gPrefs.putUChar("band", gCfg.showBand);
  gPrefs.putUChar("trc", gCfg.showTrace);
  gPrefs.putUChar("hud", gCfg.showHud);
  gPrefs.putUChar("orb", gCfg.orb);
  gPrefs.putUChar("tut", gCfg.tutorial);
  gPrefs.putUShort("tlo", gCfg.targetLoHz);
  gPrefs.putUShort("thi", gCfg.targetHiHz);
  gPrefs.putUShort("best", gCfg.bestPct);
  gPrefs.end();
}

// ====================================================================
// Audio capture + DSP — runs on core 0
// ====================================================================
static bool initMic() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM),
    .sample_rate = VOX_SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 256,
  };
  i2s_pin_config_t pin_cfg;
  pin_cfg.bck_io_num   = I2S_PIN_NO_CHANGE;
  pin_cfg.ws_io_num    = MIC_CLOCK;
  pin_cfg.data_out_num = I2S_PIN_NO_CHANGE;
  pin_cfg.data_in_num  = MIC_DATA;

  if (i2s_driver_install(MIC_PORT, &i2s_config, 0, NULL) != ESP_OK) return false;
  if (i2s_set_pin(MIC_PORT, &pin_cfg) != ESP_OK) return false;
  if (i2s_set_clk(MIC_PORT, VOX_SAMPLE_RATE, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_MONO) != ESP_OK)
    return false;
  return true;
}

static void audioTask(void *) {
  static int16_t raw[VOX_FRAME_SAMPLES];
  static float   frame[VOX_FRAME_SAMPLES];
  const float dt = (float)VOX_FRAME_SAMPLES / (float)VOX_SAMPLE_RATE; // ~64 ms

  for (;;) {
    if (gRecalRequest) { gDsp.recalibrate(); gRecalRequest = false; }

    size_t bytesRead = 0;
    esp_err_t err = i2s_read(MIC_PORT, (char *)raw, sizeof(raw), &bytesRead, portMAX_DELAY);
    if (err != ESP_OK || bytesRead != sizeof(raw)) {  // keep the fixed DSP frame contract
      vTaskDelay(pdMS_TO_TICKS(1));
      continue;
    }
    for (int i = 0; i < VOX_FRAME_SAMPLES; i++) frame[i] = raw[i] / 32768.0f; // int16 -> [-1,1)

    VoxResult res = gDsp.process(frame, VOX_FRAME_SAMPLES, dt);
    xQueueOverwrite(gResultQueue, &res);  // keep only the freshest frame
  }
}

// ====================================================================
// Palette / theme
// ====================================================================
// The same packing TFT_eSPI::color565 does. A macro rather than a function so the theme can
// be file-scope constants (and so the Arduino prototype generator has nothing to trip over).
#define RGB565(r, g, b) ((uint16_t)(((( r) & 0xF8) << 8) | ((( g) & 0xFC) << 3) | (( b) >> 3)))

static const uint16_t C_BG     = 0x0000;
static const uint16_t C_TEXT   = RGB565(232, 236, 244);
static const uint16_t C_MUTED  = RGB565(130, 142, 160);
static const uint16_t C_DIM    = RGB565(68, 76, 92);
static const uint16_t C_ACCENT = RGB565(90, 190, 255);
static const uint16_t C_OK     = RGB565(60, 220, 130);
static const uint16_t C_WARN   = RGB565(255, 130, 90);
static const uint16_t C_PANEL  = RGB565(24, 28, 38);
static const uint16_t C_PANEL2 = RGB565(46, 54, 70);

static uint16_t rgb565(const Rgb &c) { return RGB565(c.r, c.g, c.b); }

// Backlight level for each Brightness setting.
static uint8_t brightnessLevel() {
  switch (gCfg.screenBri) {
    case BRI_LOW: return 60;
    case BRI_MED: return 150;
    default:      return 255;
  }
}

// ====================================================================
// Small drawing helpers
// ====================================================================
// A labelled panel button, optionally with a small caption above the label. Every tappable
// thing outside the run screen is one of these, so targets are consistently finger-sized.
static void drawButton(int x, int y, int w, int h, const char *label, const char *caption,
                       uint16_t fill, uint16_t fg, uint16_t border) {
  TFT_eSPI *tft = ttgo->tft;
  tft->fillRoundRect(x, y, w, h, 8, fill);
  tft->drawRoundRect(x, y, w, h, 8, border);
  tft->setTextDatum(MC_DATUM);
  if (caption && caption[0]) {
    tft->setTextColor(C_MUTED, fill);
    tft->drawString(caption, x + w / 2, y + 15, 1);
    tft->setTextColor(fg, fill);
    tft->drawString(label, x + w / 2, y + h / 2 + 9, 2);
  } else {
    tft->setTextColor(fg, fill);
    tft->drawString(label, x + w / 2, y + h / 2, 2);
  }
}

static void drawDashedHLine(int y, uint16_t color) {
  TFT_eSPI *tft = ttgo->tft;
  for (int x = UI_TRACE_X0; x < UI_SCR_W - 6; x += 12) tft->drawFastHLine(x, y, 7, color);
}

// "1m 24s" / "48s" — session durations read better than a raw seconds count.
static void formatDuration(float secs, char *out, size_t n) {
  int s = (int)(secs + 0.5f);
  if (s >= 60) snprintf(out, n, "%dm %02ds", s / 60, s % 60);
  else         snprintf(out, n, "%ds", s);
}

// ====================================================================
// Status bar — clock, view, mic level, battery, orb link
// ====================================================================
// The single biggest "is this thing even on?" fix: a permanent strip that shows the watch is
// a watch (time, battery) and that the microphone is hearing you (the level line).
// Declared up here because the status bar shows the orb link dot; the BLE task that owns it
// is further down.
static volatile bool gOrbConnected = false;

static void drawStatusBar(bool force) {
  TFT_eSPI *tft = ttgo->tft;
  uint32_t now = millis();

  // The RTC and PMU sit behind I2C; poll them at 1 Hz rather than every frame.
  static uint32_t lastPollMs = 0;
  static char clockBuf[8] = "--:--";
  static int  batt = -1;
  static bool charging = false;
  if (force || now - lastPollMs > 1000) {
    lastPollMs = now;
    RTC_Date d = ttgo->rtc->getDateTime();
    snprintf(clockBuf, sizeof(clockBuf), "%02d:%02d", (int)d.hour, (int)d.minute);
    int p = ttgo->power->getBattPercentage();
    batt = (p >= 0 && p <= 100) ? p : -1;
    charging = ttgo->power->isChargeing();
  }

  const bool cal  = gDsp.calibrating();
  const bool link = gOrbConnected;
  static char lastClock[8] = "";
  static int  lastBatt = -999;
  static bool lastCharging = false, lastCal = false, lastLink = false;
  static uint8_t lastMode = 255, lastOrb = 255;

  if (!force && strcmp(clockBuf, lastClock) == 0 && batt == lastBatt &&
      charging == lastCharging && cal == lastCal && link == lastLink &&
      gCfg.mode == lastMode && gCfg.orb == lastOrb)
    return;

  strncpy(lastClock, clockBuf, sizeof(lastClock) - 1);
  lastClock[sizeof(lastClock) - 1] = '\0';
  lastBatt = batt; lastCharging = charging; lastCal = cal; lastLink = link;
  lastMode = gCfg.mode; lastOrb = gCfg.orb;

  tft->fillRect(0, 0, UI_SCR_W, UI_STATUS_H - 2, C_BG);

  tft->setTextDatum(ML_DATUM);
  tft->setTextColor(C_MUTED, C_BG);
  tft->drawString(clockBuf, 6, 12, 2);

  tft->setTextDatum(MC_DATUM);
  if (cal) {
    tft->setTextColor(C_WARN, C_BG);
    tft->drawString("CALIBRATING", UI_SCR_W / 2, 12, 2);
  } else {
    tft->setTextColor(C_ACCENT, C_BG);
    tft->drawString(MODE_NAMES[gCfg.mode % 2], UI_SCR_W / 2, 12, 2);
  }

  if (gCfg.orb) tft->fillCircle(188, 12, 4, link ? C_OK : C_DIM);

  char b[12];
  if (batt >= 0) snprintf(b, sizeof(b), "%d%%", batt);
  else           snprintf(b, sizeof(b), "--");
  tft->setTextDatum(MR_DATUM);
  tft->setTextColor(charging ? C_OK : ((batt >= 0 && batt < 20) ? C_WARN : C_MUTED), C_BG);
  tft->drawString(b, UI_SCR_W - 6, 12, 2);
}

// A 2 px live input meter along the bottom of the status bar. Cheap enough to redraw every
// frame, and it answers "is the mic working?" without any text.
static void drawMicLevel(const VoxResult &res) {
  TFT_eSPI *tft = ttgo->tft;
  int w = (int)(uiLoudness(res) * UI_SCR_W);
  if (w < 0) w = 0;
  if (w > UI_SCR_W) w = UI_SCR_W;
  if (w > 0)         tft->fillRect(0, UI_STATUS_H - 2, w, 2, res.voiced ? C_ACCENT : C_MUTED);
  if (w < UI_SCR_W)  tft->fillRect(w, UI_STATUS_H - 2, UI_SCR_W - w, 2, C_PANEL);
}

// ====================================================================
// VOX BALL visualisation
// ====================================================================
static float ballPos = 0.5f, ballVel = 0.0f;
static float bounceY = 0.0f, bounceVel = 0.0f;
static float prevImpulse = 0.0f;
static float smoothHue = 270.0f, smoothR = 18.0f;
static int   prevX = -1, prevY = -1, prevR = 0;
static int   prevBandLo = -1, prevBandHi = -1;

// gTracePrev is last frame's trace, kept so it can be erased stroke-for-stroke instead of
// clearing (and repainting) the whole plot area every frame.
static PitchTrace gTrace, gTracePrev;

static void drawTrace(const PitchTrace &tr, bool erase) {
  TFT_eSPI *tft = ttgo->tft;
  for (int i = 1; i < tr.len; i++) {
    if (!tr.pts[i - 1].voiced || !tr.pts[i].voiced) continue;   // gaps stay gaps
    uint16_t c = erase ? C_BG : (tr.pts[i].inBand ? C_OK : C_ACCENT);
    tft->drawLine(PitchTrace::xAt(i - 1), tr.pts[i - 1].y,
                  PitchTrace::xAt(i), tr.pts[i].y, c);
  }
}

// Hz tick marks down the left gutter, so the ball's height means something concrete.
static void drawPitchAxis() {
  TFT_eSPI *tft = ttgo->tft;
  tft->fillRect(0, UI_PLOT_TOP - 8, UI_AXIS_W, UI_PLOT_H + 16, C_BG);
  tft->setTextDatum(TL_DATUM);
  tft->setTextColor(C_DIM, C_BG);
  for (int hz = 100; hz <= (int)VOX_PITCH_MAX_HZ; hz += 50) {
    int y = uiHzToY((float)hz);
    tft->drawFastHLine(UI_AXIS_W - 6, y, 5, C_DIM);
    char l[6];
    snprintf(l, sizeof(l), "%d", hz);
    tft->drawString(l, 2, y - 4, 1);
  }
}

static void updateBallPhysics(const VoxResult &res, float dt) {
  dt = uiClamp(dt, 0.0f, 0.05f);
  float target = res.voiced ? res.pitchPos : 0.5f;
  const float K = 14.0f, DAMP = 7.0f;
  ballVel += (target - ballPos) * K * dt;
  ballVel -= ballVel * DAMP * dt;
  ballPos = uiClamp(ballPos + ballVel * dt, 0.0f, 1.0f);

  if (res.syllableImpulse > 0.6f && prevImpulse <= 0.6f)
    bounceVel += 1.6f * (0.35f + 0.65f * res.bounce);
  prevImpulse = res.syllableImpulse;
  bounceVel -= 6.0f * dt;
  bounceY += bounceVel * dt;
  if (bounceY < 0.0f) { bounceY = 0.0f; bounceVel = 0.0f; }
  if (bounceY > 0.45f) bounceY = 0.45f;

  float hueTarget = res.voiced ? (210.0f + uiClamp(res.pitchPos, 0, 1) * 130.0f) : 270.0f;
  smoothHue += (hueTarget - smoothHue) * 0.25f;
  float rTarget = 14.0f + 24.0f * uiLoudness(res);
  smoothR += (rTarget - smoothR) * 0.3f;
}

static void renderBall(const VoxResult &res, bool inTarget) {
  TFT_eSPI *tft = ttgo->tft;
  const bool band = gCfg.showBand;
  const bool glow = band && inTarget;

  float renderPos = uiClamp(ballPos + bounceY, 0.0f, 1.0f);
  int x = UI_BALL_X;
  int y = UI_PLOT_TOP + (int)((1.0f - renderPos) * UI_PLOT_H);
  int r = (int)smoothR;

  // 1. lift the previous ball and trace off the plot ...
  if (prevX >= 0) tft->fillCircle(prevX, prevY, prevR + 4, C_BG);
  if (gTracePrev.len > 0) drawTrace(gTracePrev, true);

  // 2. ... then repaint the chrome they may have punched through.
  if (band) {
    int yLo = uiHzToY((float)gCfg.targetLoHz), yHi = uiHzToY((float)gCfg.targetHiHz);
    if (prevBandLo >= 0 && (prevBandLo != yLo || prevBandHi != yHi)) {
      tft->fillRect(UI_TRACE_X0, prevBandLo, UI_SCR_W - UI_TRACE_X0, 1, C_BG);
      tft->fillRect(UI_TRACE_X0, prevBandHi, UI_SCR_W - UI_TRACE_X0, 1, C_BG);
    }
    prevBandLo = yLo; prevBandHi = yHi;
    uint16_t bc = inTarget ? C_OK : C_DIM;
    drawDashedHLine(yHi, bc);
    drawDashedHLine(yLo, bc);
  } else if (prevBandLo >= 0) {                  // band just turned off — clear its leftovers
    tft->fillRect(UI_TRACE_X0, prevBandLo, UI_SCR_W - UI_TRACE_X0, 1, C_BG);
    tft->fillRect(UI_TRACE_X0, prevBandHi, UI_SCR_W - UI_TRACE_X0, 1, C_BG);
    prevBandLo = prevBandHi = -1;
  }

  // 3. trace, then the ball on top of it.
  if (gCfg.showTrace) {
    drawTrace(gTrace, false);
    gTracePrev = gTrace;
  } else {
    gTracePrev.clear();
  }

  float base = res.voiced ? (0.45f + 0.55f * uiClamp(res.confidence, 0, 1)) : 0.22f;
  uint16_t color = rgb565(uiHsv(smoothHue, 0.9f, glow ? uiClamp(base + 0.25f, 0, 1) : base));
  tft->fillCircle(x, y, r, color);
  if (glow) tft->drawCircle(x, y, r + 3, C_OK);
  prevX = x; prevY = y; prevR = r;
}

// ====================================================================
// Ball-mode HUD: on-target bar + readout, refreshed only when the text actually changes
// ====================================================================
static char gLastBig[16] = "", gLastSmall[40] = "";
static bool gLastGlow = false;
static int  gLastBarPct = -1;

static void invalidateHud() {
  gLastBig[0] = '\0'; gLastSmall[0] = '\0'; gLastBarPct = -1; gHudDirty = false;
}

static void drawOnTargetBar(int pct) {
  if (pct == gLastBarPct) return;
  gLastBarPct = pct;
  TFT_eSPI *tft = ttgo->tft;
  int w = (pct * UI_SCR_W) / 100;
  if (w > 0)        tft->fillRect(0, UI_BAR_Y, w, UI_BAR_H, C_OK);
  if (w < UI_SCR_W) tft->fillRect(w, UI_BAR_Y, UI_SCR_W - w, UI_BAR_H, C_PANEL);
}

static void drawBallHud(const VoxResult &res, bool inTarget, uint32_t now) {
  static uint32_t lastMs = 0;
  if (gHudDirty) invalidateHud();
  if (now - lastMs < 100) return;               // the pitch number is unreadable faster than this
  lastMs = now;
  TFT_eSPI *tft = ttgo->tft;

  if (gCfg.showBand) drawOnTargetBar(gStats.onTargetPct());
  else if (gLastBarPct != -2) { tft->fillRect(0, UI_BAR_Y, UI_SCR_W, UI_BAR_H, C_BG); gLastBarPct = -2; }

  char big[16], small[40];
  if (gDsp.calibrating()) {
    snprintf(big, sizeof(big), "...");
    snprintf(small, sizeof(small), "Calibrating - stay quiet");
  } else {
    if (res.voiced) snprintf(big, sizeof(big), "%d Hz", (int)(res.pitchHz + 0.5f));
    else            snprintf(big, sizeof(big), "--");
    if (gCfg.showBand)
      snprintf(small, sizeof(small), "%d-%d Hz   on %d%%   best %d%%",
               gCfg.targetLoHz, gCfg.targetHiHz, gStats.onTargetPct(), gCfg.bestPct);
    else
      snprintf(small, sizeof(small), "tap: menu    hold: settings");
  }

  if (strcmp(big, gLastBig) != 0 || inTarget != gLastGlow) {
    strncpy(gLastBig, big, sizeof(gLastBig) - 1); gLastBig[sizeof(gLastBig) - 1] = '\0';
    gLastGlow = inTarget;
    tft->fillRect(0, UI_HUD_Y, UI_SCR_W, 26, C_BG);
    tft->setTextDatum(MC_DATUM);
    tft->setTextColor(inTarget ? C_OK : C_TEXT, C_BG);
    tft->drawString(big, UI_SCR_W / 2, UI_HUD_Y + 12, 4);
  }
  if (strcmp(small, gLastSmall) != 0) {
    strncpy(gLastSmall, small, sizeof(gLastSmall) - 1); gLastSmall[sizeof(gLastSmall) - 1] = '\0';
    tft->fillRect(0, UI_HUD_Y + 26, UI_SCR_W, UI_SCR_H - UI_HUD_Y - 26, C_BG);
    tft->setTextDatum(MC_DATUM);
    tft->setTextColor(C_MUTED, C_BG);
    tft->drawString(small, UI_SCR_W / 2, UI_SCR_H - 8, 2);
  }
}

// ====================================================================
// COLOR visualisation — the body of the screen coloured from the chosen metric
// ====================================================================
static void renderColor(const VoxResult &res, uint32_t now) {
  TFT_eSPI *tft = ttgo->tft;
  const int lo = gCfg.loColor, hi = gCfg.hiColor;
  const float t = uiMetricValue(res, gCfg.colorSrc);
  const float loud = uiLoudness(res);

  // The status bar and HUD keep their own strips so they don't have to be repainted under
  // every frame of colour; with the HUD off the colour takes the whole screen — except while
  // a toast is up, or the fill would paint straight over it.
  const int bodyY = gCfg.showHud ? UI_STATUS_H : 0;
  int bodyBottom = (gCfg.showHud || gToast.visible(now)) ? UI_HUD_Y : UI_SCR_H;
  const int bodyH = bodyBottom - bodyY;

  switch (gCfg.effect) {
    case EFF_PULSE: {
      // Whole-body brightness pulse; faster/deeper with loudness, flash on each syllable.
      static float phase = 0.0f;
      phase += 0.12f + 0.55f * loud;
      float s = 0.5f + 0.5f * sinf(phase);
      float v = (res.voiced ? 0.30f : 0.12f) * (0.55f + 0.45f * s) + 0.45f * res.syllableImpulse;
      tft->fillRect(0, bodyY, UI_SCR_W, bodyH, rgb565(uiBlendPal(lo, hi, t, uiClamp(v, 0, 1))));
      break;
    }
    case EFF_GRADIENT: {
      // Vertical lo(bottom) -> hi(top) gradient, brightness from loudness; a white marker
      // line shows where the chosen metric currently sits.
      float v = res.voiced ? (0.30f + 0.70f * loud) : 0.15f;
      const int bands = 30, bandH = (bodyH + bands - 1) / bands;
      for (int b = 0; b < bands; b++) {
        int y = bodyY + b * bandH;
        int h = bandH;
        if (y >= bodyY + bodyH) break;
        if (y + h > bodyY + bodyH) h = bodyY + bodyH - y;
        float frac = 1.0f - (float)b / (bands - 1);      // top = hi
        tft->fillRect(0, y, UI_SCR_W, h, rgb565(uiBlendPal(lo, hi, frac, v)));
      }
      int my = bodyY + (int)((1.0f - uiClamp(t, 0, 1)) * bodyH);
      tft->drawFastHLine(0, my, UI_SCR_W, TFT_WHITE);
      break;
    }
    case EFF_METER: {
      // Bottom-up level bar: fill height = chosen metric, in the high colour over a dim base.
      float v = res.voiced ? (0.40f + 0.60f * loud) : 0.20f;
      int fill = (int)(uiClamp(t, 0, 1) * bodyH);
      tft->fillRect(0, bodyY, UI_SCR_W, bodyH - fill, rgb565(uiBlendPal(lo, hi, 0.0f, 0.15f)));
      tft->fillRect(0, bodyY + bodyH - fill, UI_SCR_W, fill, rgb565(uiBlendPal(lo, hi, 1.0f, v)));
      break;
    }
    default: {  // EFF_NONE
      float v = res.voiced ? (0.25f + 0.75f * loud) : 0.12f;
      tft->fillRect(0, bodyY, UI_SCR_W, bodyH, rgb565(uiBlendPal(lo, hi, t, v)));
      break;
    }
  }

  // The toast owns the HUD strip while it is up, so leave the strip alone until it clears.
  if (!gCfg.showHud || gToast.visible(now)) return;

  // HUD strip: which metric is driving the colour, its current value, and a bar for it —
  // "Color" mode is otherwise impossible to read a number off.
  static uint32_t lastMs = 0;
  if (gHudDirty) { invalidateHud(); }
  if (now - lastMs < 100) return;
  lastMs = now;

  char small[40];
  if (gDsp.calibrating()) snprintf(small, sizeof(small), "Calibrating - stay quiet");
  else snprintf(small, sizeof(small), "%s   %d%%", SRC_NAMES[gCfg.colorSrc % SRC_COUNT],
                (int)(uiClamp(t, 0, 1) * 100 + 0.5f));
  if (strcmp(small, gLastSmall) != 0) {
    strncpy(gLastSmall, small, sizeof(gLastSmall) - 1); gLastSmall[sizeof(gLastSmall) - 1] = '\0';
    tft->fillRect(0, UI_HUD_Y, UI_SCR_W, UI_SCR_H - UI_HUD_Y, C_BG);
    tft->setTextDatum(MC_DATUM);
    tft->setTextColor(C_TEXT, C_BG);
    tft->drawString(small, UI_SCR_W / 2, UI_HUD_Y + 14, 2);
  }
  int w = (int)(uiClamp(t, 0, 1) * UI_SCR_W);
  tft->fillRect(0, UI_SCR_H - 6, w, 4, rgb565(uiBlendPal(lo, hi, t, 1.0f)));
  tft->fillRect(w, UI_SCR_H - 6, UI_SCR_W - w, 4, C_PANEL);
}

// ====================================================================
// Toast — transient confirmation, drawn over the HUD strip
// ====================================================================
// It lives in the HUD strip on purpose: that is the one band of the screen no visualisation
// paints into, so a toast never gets chewed up by the next frame of the ball or the colour.
static const int TOAST_X = 4, TOAST_W = UI_SCR_W - 8;
static const int TOAST_Y = UI_HUD_Y, TOAST_H = UI_SCR_H - UI_HUD_Y;

static void drawToast(uint32_t now) {
  static bool wasVisible = false;
  TFT_eSPI *tft = ttgo->tft;
  bool vis = gToast.visible(now);
  if (vis) {
    if (!gToast.drawn) {
      tft->fillRoundRect(TOAST_X, TOAST_Y, TOAST_W, TOAST_H, 8, C_PANEL2);
      tft->drawRoundRect(TOAST_X, TOAST_Y, TOAST_W, TOAST_H, 8, C_ACCENT);
      tft->setTextDatum(MC_DATUM);
      tft->setTextColor(C_TEXT, C_PANEL2);
      tft->drawString(gToast.msg, UI_SCR_W / 2, TOAST_Y + TOAST_H / 2, 2);
      gToast.drawn = true;
    }
  } else if (wasVisible) {
    tft->fillRect(TOAST_X, TOAST_Y, TOAST_W, TOAST_H, C_BG);
    gToast.clear();
    gHudDirty = true;                  // make the readout repaint itself
  }
  wasVisible = vis;
}

// ====================================================================
// Tap hints — a short-lived overlay so the touch zones are never a secret
// ====================================================================
static void drawTapHints(bool show) {
  TFT_eSPI *tft = ttgo->tft;
  const int yTop = UI_PLOT_TOP + 8, yBot = UI_PLOT_BOT - 8;
  if (!show) {
    tft->fillRect(UI_AXIS_W, yTop - 9, UI_SCR_W - UI_AXIS_W, 18, C_BG);
    tft->fillRect(UI_AXIS_W, yBot - 9, UI_SCR_W - UI_AXIS_W, 18, C_BG);
    // The wipe may have taken part of a band line with it; there is now no old position
    // worth erasing, and the dashed lines are repainted from scratch on the next frame.
    prevBandLo = prevBandHi = -1;
    return;
  }
  tft->setTextDatum(MC_DATUM);
  tft->setTextColor(C_DIM, C_BG);
  const bool nudge = (gCfg.mode == MODE_BALL) && gCfg.showBand;
  tft->drawString(nudge ? "tap: target +5" : "tap: menu", UI_SCR_W / 2 + 12, yTop, 2);
  tft->drawString(nudge ? "tap: target -5" : "hold: settings", UI_SCR_W / 2 + 12, yBot, 2);
}

// ====================================================================
// QUICK MENU — the middle tap. Six finger-sized buttons, all self-describing.
// ====================================================================
static void drawQuickButton(int i, bool pressed) {
  int x, y, w, h;
  uiQuickRect(i, &x, &y, &w, &h);
  bool close = (i == QA_CLOSE);
  drawButton(x, y, w, h, uiQuickLabel(i, gCfg), uiQuickCaption(i),
             pressed ? C_PANEL2 : C_PANEL, close ? C_MUTED : C_TEXT, close ? C_DIM : C_ACCENT);
}

static void drawQuickMenu() {
  TFT_eSPI *tft = ttgo->tft;
  tft->fillScreen(C_BG);
  tft->setTextDatum(MC_DATUM);
  tft->setTextColor(C_ACCENT, C_BG);
  tft->drawString("Quick menu", UI_SCR_W / 2, 16, 2);
  for (int i = 0; i < QA_COUNT; i++) drawQuickButton(i, false);
}

// ====================================================================
// STATS — what the session actually looked like
// ====================================================================
static void drawStatsRow(int y, const char *label, const char *value) {
  TFT_eSPI *tft = ttgo->tft;
  tft->setTextDatum(ML_DATUM);
  tft->setTextColor(C_MUTED, C_BG);
  tft->drawString(label, 14, y, 2);
  tft->setTextDatum(MR_DATUM);
  tft->setTextColor(C_TEXT, C_BG);
  tft->drawString(value, UI_SCR_W - 14, y, 2);
}

static void drawStats() {
  TFT_eSPI *tft = ttgo->tft;
  tft->fillScreen(C_BG);
  tft->setTextDatum(MC_DATUM);
  tft->setTextColor(C_ACCENT, C_BG);
  tft->drawString("Session", UI_SCR_W / 2, 14, 2);

  char buf[24];
  const int pct = gStats.onTargetPct();
  snprintf(buf, sizeof(buf), "%d%%", pct);
  tft->setTextColor(pct >= 50 ? C_OK : C_TEXT, C_BG);
  tft->drawString(buf, UI_SCR_W / 2, 48, 4);
  tft->setTextColor(C_MUTED, C_BG);
  tft->drawString("of voiced time on target", UI_SCR_W / 2, 72, 1);

  snprintf(buf, sizeof(buf), "%d%%", gCfg.bestPct);
  drawStatsRow(96, "Best ever", buf);

  if (gStats.avgPitch() > 0) snprintf(buf, sizeof(buf), "%d Hz", (int)(gStats.avgPitch() + 0.5f));
  else                       snprintf(buf, sizeof(buf), "--");
  drawStatsRow(118, "Average pitch", buf);

  if (gStats.pitchMax > 0) snprintf(buf, sizeof(buf), "%d-%d Hz", (int)gStats.pitchMin, (int)gStats.pitchMax);
  else                     snprintf(buf, sizeof(buf), "--");
  drawStatsRow(140, "Range", buf);

  formatDuration(gStats.voicedSecs, buf, sizeof(buf));
  drawStatsRow(162, "Voiced time", buf);

  snprintf(buf, sizeof(buf), "%d/min", (int)(gStats.syllablesPerMin() + 0.5f));
  drawStatsRow(184, "Syllables", buf);

  drawButton(8, 204, 108, 30, "Reset", nullptr, C_PANEL, C_WARN, C_DIM);
  drawButton(124, 204, 108, 30, "Back", nullptr, C_PANEL, C_TEXT, C_ACCENT);
}

// ====================================================================
// TUTORIAL — shown once on first boot, and any time from Settings > How to use
// ====================================================================
static void drawTutorial() {
  TFT_eSPI *tft = ttgo->tft;
  const TutorialCard &c = TUTORIAL[gTutPage];
  tft->fillScreen(C_BG);
  tft->setTextDatum(MC_DATUM);

  tft->setTextColor(C_ACCENT, C_BG);
  tft->drawString(c.title, UI_SCR_W / 2, 46, 4);
  tft->setTextColor(C_TEXT, C_BG);
  tft->drawString(c.l1, UI_SCR_W / 2, 96, 2);
  tft->drawString(c.l2, UI_SCR_W / 2, 120, 2);
  tft->drawString(c.l3, UI_SCR_W / 2, 144, 2);

  for (int i = 0; i < N_TUTORIAL; i++)
    tft->fillCircle(UI_SCR_W / 2 - (N_TUTORIAL - 1) * 7 + i * 14, 178, 4,
                    i == gTutPage ? C_ACCENT : C_DIM);

  const bool last = (gTutPage == N_TUTORIAL - 1);
  drawButton(8, 204, 100, 30, gTutPage == 0 ? "Skip" : "Back", nullptr, C_PANEL, C_MUTED, C_DIM);
  drawButton(132, 204, 100, 30, last ? "Start" : "Next", nullptr, C_PANEL, C_TEXT, C_ACCENT);
}

// ====================================================================
// SETTINGS — context-filtered rows, auto-paginated
// ====================================================================
static const int SET_ROW_Y0 = 30, SET_ROW_H = 28, SET_FOOTER_Y = 202;

static void drawSettingsRow(int slot, uint8_t id, bool pressed) {
  TFT_eSPI *tft = ttgo->tft;
  const int y = SET_ROW_Y0 + slot * SET_ROW_H;
  const uint16_t bg = pressed ? C_PANEL2 : C_BG;
  tft->fillRect(0, y, UI_SCR_W, SET_ROW_H - 1, bg);

  char label[20], value[20];
  uiItemLabel(id, label, sizeof(label));
  uiItemValue(gCfg, gPreset, id, value, sizeof(value));

  tft->setTextDatum(ML_DATUM);
  tft->setTextColor(C_MUTED, bg);
  tft->drawString(label, 10, y + 13, 2);

  int valueRight = 222;
  if (uiItemHasSwatch(id)) {
    valueRight = 194;
    // The preset row previews both ends of its gradient; the single-colour rows show one.
    int loIdx = gCfg.loColor, hiIdx = gCfg.hiColor;
    if (id == IT_LO) hiIdx = loIdx;
    if (id == IT_HI) loIdx = hiIdx;
    tft->fillRect(200, y + 6, 11, 14, RGB565(PALETTE[loIdx].r, PALETTE[loIdx].g, PALETTE[loIdx].b));
    tft->fillRect(211, y + 6, 11, 14, RGB565(PALETTE[hiIdx].r, PALETTE[hiIdx].g, PALETTE[hiIdx].b));
  }
  tft->setTextDatum(MR_DATUM);
  tft->setTextColor(id == IT_HELP ? C_ACCENT : C_TEXT, bg);
  tft->drawString(value, valueRight, y + 13, 2);

  // A chevron on every row: the one cue that says "this is tappable, and it cycles".
  tft->fillTriangle(229, y + 8, 236, y + 13, 229, y + 19, C_DIM);
  tft->drawFastHLine(0, y + SET_ROW_H - 1, UI_SCR_W, C_PANEL);
}

static void drawSettings() {
  TFT_eSPI *tft = ttgo->tft;
  const int pages = uiPageCount(gCfg);
  if (gPage >= pages) gPage = pages > 0 ? pages - 1 : 0;
  if (gPage < 0) gPage = 0;

  tft->fillScreen(C_BG);
  tft->setTextDatum(ML_DATUM);
  tft->setTextColor(C_ACCENT, C_BG);
  tft->drawString("Settings", 10, 14, 2);
  tft->setTextDatum(MR_DATUM);
  tft->setTextColor(C_DIM, C_BG);
  tft->drawString("tap a row to change", UI_SCR_W - 10, 15, 1);

  uint8_t items[UI_ROWS_PER_PAGE];
  int n = uiPageItems(gCfg, gPage, items, UI_ROWS_PER_PAGE);
  for (int i = 0; i < n; i++) drawSettingsRow(i, items[i], false);

  const bool multi = pages > 1;
  drawButton(8, SET_FOOTER_Y, 44, 30, "<", nullptr, C_PANEL, multi ? C_TEXT : C_DIM,
             multi ? C_ACCENT : C_PANEL);
  drawButton(58, SET_FOOTER_Y, 44, 30, ">", nullptr, C_PANEL, multi ? C_TEXT : C_DIM,
             multi ? C_ACCENT : C_PANEL);
  char p[12];
  snprintf(p, sizeof(p), "%d/%d", gPage + 1, pages);
  tft->setTextDatum(MC_DATUM);
  tft->setTextColor(C_MUTED, C_BG);
  tft->drawString(p, 126, SET_FOOTER_Y + 15, 2);
  drawButton(150, SET_FOOTER_Y, 82, 30, "Done", nullptr, C_PANEL, C_OK, C_OK);
}

// ====================================================================
// Haptics — configurable trigger, evaluated each frame (rising edge)
// ====================================================================
static bool evalHaptic(const VoxResult &res, bool inTarget) {
  static bool pInTarget = false, pSyl = false, pBright = false, pLoud = false;
  float thr = gCfg.hapticThr / 100.0f;
  bool buzz = false;
  switch (gCfg.haptic) {
    case HAP_ONTARGET: buzz = inTarget && !pInTarget; break;
    case HAP_SYLLABLE: { bool on = res.syllableImpulse > 0.6f; buzz = on && !pSyl; pSyl = on; } break;
    case HAP_BRIGHT:   { bool on = res.brightness > thr;       buzz = on && !pBright; pBright = on; } break;
    case HAP_LOUD:     { bool on = uiLoudness(res) > thr;      buzz = on && !pLoud; pLoud = on; } break;
    default: break; // HAP_OFF
  }
  pInTarget = inTarget;
  return buzz;
}

// A short click for UI actions — distinct from the longer training buzz.
static void uiTick() { ttgo->motor->onec(20); }

// ====================================================================
// BLE companion — the watch acts as a CLIENT and drives the LED orb
// (hardware/prosodyball_orb). Protocol must match prosodyball_orb.ino:
// service 5b1e0001-..., characteristic 5b1e0002-..., 5-byte [R,G,B,Res,Weight].
// ====================================================================
static BLEUUID ORB_SVC_UUID("5b1e0001-8a0e-4f1b-9c5a-2f3d4e5a6b7c");
static BLEUUID ORB_CHR_UUID("5b1e0002-8a0e-4f1b-9c5a-2f3d4e5a6b7c");

// Packet bytes recomputed each frame on core 1; read by the BLE task. Byte reads/writes are
// atomic on the ESP32, so an occasional torn frame just means one stale LED colour — harmless.
static volatile uint8_t gOrbR = 0, gOrbG = 0, gOrbB = 0, gOrbRes = 0, gOrbWgt = 128;

static BLEClient *gClient = nullptr;
static BLERemoteCharacteristic *gOrbChr = nullptr;
static BLEAdvertisedDevice *gFound = nullptr;
static volatile bool gFoundFlag = false;

class OrbScanCB : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice dev) override {
    if (dev.haveServiceUUID() && dev.isAdvertisingService(ORB_SVC_UUID)) {
      if (gFound) delete gFound;
      gFound = new BLEAdvertisedDevice(dev);
      gFoundFlag = true;
      BLEDevice::getScan()->stop();
    }
  }
};
class OrbClientCB : public BLEClientCallbacks {
  void onConnect(BLEClient *) override {}
  void onDisconnect(BLEClient *) override { gOrbConnected = false; }
};

static bool orbConnect() {
  if (!gFound) return false;
  if (!gClient) {
    gClient = BLEDevice::createClient();
    gClient->setClientCallbacks(new OrbClientCB());
  }
  if (!gClient->connect(gFound)) return false;
  BLERemoteService *svc = gClient->getService(ORB_SVC_UUID);
  if (!svc) { gClient->disconnect(); return false; }
  gOrbChr = svc->getCharacteristic(ORB_CHR_UUID);
  if (!gOrbChr) { gClient->disconnect(); return false; }
  return true;
}

static void bleTask(void *) {
  bool inited = false;
  for (;;) {
    if (!gCfg.orb) {                              // companion disabled -> idle
      if (gOrbConnected && gClient) { gClient->disconnect(); gOrbConnected = false; }
      vTaskDelay(pdMS_TO_TICKS(300));
      continue;
    }
    if (!inited) {                               // lazy BT init: no cost unless used
      BLEDevice::init("ProsodyBall-Watch");
      BLEScan *scan = BLEDevice::getScan();
      static OrbScanCB cb;
      scan->setAdvertisedDeviceCallbacks(&cb, false);
      scan->setActiveScan(true);
      scan->setInterval(100);
      scan->setWindow(99);
      inited = true;
    }
    if (!gOrbConnected) {                         // scan, then connect
      gFoundFlag = false;
      BLEDevice::getScan()->start(4, false);     // blocks ~4 s
      BLEDevice::getScan()->clearResults();
      if (gFoundFlag && orbConnect()) gOrbConnected = true;
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }
    if (gClient && gClient->isConnected() && gOrbChr) {   // stream the latest colour
      uint8_t pkt[5] = { gOrbR, gOrbG, gOrbB, gOrbRes, gOrbWgt };
      gOrbChr->writeValue(pkt, 5, false);
    } else {
      gOrbConnected = false;
    }
    vTaskDelay(pdMS_TO_TICKS(50));               // ~20 Hz
  }
}

// Recompute the orb packet from the latest analysis + on-screen colour.
static void updateOrbPacket(const VoxResult &res) {
  Rgb c = (gCfg.mode == MODE_COLOR)
        ? uiBlendPal(gCfg.loColor, gCfg.hiColor, uiMetricValue(res, gCfg.colorSrc), 1.0f)
        : uiHsv(smoothHue, 0.9f, 1.0f);
  gOrbR = c.r; gOrbG = c.g; gOrbB = c.b;
  gOrbRes = (uint8_t)(uiClamp(res.brightness, 0, 1) * 255);  // -> orb pulse rate/depth
  gOrbWgt = (uint8_t)(uiClamp(res.weight, 0, 1) * 255);      // -> orb body/baseline
}

// ====================================================================
// Screen transitions
// ====================================================================
static void enterRun(bool repaint) {
  gScreen = SCR_RUN;
  if (!repaint) return;
  ttgo->tft->fillScreen(C_BG);
  prevX = -1;
  prevBandLo = prevBandHi = -1;
  gTracePrev.clear();
  gStatusForce = true;
  gHudDirty = true;
  if (gCfg.showHud && gCfg.mode == MODE_BALL) drawPitchAxis();
  gHintUntilMs = millis() + 4000;
}

static void enterQuick() {
  gScreen = SCR_QUICK;
  gQuickIdleMs = millis();
  gPressedQuick = -1;                  // the repaint below clears any highlight
  drawQuickMenu();
}

static void enterSettings() {
  gScreen = SCR_SETTINGS;
  gPage = 0;
  gPressedRow = -1;
  drawSettings();
}

static void enterStats() {
  gScreen = SCR_STATS;
  drawStats();
}

static void enterTutorial(bool fromSettings) {
  gScreen = SCR_TUTORIAL;
  gTutPage = 0;
  gTutFromSettings = fromSettings;
  drawTutorial();
}

static void applyLiveSettings() { ttgo->setBrightness(brightnessLevel()); }

static void toastBand(uint32_t now) {
  char m[30];
  snprintf(m, sizeof(m), "Target %d-%d Hz", gCfg.targetLoHz, gCfg.targetHiHz);
  gToast.show(m, now);
}

// ====================================================================
void setup() {
  Serial.begin(115200);
  loadSettings();

  ttgo = TTGOClass::getWatch();
  ttgo->begin();
  ttgo->openBL();
  ttgo->motor_begin();

  // Accelerometer — drives tilt-to-wake / auto-dim power saving.
  ttgo->bma->begin();
  Acfg cfg;
  cfg.odr       = BMA4_OUTPUT_DATA_RATE_100HZ;
  cfg.range     = BMA4_ACCEL_RANGE_2G;
  cfg.bandwidth = BMA4_ACCEL_NORMAL_AVG4;
  cfg.perf_mode = BMA4_CONTINUOUS_MODE;
  ttgo->bma->accelConfig(cfg);
  ttgo->bma->enableAccel();

  TFT_eSPI *tft = ttgo->tft;
  tft->setRotation(0);
  applyLiveSettings();

  // Boot splash: soft teal — mirrors the orb sketch's power-on self-test.
  tft->fillScreen(RGB565(0, 150, 150));
  delay(800);
  tft->fillScreen(C_BG);
  tft->setTextDatum(MC_DATUM);
  tft->setTextColor(C_TEXT, C_BG);
  tft->drawString("ProsodyBall", UI_SCR_W / 2, UI_SCR_H / 2 - 12, 4);
  tft->setTextColor(C_MUTED, C_BG);
  tft->drawString("calibrating mic...", UI_SCR_W / 2, UI_SCR_H / 2 + 16, 2);

  // Bring up audio + worker tasks; halt with a message if any critical step fails so we
  // never run the audio task against an uninitialised I2S port or a NULL queue.
  bool micOk = initMic();
  gResultQueue = xQueueCreate(1, sizeof(VoxResult));
  BaseType_t audioOk = (micOk && gResultQueue)
      ? xTaskCreatePinnedToCore(audioTask, "audio", 8192, NULL, 2, NULL, 0) // core 0
      : pdFAIL;
  BaseType_t bleOk = xTaskCreatePinnedToCore(bleTask, "ble", 8192, NULL, 1, NULL, 1); // core 1
  if (!micOk || !gResultQueue || audioOk != pdPASS || bleOk != pdPASS) {
    tft->fillScreen(C_BG);
    tft->setTextColor(C_WARN, C_BG);
    tft->drawString("Startup failed", UI_SCR_W / 2, UI_SCR_H / 2 - 10, 4);
    tft->setTextColor(C_MUTED, C_BG);
    tft->drawString("check the mic wiring / board", UI_SCR_W / 2, UI_SCR_H / 2 + 20, 1);
    for (;;) delay(1000);
  }

  gStats.reset();
  // First boot ever: teach the controls instead of dropping the user onto a bare ball.
  if (!gCfg.tutorial) enterTutorial(false);
  else                enterRun(true);
}

// ====================================================================
// Per-screen input handling
// ====================================================================
static void handleRunInput(const TouchEvent &ev, uint32_t now) {
  switch (ev.kind) {
    case TE_LONG:
      uiTick();
      enterSettings();
      break;
    case TE_SWIPE_L:
    case TE_SWIPE_R: {
      uiTick();
      gCfg.mode = (gCfg.mode + 1) % 2;
      saveSettings();
      enterRun(true);
      char m[30];
      snprintf(m, sizeof(m), "View: %s", MODE_NAMES[gCfg.mode % 2]);
      gToast.show(m, now);
      break;
    }
    case TE_TAP: {
      // Nudging an invisible band would be baffling, so the band shortcuts only exist when
      // the band is actually on screen. Otherwise every tap opens the menu.
      const bool nudge = (gCfg.mode == MODE_BALL) && gCfg.showBand;
      const int zone = uiTapZone(ev.y);
      if (nudge && zone == 0) {
        uiTick();
        if (uiNudgeBand(gCfg, 5)) { saveSettings(); toastBand(now); }
        else gToast.show("Target at top of range", now);
      } else if (nudge && zone == 2) {
        uiTick();
        if (uiNudgeBand(gCfg, -5)) { saveSettings(); toastBand(now); }
        else gToast.show("Target at bottom of range", now);
      } else {
        uiTick();
        enterQuick();
      }
      break;
    }
    default: break;
  }
}

static void releaseQuickHighlight() {
  if (gPressedQuick < 0) return;
  drawQuickButton(gPressedQuick, false);
  gPressedQuick = -1;
}

static void releaseRowHighlight() {
  if (gPressedRow < 0) return;
  uint8_t items[UI_ROWS_PER_PAGE];
  int n = uiPageItems(gCfg, gPage, items, UI_ROWS_PER_PAGE);
  if (gPressedRow < n) drawSettingsRow(gPressedRow, items[gPressedRow], false);
  gPressedRow = -1;
}

static void handleQuickInput(const TouchEvent &ev, uint32_t now) {
  if (ev.kind == TE_DOWN) {
    gQuickIdleMs = now;
    int i = uiQuickHit(ev.x, ev.y);
    if (i >= 0) { drawQuickButton(i, true); gPressedQuick = i; }
    return;
  }
  if (!gTouch.down) releaseQuickHighlight();
  if (ev.kind == TE_SWIPE_L || ev.kind == TE_SWIPE_R) { enterRun(true); return; }
  if (ev.kind != TE_TAP) {
    if (now - gQuickIdleMs > 10000) enterRun(true);   // don't strand the user in a menu
    return;
  }

  gQuickIdleMs = now;
  int i = uiQuickHit(ev.x, ev.y);
  if (i < 0) { drawQuickMenu(); return; }
  uiTick();
  switch (i) {
    case QA_MODE:                                   // stay put so the new label is visible
      gCfg.mode = (gCfg.mode + 1) % 2;
      saveSettings();
      drawQuickButton(QA_MODE, false);
      break;
    case QA_RECAL:
      gRecalRequest = true;
      enterRun(true);
      gToast.show("Recalibrating - stay quiet", now, 2200);
      break;
    case QA_RESET:
      gStats.reset();
      enterRun(true);
      gToast.show("Session reset", now);
      break;
    case QA_STATS:    enterStats(); break;
    case QA_SETTINGS: enterSettings(); break;
    default:          enterRun(true); break;        // QA_CLOSE
  }
}

static void handleStatsInput(const TouchEvent &ev) {
  if (ev.kind == TE_SWIPE_L || ev.kind == TE_SWIPE_R) { enterRun(true); return; }
  if (ev.kind != TE_TAP) return;
  if (ev.y < 204) return;                            // only the buttons act
  uiTick();
  if (ev.x < UI_SCR_W / 2) { gStats.reset(); drawStats(); }
  else                     enterRun(true);
}

// Returns true when the user chose Done.
static bool handleSettingsTap(int x, int y) {
  const int pages = uiPageCount(gCfg);
  if (y >= SET_FOOTER_Y) {
    if (x < 52)        { if (pages > 1) { gPage = (gPage + pages - 1) % pages; uiTick(); drawSettings(); } }
    else if (x < 102)  { if (pages > 1) { gPage = (gPage + 1) % pages; uiTick(); drawSettings(); } }
    else if (x >= 150) { uiTick(); return true; }
    return false;
  }

  uint8_t items[UI_ROWS_PER_PAGE];
  int n = uiPageItems(gCfg, gPage, items, UI_ROWS_PER_PAGE);
  int slot = (y - SET_ROW_Y0) / SET_ROW_H;
  if (y < SET_ROW_Y0 || slot < 0 || slot >= n) return false;

  uiTick();
  if (uiCycleItem(gCfg, gPreset, items[slot]) == ACT_HELP) { enterTutorial(true); return false; }
  applyLiveSettings();
  // Cycling View or Buzz-on changes which rows exist, so repaint the whole page rather than
  // just the row that was tapped.
  drawSettings();
  return false;
}

static void handleSettingsInput(const TouchEvent &ev, uint32_t now) {
  if (ev.kind == TE_DOWN) {
    if (ev.y < SET_FOOTER_Y && ev.y >= SET_ROW_Y0) {
      uint8_t items[UI_ROWS_PER_PAGE];
      int n = uiPageItems(gCfg, gPage, items, UI_ROWS_PER_PAGE);
      int slot = (ev.y - SET_ROW_Y0) / SET_ROW_H;
      if (slot >= 0 && slot < n) { drawSettingsRow(slot, items[slot], true); gPressedRow = slot; }
    }
    return;
  }
  if (!gTouch.down) releaseRowHighlight();
  if (ev.kind == TE_SWIPE_L || ev.kind == TE_SWIPE_R) {
    const int pages = uiPageCount(gCfg);
    if (pages > 1) {
      gPage = (ev.kind == TE_SWIPE_L) ? (gPage + 1) % pages : (gPage + pages - 1) % pages;
      drawSettings();
    }
    return;
  }
  if (ev.kind != TE_TAP) return;
  if (handleSettingsTap(ev.x, ev.y)) {
    saveSettings();
    enterRun(true);
    gToast.show("Settings saved", now);
  }
}

static void handleTutorialInput(const TouchEvent &ev, uint32_t now) {
  int step = 0;
  if (ev.kind == TE_SWIPE_L) step = 1;
  else if (ev.kind == TE_SWIPE_R) step = -1;
  else if (ev.kind == TE_TAP) step = (ev.x < UI_SCR_W / 2) ? -1 : 1;
  else return;

  uiTick();
  if (step > 0 && gTutPage >= N_TUTORIAL - 1) {        // finished
    gCfg.tutorial = 1;
    saveSettings();
    if (gTutFromSettings) enterSettings();
    else { enterRun(true); gToast.show("Tap the middle for the menu", now, 2500); }
    return;
  }
  if (step < 0 && gTutPage == 0) {                     // "Skip" on the first card
    gCfg.tutorial = 1;
    saveSettings();
    if (gTutFromSettings) enterSettings();
    else enterRun(true);
    return;
  }
  gTutPage += step;
  if (gTutPage < 0) gTutPage = 0;
  if (gTutPage >= N_TUTORIAL) gTutPage = N_TUTORIAL - 1;
  drawTutorial();
}

// ====================================================================
void loop() {
  static VoxResult latest = {};
  static uint32_t lastMs = 0, lastSaveMs = 0;
  static bool bestDirty = false;
  static bool hintsShown = false;

  VoxResult got;
  if (xQueueReceive(gResultQueue, &got, 0) == pdTRUE) latest = got;

  const uint32_t now = millis();
  int16_t tx = 0, ty = 0;
  const bool touched = ttgo->getTouch(tx, ty);
  const TouchEvent ev = gTouch.update(touched, (int)tx, (int)ty, now);

  // --- Auto-dim + tilt-wake (every screen) ----------------------------------
  // Activity = touch, voice, or wrist motion. A wrist tilt redistributes gravity
  // across the axes (magnitude stays ~1 g), so we watch per-axis change, not |a|.
  static const uint32_t DIM_AFTER_MS = 20000;
  static const uint8_t  DIM_LEVEL = 12;
  static const long     MOTION_THRESH = 2000; // sum of |Δaxis| counts (BMA4 2 g)
  static uint32_t lastActivityMs = 0;
  static bool dimmed = false, haveAccel = false;
  static int16_t pax = 0, pay = 0, paz = 0;

  bool motion = false;
  Accel acc;
  if (ttgo->bma->getAccel(acc)) {
    if (haveAccel) {
      long d = (long)abs(acc.x - pax) + abs(acc.y - pay) + abs(acc.z - paz);
      if (d > MOTION_THRESH) motion = true;
    }
    pax = acc.x; pay = acc.y; paz = acc.z; haveAccel = true;
  }
  bool active = touched || motion || (latest.voiced && latest.rms > 0.02f);
  if (active || lastActivityMs == 0) lastActivityMs = now;
  bool wantDim = gCfg.autoDim && (now - lastActivityMs) > DIM_AFTER_MS;
  if (wantDim && !dimmed)      { ttgo->setBrightness(DIM_LEVEL); dimmed = true; }
  else if (!wantDim && dimmed) { applyLiveSettings(); dimmed = false; }

  // --- Input, per screen ----------------------------------------------------
  switch (gScreen) {
    case SCR_TUTORIAL: handleTutorialInput(ev, now); break;
    case SCR_QUICK:    handleQuickInput(ev, now); break;
    case SCR_STATS:    handleStatsInput(ev); break;
    case SCR_SETTINGS: handleSettingsInput(ev, now); break;
    default:           handleRunInput(ev, now); break;
  }

  // A menu is not training: freeze the clock so time spent in one never counts against the
  // session score, and skip the visualisation entirely.
  if (gScreen != SCR_RUN) { lastMs = now; hintsShown = false; delay(20); return; }

  float dt = lastMs ? (now - lastMs) / 1000.0f : 0.016f;
  lastMs = now;

  const bool inTarget = latest.voiced &&
                        latest.pitchHz >= gCfg.targetLoHz && latest.pitchHz <= gCfg.targetHiHz;
  gStats.update(latest, dt, inTarget);

  // Track + lazily persist the best on-target score. Keep it dirty until actually saved so
  // an improvement during the throttle window isn't lost.
  if (gStats.voicedSecs > 3.0f) {
    int pct = gStats.onTargetPct();
    if (pct > (int)gCfg.bestPct) { gCfg.bestPct = (uint16_t)pct; bestDirty = true; }
    if (bestDirty && now - lastSaveMs > 15000) { saveSettings(); lastSaveMs = now; bestDirty = false; }
  }

  if (evalHaptic(latest, inTarget)) ttgo->motor->onec();

  if (gCfg.showHud) { drawStatusBar(gStatusForce); gStatusForce = false; drawMicLevel(latest); }

  if (gCfg.mode == MODE_COLOR) {
    renderColor(latest, now);
  } else {
    gTrace.push((int16_t)uiHzToY(latest.pitchHz), latest.voiced, inTarget, now);
    updateBallPhysics(latest, dt);
    renderBall(latest, inTarget);
    if (gCfg.showHud && !gToast.visible(now)) drawBallHud(latest, inTarget, now);
  }

  // Tap hints fade out on their own once you've had a chance to read them.
  if (gCfg.showHud && gCfg.mode == MODE_BALL) {
    bool want = (int32_t)(gHintUntilMs - now) > 0;
    if (want) { drawTapHints(true); hintsShown = true; }
    else if (hintsShown) { drawTapHints(false); hintsShown = false; }
  }

  drawToast(now);

  // BLE companion: feed the orb the latest colour.
  if (gCfg.orb) updateOrbPacket(latest);

  delay(16);
}
