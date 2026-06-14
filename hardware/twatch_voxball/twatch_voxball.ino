/**
 * ProsodyBall — standalone voice trainer for the LilyGo T-Watch 2020 V3
 * --------------------------------------------------------------------
 * Self-contained: the watch captures its OWN voice from the V3's PDM microphone, runs
 * pitch + energy + brightness DSP on-device (dsp.cpp — a port of app.js / dsp-utils.js),
 * and visualises it locally on the 240x240 screen. No phone, no browser, no BLE.
 *
 * Two visualisations (switchable in Settings):
 *   - VOX BALL : a ball whose height/colour follow pitch and that hops on each syllable.
 *   - COLOR    : the whole screen colours from a chosen metric, blended between two
 *                user-picked colours (e.g. pitch low->Blue, high->Pink).
 *
 * Everything is customisable on-device and saved to flash (NVS): mode, the metric that
 * drives colour, the two colours, the haptic trigger + threshold, and the pitch-target band.
 *
 * Controls:
 *   - Short tap  : (running) top=raise target, bottom=lower target, middle=recalibrate+reset score.
 *   - Long press : open / interact with Settings (tap rows to cycle values; "Done" saves).
 *
 * Audio + DSP run on core 0; rendering/input on core 1 (Arduino loop), decoupled by a
 * 1-slot queue — the same producer/consumer shape as the orb sketch.
 *
 * Requires (Arduino IDE): "esp32" boards package + "TTGO TWatch Library" (Library Manager).
 */
#include "config.h"          // selects LILYGO_WATCH_2020_V3 then includes <LilyGoWatch.h>
#include <driver/i2s.h>
#include <Preferences.h>
#include "dsp.h"

// --- PDM microphone pins / port (from the library's TwatcV3Special/Microphone example) ---
#define MIC_DATA   2
#define MIC_CLOCK  0
#define MIC_PORT   I2S_NUM_0

TTGOClass *ttgo = nullptr;

// --- cross-core handoff ---
static QueueHandle_t gResultQueue;      // length 1, overwritten with the latest frame
static VoxDsp        gDsp;              // owned by the audio task (core 0)
static volatile bool gRecalRequest = false;

// ====================================================================
// Persisted settings (NVS) + option tables
// ====================================================================
enum Mode      { MODE_BALL = 0, MODE_COLOR = 1 };
enum HueMetric { SRC_PITCH = 0, SRC_BRIGHT, SRC_BOUNCE, SRC_LOUD };
enum Haptic    { HAP_OFF = 0, HAP_ONTARGET, HAP_SYLLABLE, HAP_BRIGHT, HAP_LOUD };

struct Settings {
  uint8_t  mode      = MODE_BALL;
  uint8_t  colorSrc  = SRC_PITCH;   // which metric drives the colour
  uint8_t  loColor   = 0;           // palette index at metric=0
  uint8_t  hiColor   = 6;           // palette index at metric=1
  uint8_t  haptic    = HAP_ONTARGET;
  uint8_t  hapticThr = 50;          // % threshold for the >threshold haptics
  uint16_t targetLoHz = 145;
  uint16_t targetHiHz = 175;
  uint16_t bestPct   = 0;           // best on-target % across sessions
};
static Settings    gCfg;
static Preferences gPrefs;

struct Pal { const char *name; uint8_t r, g, b; };
static const Pal PALETTE[] = {
  {"Blue", 30, 90, 255}, {"Teal", 0, 200, 180}, {"Green", 40, 220, 60},
  {"Purple", 150, 60, 230}, {"Red", 240, 40, 40}, {"Orange", 255, 140, 0},
  {"Pink", 255, 80, 170}, {"White", 240, 240, 240},
};
static const int N_PAL = sizeof(PALETTE) / sizeof(PALETTE[0]);

static const char *MODE_NAMES[]   = { "Vox Ball", "Color" };
static const char *SRC_NAMES[]    = { "Pitch", "Brightness", "Bounce", "Loudness" };
static const char *HAPTIC_NAMES[] = { "Off", "On-target", "Syllables", "Bright", "Loud" };

static void loadSettings() {
  gPrefs.begin("voxball", true);
  gCfg.mode       = gPrefs.getUChar("mode", gCfg.mode);
  gCfg.colorSrc   = gPrefs.getUChar("src", gCfg.colorSrc);
  gCfg.loColor    = gPrefs.getUChar("lo", gCfg.loColor);
  gCfg.hiColor    = gPrefs.getUChar("hi", gCfg.hiColor);
  gCfg.haptic     = gPrefs.getUChar("hap", gCfg.haptic);
  gCfg.hapticThr  = gPrefs.getUChar("hthr", gCfg.hapticThr);
  gCfg.targetLoHz = gPrefs.getUShort("tlo", gCfg.targetLoHz);
  gCfg.targetHiHz = gPrefs.getUShort("thi", gCfg.targetHiHz);
  gCfg.bestPct    = gPrefs.getUShort("best", gCfg.bestPct);
  gPrefs.end();
}
static void saveSettings() {
  gPrefs.begin("voxball", false);
  gPrefs.putUChar("mode", gCfg.mode);
  gPrefs.putUChar("src", gCfg.colorSrc);
  gPrefs.putUChar("lo", gCfg.loColor);
  gPrefs.putUChar("hi", gCfg.hiColor);
  gPrefs.putUChar("hap", gCfg.haptic);
  gPrefs.putUChar("hthr", gCfg.hapticThr);
  gPrefs.putUShort("tlo", gCfg.targetLoHz);
  gPrefs.putUShort("thi", gCfg.targetHiHz);
  gPrefs.putUShort("best", gCfg.bestPct);
  gPrefs.end();
}

// ====================================================================
// Audio capture + DSP — runs on core 0
// ====================================================================
static void initMic() {
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

  i2s_driver_install(MIC_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(MIC_PORT, &pin_cfg);
  i2s_set_clk(MIC_PORT, VOX_SAMPLE_RATE, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_MONO);
}

static void audioTask(void *) {
  static int16_t raw[VOX_FRAME_SAMPLES];
  static float   frame[VOX_FRAME_SAMPLES];
  const float dt = (float)VOX_FRAME_SAMPLES / (float)VOX_SAMPLE_RATE; // ~64 ms

  for (;;) {
    if (gRecalRequest) { gDsp.recalibrate(); gRecalRequest = false; }

    size_t bytesRead = 0;
    i2s_read(MIC_PORT, (char *)raw, sizeof(raw), &bytesRead, portMAX_DELAY);
    int got = bytesRead / sizeof(int16_t);
    for (int i = 0; i < got; i++) frame[i] = raw[i] / 32768.0f;  // int16 -> [-1, 1)

    VoxResult res = gDsp.process(frame, got, dt);
    xQueueOverwrite(gResultQueue, &res);  // keep only the freshest frame
  }
}

// ====================================================================
// Shared rendering helpers (core 1)
// ====================================================================
static const int SCR_W = 240, SCR_H = 240;
static const int TOP_MARGIN = 34, BOT_MARGIN = 46;
static const int USABLE_H = SCR_H - TOP_MARGIN - BOT_MARGIN;

// App run state.
enum UiState { RUNNING = 0, SETTINGS = 1 };
static UiState gState = RUNNING;

// Session stats.
static float voicedTime = 0.0f, inTargetTime = 0.0f;

static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// The 0..1 value of whichever metric the user picked to drive colour.
static float metricValue(const VoxResult &r, uint8_t src) {
  switch (src) {
    case SRC_PITCH:  return r.pitchPos;
    case SRC_BRIGHT: return r.brightness;
    case SRC_BOUNCE: return r.bounce;
    default:         return clampf(r.rms * 8.0f, 0.0f, 1.0f); // SRC_LOUD
  }
}

// HSV (h deg, s/v 0..1) -> RGB565.
static uint16_t hsv565(float h, float s, float v) {
  h = fmodf(h, 360.0f); if (h < 0) h += 360.0f;
  float c = v * s, x = c * (1 - fabsf(fmodf(h / 60.0f, 2.0f) - 1)), m = v - c;
  float r, g, b;
  if      (h < 60)  { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return ttgo->tft->color565((uint8_t)((r + m) * 255), (uint8_t)((g + m) * 255), (uint8_t)((b + m) * 255));
}

// Linear blend of two palette entries by t (0..1), scaled by value v (0..1), -> RGB565.
static uint16_t blendPal565(int loIdx, int hiIdx, float t, float v) {
  const Pal &a = PALETTE[loIdx], &b = PALETTE[hiIdx];
  t = clampf(t, 0, 1); v = clampf(v, 0, 1);
  uint8_t R = (uint8_t)((a.r + (b.r - a.r) * t) * v);
  uint8_t G = (uint8_t)((a.g + (b.g - a.g) * t) * v);
  uint8_t B = (uint8_t)((a.b + (b.b - a.b) * t) * v);
  return ttgo->tft->color565(R, G, B);
}

static int hzToY(float hz) {
  float pos = clampf((hz - VOX_PITCH_MIN_HZ) / (VOX_PITCH_MAX_HZ - VOX_PITCH_MIN_HZ), 0, 1);
  return TOP_MARGIN + (int)((1.0f - pos) * USABLE_H);
}

// ====================================================================
// VOX BALL visualisation
// ====================================================================
static float ballPos = 0.5f, ballVel = 0.0f;
static float bounceY = 0.0f, bounceVel = 0.0f;
static float prevImpulse = 0.0f;
static float smoothHue = 270.0f, smoothR = 18.0f;
static int prevX = -1, prevY = -1, prevR = 0;

static void dashedHLine(int y, uint16_t color) {
  TFT_eSPI *tft = ttgo->tft;
  for (int x = 8; x < SCR_W - 8; x += 12) tft->drawFastHLine(x, y, 7, color);
}

static void updateBallPhysics(const VoxResult &res, float dt) {
  dt = clampf(dt, 0.0f, 0.05f);
  float target = res.voiced ? res.pitchPos : 0.5f;
  const float K = 14.0f, DAMP = 7.0f;
  ballVel += (target - ballPos) * K * dt;
  ballVel -= ballVel * DAMP * dt;
  ballPos = clampf(ballPos + ballVel * dt, 0.0f, 1.0f);

  if (res.syllableImpulse > 0.6f && prevImpulse <= 0.6f)
    bounceVel += 1.6f * (0.35f + 0.65f * res.bounce);
  prevImpulse = res.syllableImpulse;
  bounceVel -= 6.0f * dt;
  bounceY += bounceVel * dt;
  if (bounceY < 0.0f) { bounceY = 0.0f; bounceVel = 0.0f; }
  if (bounceY > 0.45f) bounceY = 0.45f;

  float hueTarget = res.voiced ? (210.0f + clampf(res.pitchPos, 0, 1) * 130.0f) : 270.0f;
  smoothHue += (hueTarget - smoothHue) * 0.25f;
  float rTarget = 14.0f + 24.0f * clampf(res.rms * 8.0f, 0.0f, 1.0f);
  smoothR += (rTarget - smoothR) * 0.3f;
}

static void renderBall(const VoxResult &res, bool inTarget) {
  TFT_eSPI *tft = ttgo->tft;
  float renderPos = clampf(ballPos + bounceY, 0.0f, 1.0f);
  int x = SCR_W / 2;
  int y = TOP_MARGIN + (int)((1.0f - renderPos) * USABLE_H);
  int r = (int)smoothR;

  float base = res.voiced ? (0.45f + 0.55f * clampf(res.confidence, 0, 1)) : 0.22f;
  uint16_t color = hsv565(smoothHue, 0.9f, inTarget ? clampf(base + 0.25f, 0, 1) : base);

  if (prevX >= 0) tft->fillCircle(prevX, prevY, prevR + 3, TFT_BLACK);

  static int prevYLo = -1, prevYHi = -1;
  int yLo = hzToY((float)gCfg.targetLoHz), yHi = hzToY((float)gCfg.targetHiHz);
  if (prevYLo >= 0 && (prevYLo != yLo || prevYHi != yHi)) {
    tft->drawFastHLine(0, prevYLo, SCR_W, TFT_BLACK);
    tft->drawFastHLine(0, prevYHi, SCR_W, TFT_BLACK);
  }
  prevYLo = yLo; prevYHi = yHi;

  uint16_t bandColor = inTarget ? TFT_GREEN : tft->color565(70, 90, 80);
  dashedHLine(yHi, bandColor); dashedHLine(yLo, bandColor);

  tft->fillCircle(x, y, r, color);
  if (inTarget) tft->drawCircle(x, y, r + 3, TFT_GREEN);
  prevX = x; prevY = y; prevR = r;

  tft->fillRect(0, SCR_H - BOT_MARGIN + 6, SCR_W, BOT_MARGIN - 6, TFT_BLACK);
  tft->setTextDatum(MC_DATUM);
  char line[40];
  if (gDsp.calibrating()) {
    tft->setTextColor(TFT_WHITE, TFT_BLACK);
    tft->drawString("Calibrating... stay quiet", SCR_W / 2, SCR_H - 24, 2);
  } else {
    if (res.voiced) snprintf(line, sizeof(line), "%d Hz", (int)(res.pitchHz + 0.5f));
    else            snprintf(line, sizeof(line), "--");
    tft->setTextColor(inTarget ? TFT_GREEN : TFT_WHITE, TFT_BLACK);
    tft->drawString(line, SCR_W / 2, SCR_H - 30, 4);
    int pct = voicedTime > 0.2f ? (int)(100.0f * inTargetTime / voicedTime + 0.5f) : 0;
    snprintf(line, sizeof(line), "%d-%d Hz  on-target %d%%  best %d%%",
             gCfg.targetLoHz, gCfg.targetHiHz, pct, gCfg.bestPct);
    tft->setTextColor(tft->color565(160, 180, 170), TFT_BLACK);
    tft->drawString(line, SCR_W / 2, SCR_H - 10, 2);
  }
}

// ====================================================================
// COLOR visualisation — whole screen coloured from the chosen metric
// ====================================================================
static void renderColor(const VoxResult &res) {
  TFT_eSPI *tft = ttgo->tft;
  float t = metricValue(res, gCfg.colorSrc);              // 0..1 chosen metric
  float loud = clampf(res.rms * 8.0f, 0.0f, 1.0f);
  float v = res.voiced ? (0.25f + 0.75f * loud) : 0.12f;  // louder = brighter, dim if quiet
  uint16_t col = blendPal565(gCfg.loColor, gCfg.hiColor, t, v);

  tft->fillScreen(col);

  // Readable HUD strip.
  tft->fillRect(0, SCR_H - 26, SCR_W, 26, TFT_BLACK);
  tft->setTextDatum(MC_DATUM);
  tft->setTextColor(TFT_WHITE, TFT_BLACK);
  char line[40];
  if (gDsp.calibrating())
    snprintf(line, sizeof(line), "Calibrating... stay quiet");
  else
    snprintf(line, sizeof(line), "%s  %d%%", SRC_NAMES[gCfg.colorSrc], (int)(t * 100 + 0.5f));
  tft->drawString(line, SCR_W / 2, SCR_H - 13, 2);
}

// ====================================================================
// SETTINGS screen
// ====================================================================
static const int N_ROWS = 7;          // Mode, Color src, Low, High, Haptics, Haptic thr, Done
static const int ROW_Y0 = 30, ROW_DY = 28;

static void rowText(int i, char *out, size_t n) {
  switch (i) {
    case 0: snprintf(out, n, "Mode: %s", MODE_NAMES[gCfg.mode]); break;
    case 1: snprintf(out, n, "Color from: %s", SRC_NAMES[gCfg.colorSrc]); break;
    case 2: snprintf(out, n, "Low color: %s", PALETTE[gCfg.loColor].name); break;
    case 3: snprintf(out, n, "High color: %s", PALETTE[gCfg.hiColor].name); break;
    case 4: snprintf(out, n, "Haptics: %s", HAPTIC_NAMES[gCfg.haptic]); break;
    case 5: snprintf(out, n, "Haptic thr: %d%%", gCfg.hapticThr); break;
    default: snprintf(out, n, "* Done (save) *"); break;
  }
}

static void drawSettings() {
  TFT_eSPI *tft = ttgo->tft;
  tft->fillScreen(TFT_BLACK);
  tft->setTextDatum(TL_DATUM);
  tft->setTextColor(tft->color565(120, 200, 255), TFT_BLACK);
  tft->drawString("Settings  (tap a row)", 12, 8, 2);
  char line[40];
  for (int i = 0; i < N_ROWS; i++) {
    rowText(i, line, sizeof(line));
    uint16_t c = (i == N_ROWS - 1) ? TFT_GREEN : TFT_WHITE;
    // Show a colour swatch next to the colour rows.
    if (i == 2 || i == 3) {
      int idx = (i == 2) ? gCfg.loColor : gCfg.hiColor;
      tft->fillRect(SCR_W - 28, ROW_Y0 + i * ROW_DY + 2, 16, 14,
                    tft->color565(PALETTE[idx].r, PALETTE[idx].g, PALETTE[idx].b));
    }
    tft->setTextColor(c, TFT_BLACK);
    tft->drawString(line, 12, ROW_Y0 + i * ROW_DY, 2);
  }
}

// Returns true if the user chose "Done" (caller exits + saves).
static bool handleSettingsTap(int ty) {
  int i = (ty - ROW_Y0 + ROW_DY / 2) / ROW_DY;
  if (i < 0) i = 0;
  if (i >= N_ROWS) i = N_ROWS - 1;
  switch (i) {
    case 0: gCfg.mode = (gCfg.mode + 1) % 2; break;
    case 1: gCfg.colorSrc = (gCfg.colorSrc + 1) % 4; break;
    case 2: gCfg.loColor = (gCfg.loColor + 1) % N_PAL; break;
    case 3: gCfg.hiColor = (gCfg.hiColor + 1) % N_PAL; break;
    case 4: gCfg.haptic = (gCfg.haptic + 1) % 5; break;
    case 5: gCfg.hapticThr = (gCfg.hapticThr >= 75) ? 25 : gCfg.hapticThr + 25; break;
    default: return true; // Done
  }
  drawSettings();
  return false;
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
    case HAP_LOUD:     { bool on = clampf(res.rms * 8.0f, 0, 1) > thr; buzz = on && !pLoud; pLoud = on; } break;
    default: break; // HAP_OFF
  }
  pInTarget = inTarget;
  return buzz;
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

  // Boot splash: soft teal — mirrors the orb sketch's power-on self-test.
  tft->fillScreen(tft->color565(0, 150, 150));
  delay(800);
  tft->fillScreen(TFT_BLACK);
  tft->setTextDatum(MC_DATUM);
  tft->setTextColor(TFT_WHITE, TFT_BLACK);
  tft->drawString("ProsodyBall", SCR_W / 2, SCR_H / 2 - 12, 4);
  tft->drawString("calibrating mic...", SCR_W / 2, SCR_H / 2 + 16, 2);

  initMic();
  gResultQueue = xQueueCreate(1, sizeof(VoxResult));
  xTaskCreatePinnedToCore(audioTask, "audio", 8192, NULL, 2, NULL, 0); // core 0

  tft->fillScreen(TFT_BLACK);
}

static void enterSettings() {
  gState = SETTINGS;
  drawSettings();
}
static void exitSettings() {
  saveSettings();
  gState = RUNNING;
  prevX = -1;                 // force a clean ball redraw
  ttgo->tft->fillScreen(TFT_BLACK);
}

void loop() {
  static VoxResult latest = {};
  static uint32_t lastMs = 0, lastSaveMs = 0;
  static bool touchedPrev = false, longFired = false;
  static int pressTy = 0;
  static uint32_t touchStartMs = 0;

  VoxResult got;
  if (xQueueReceive(gResultQueue, &got, 0) == pdTRUE) latest = got;

  uint32_t now = millis();
  int16_t tx, ty;
  bool touched = ttgo->getTouch(tx, ty);
  bool rising = touched && !touchedPrev;
  bool falling = !touched && touchedPrev;

  if (rising) {
    pressTy = ty; touchStartMs = now; longFired = false;
    if (gState == SETTINGS) {
      longFired = true;                 // suppress the release acting as a running tap
      if (handleSettingsTap(ty)) exitSettings();
    }
  }
  // Long-press opens settings (running only).
  if (touched && gState == RUNNING && !longFired && (now - touchStartMs) > 800) {
    enterSettings(); longFired = true;
  }
  if (falling && gState == RUNNING && !longFired) {
    // Short tap zones: top=raise target, bottom=lower target, middle=recalibrate.
    if (pressTy < SCR_H / 3) {
      gCfg.targetLoHz = (uint16_t)clampf(gCfg.targetLoHz + 5, VOX_PITCH_MIN_HZ, VOX_PITCH_MAX_HZ - 10);
      gCfg.targetHiHz = (uint16_t)clampf(gCfg.targetHiHz + 5, VOX_PITCH_MIN_HZ + 10, VOX_PITCH_MAX_HZ);
      saveSettings();
    } else if (pressTy > 2 * SCR_H / 3) {
      gCfg.targetLoHz = (uint16_t)clampf(gCfg.targetLoHz - 5, VOX_PITCH_MIN_HZ, VOX_PITCH_MAX_HZ - 10);
      gCfg.targetHiHz = (uint16_t)clampf(gCfg.targetHiHz - 5, VOX_PITCH_MIN_HZ + 10, VOX_PITCH_MAX_HZ);
      saveSettings();
    } else {
      gRecalRequest = true;
      voicedTime = inTargetTime = 0.0f;
    }
  }
  touchedPrev = touched;

  // --- Auto-dim + tilt-wake -------------------------------------------------
  // Activity = touch, voice, or wrist motion. A wrist tilt redistributes gravity
  // across the axes (magnitude stays ~1 g), so we watch per-axis change, not |a|.
  static const uint32_t DIM_AFTER_MS = 20000;
  static const uint8_t  BRIGHT_LEVEL = 255, DIM_LEVEL = 12;
  static const long     MOTION_THRESH = 2000; // sum of |Δaxis| counts (BMA4 2 g)
  static uint32_t lastActivityMs = 0;
  static bool dimmed = false, haveAccel = false;
  static int16_t pax = 0, pay = 0, paz = 0;

  bool motion = false;
  Accel acc;
  if (ttgo->bma->getAccel(acc)) {
    if (haveAccel) {
      int dx = acc.x - pax, dy = acc.y - pay, dz = acc.z - paz;
      long d = (long)abs(dx) + abs(dy) + abs(dz);
      if (d > MOTION_THRESH) motion = true;
    }
    pax = acc.x; pay = acc.y; paz = acc.z; haveAccel = true;
  }
  bool active = touched || motion || (latest.voiced && latest.rms > 0.02f);
  if (active || lastActivityMs == 0) lastActivityMs = now;
  bool wantDim = (now - lastActivityMs) > DIM_AFTER_MS;
  if (wantDim && !dimmed)      { ttgo->setBrightness(DIM_LEVEL);    dimmed = true; }
  else if (!wantDim && dimmed) { ttgo->setBrightness(BRIGHT_LEVEL); dimmed = false; }

  // While in settings, don't run the visualisation.
  if (gState == SETTINGS) { delay(20); return; }

  float dt = lastMs ? (now - lastMs) / 1000.0f : 0.016f;
  lastMs = now;

  bool inTarget = latest.voiced &&
                  latest.pitchHz >= gCfg.targetLoHz && latest.pitchHz <= gCfg.targetHiHz;
  if (latest.voiced) { voicedTime += dt; if (inTarget) inTargetTime += dt; }

  // Track + lazily persist the best on-target score.
  if (voicedTime > 3.0f) {
    int pct = (int)(100.0f * inTargetTime / voicedTime + 0.5f);
    if (pct > gCfg.bestPct) {
      gCfg.bestPct = (uint16_t)pct;
      if (now - lastSaveMs > 15000) { saveSettings(); lastSaveMs = now; }
    }
  }

  if (evalHaptic(latest, inTarget)) ttgo->motor->onec();

  if (gCfg.mode == MODE_COLOR) {
    renderColor(latest);
  } else {
    updateBallPhysics(latest, dt);
    renderBall(latest, inTarget);
  }

  delay(16);
}
