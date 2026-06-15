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
#include <BLEDevice.h>       // BLE client for the optional orb companion mode
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
enum HueMetric { SRC_PITCH = 0, SRC_BRIGHT, SRC_BOUNCE, SRC_LOUD, SRC_GENDER, SRC_WEIGHT, SRC_COUNT };
enum Haptic    { HAP_OFF = 0, HAP_ONTARGET, HAP_SYLLABLE, HAP_BRIGHT, HAP_LOUD };
enum Effect    { EFF_NONE = 0, EFF_PULSE, EFF_GRADIENT, EFF_METER, EFF_COUNT };

struct Settings {
  uint8_t  mode      = MODE_BALL;
  uint8_t  colorSrc  = SRC_PITCH;   // which metric drives the colour
  uint8_t  loColor   = 0;           // palette index at metric=0
  uint8_t  hiColor   = 6;           // palette index at metric=1
  uint8_t  effect    = EFF_NONE;    // Color-mode visual effect
  uint8_t  haptic    = HAP_ONTARGET;
  uint8_t  hapticThr = 50;          // % threshold for the >threshold haptics
  uint8_t  autoDim   = 1;           // auto-dim + tilt-wake on/off
  uint8_t  showBand  = 1;           // pitch-target band + glow + score on/off
  uint8_t  showHud   = 1;           // bottom text readout on/off
  uint8_t  orb       = 0;           // BLE companion: drive the LED orb on/off
  uint16_t targetLoHz = 145;
  uint16_t targetHiHz = 175;
  uint16_t bestPct   = 0;           // best on-target % across sessions
};
static Settings    gCfg;
static Preferences gPrefs;

// Palette of named colours used as the low/high anchors of the colour blend.
struct Pal { const char *name; uint8_t r, g, b; };
static const Pal PALETTE[] = {
  {"Blue", 30, 90, 255}, {"Teal", 0, 200, 180}, {"Green", 40, 220, 60},
  {"Purple", 150, 60, 230}, {"Red", 240, 40, 40}, {"Orange", 255, 140, 0},
  {"Pink", 255, 80, 170}, {"White", 240, 240, 240}, {"Cyan", 0, 230, 230},
  {"Magenta", 230, 0, 200}, {"Yellow", 240, 220, 0}, {"Lime", 170, 240, 40},
  {"Indigo", 70, 60, 220}, {"Rose", 255, 130, 150},
};
static const int N_PAL = sizeof(PALETTE) / sizeof(PALETTE[0]);
// Palette indices (keep in sync with PALETTE order above) for the gradient presets.
enum { P_BLUE = 0, P_TEAL, P_GREEN, P_PURPLE, P_RED, P_ORANGE, P_PINK, P_WHITE,
       P_CYAN, P_MAGENTA, P_YELLOW, P_LIME, P_INDIGO, P_ROSE };

// Named gradient presets: cycling these sets both low and high colours at once.
// "Custom" (index 0) leaves the current low/high colours untouched.
struct Preset { const char *name; uint8_t lo, hi; };
static const Preset PRESETS[] = {
  {"Custom", P_BLUE, P_PINK}, {"Trans", P_BLUE, P_PINK}, {"Fire", P_RED, P_YELLOW},
  {"Ocean", P_INDIGO, P_CYAN}, {"Forest", P_GREEN, P_LIME}, {"Sunset", P_PURPLE, P_ORANGE},
  {"Mono", P_TEAL, P_WHITE}, {"Candy", P_CYAN, P_MAGENTA},
};
static const int N_PRESET = sizeof(PRESETS) / sizeof(PRESETS[0]);
static int gPreset = 0; // runtime only (low/high colours are what persist)

static const char *MODE_NAMES[]   = { "Vox Ball", "Color" };
static const char *SRC_NAMES[]    = { "Pitch", "Brightness", "Bounce", "Loudness", "Gender", "Weight" };
static const char *HAPTIC_NAMES[] = { "Off", "On-target", "Syllables", "Bright", "Loud" };
static const char *EFFECT_NAMES[] = { "None", "Pulse", "Gradient", "Meter" };
static const char *ONOFF[]        = { "Off", "On" };


static void loadSettings() {
  gPrefs.begin("voxball", true);
  gCfg.mode       = gPrefs.getUChar("mode", gCfg.mode);
  gCfg.colorSrc   = gPrefs.getUChar("src", gCfg.colorSrc);
  gCfg.loColor    = gPrefs.getUChar("lo", gCfg.loColor);
  gCfg.hiColor    = gPrefs.getUChar("hi", gCfg.hiColor);
  gCfg.effect     = gPrefs.getUChar("eff", gCfg.effect);
  gCfg.haptic     = gPrefs.getUChar("hap", gCfg.haptic);
  gCfg.hapticThr  = gPrefs.getUChar("hthr", gCfg.hapticThr);
  gCfg.autoDim    = gPrefs.getUChar("adim", gCfg.autoDim);
  gCfg.showBand   = gPrefs.getUChar("band", gCfg.showBand);
  gCfg.showHud    = gPrefs.getUChar("hud", gCfg.showHud);
  gCfg.orb        = gPrefs.getUChar("orb", gCfg.orb);
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
  gPrefs.putUChar("eff", gCfg.effect);
  gPrefs.putUChar("hap", gCfg.haptic);
  gPrefs.putUChar("hthr", gCfg.hapticThr);
  gPrefs.putUChar("adim", gCfg.autoDim);
  gPrefs.putUChar("band", gCfg.showBand);
  gPrefs.putUChar("hud", gCfg.showHud);
  gPrefs.putUChar("orb", gCfg.orb);
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
    case SRC_GENDER: return r.genderScore;   // 0 masc .. 1 fem
    case SRC_WEIGHT: return r.weight;        // 0 light/breathy .. 1 heavy/pressed
    default:         return clampf(r.rms * 8.0f, 0.0f, 1.0f); // SRC_LOUD
  }
}

// HSV (h deg, s/v 0..1) -> 8-bit RGB.
static void hsvRGB(float h, float s, float v, uint8_t *R, uint8_t *G, uint8_t *B) {
  h = fmodf(h, 360.0f); if (h < 0) h += 360.0f;
  float c = v * s, x = c * (1 - fabsf(fmodf(h / 60.0f, 2.0f) - 1)), m = v - c;
  float r, g, b;
  if      (h < 60)  { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  *R = (uint8_t)((r + m) * 255); *G = (uint8_t)((g + m) * 255); *B = (uint8_t)((b + m) * 255);
}
static uint16_t hsv565(float h, float s, float v) {
  uint8_t R, G, B; hsvRGB(h, s, v, &R, &G, &B);
  return ttgo->tft->color565(R, G, B);
}

// Linear blend of two palette entries by t (0..1), scaled by value v (0..1).
static void blendPalRGB(int loIdx, int hiIdx, float t, float v, uint8_t *R, uint8_t *G, uint8_t *B) {
  const Pal &a = PALETTE[loIdx], &b = PALETTE[hiIdx];
  t = clampf(t, 0, 1); v = clampf(v, 0, 1);
  *R = (uint8_t)((a.r + (b.r - a.r) * t) * v);
  *G = (uint8_t)((a.g + (b.g - a.g) * t) * v);
  *B = (uint8_t)((a.b + (b.b - a.b) * t) * v);
}
static uint16_t blendPal565(int loIdx, int hiIdx, float t, float v) {
  uint8_t R, G, B; blendPalRGB(loIdx, hiIdx, t, v, &R, &G, &B);
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

static void renderBall(const VoxResult &res, bool inTarget, bool showBand, bool showHud) {
  TFT_eSPI *tft = ttgo->tft;
  bool glow = showBand && inTarget;   // target visuals only when the band is enabled
  float renderPos = clampf(ballPos + bounceY, 0.0f, 1.0f);
  int x = SCR_W / 2;
  int y = TOP_MARGIN + (int)((1.0f - renderPos) * USABLE_H);
  int r = (int)smoothR;

  float base = res.voiced ? (0.45f + 0.55f * clampf(res.confidence, 0, 1)) : 0.22f;
  uint16_t color = hsv565(smoothHue, 0.9f, glow ? clampf(base + 0.25f, 0, 1) : base);

  if (prevX >= 0) tft->fillCircle(prevX, prevY, prevR + 3, TFT_BLACK);

  if (showBand) {
    static int prevYLo = -1, prevYHi = -1;
    int yLo = hzToY((float)gCfg.targetLoHz), yHi = hzToY((float)gCfg.targetHiHz);
    if (prevYLo >= 0 && (prevYLo != yLo || prevYHi != yHi)) {
      tft->drawFastHLine(0, prevYLo, SCR_W, TFT_BLACK);
      tft->drawFastHLine(0, prevYHi, SCR_W, TFT_BLACK);
    }
    prevYLo = yLo; prevYHi = yHi;
    uint16_t bandColor = inTarget ? TFT_GREEN : tft->color565(70, 90, 80);
    dashedHLine(yHi, bandColor); dashedHLine(yLo, bandColor);
  }

  tft->fillCircle(x, y, r, color);
  if (glow) tft->drawCircle(x, y, r + 3, TFT_GREEN);
  prevX = x; prevY = y; prevR = r;

  tft->fillRect(0, SCR_H - BOT_MARGIN + 6, SCR_W, BOT_MARGIN - 6, TFT_BLACK);
  if (!showHud) return;
  tft->setTextDatum(MC_DATUM);
  char line[44];
  if (gDsp.calibrating()) {
    tft->setTextColor(TFT_WHITE, TFT_BLACK);
    tft->drawString("Calibrating... stay quiet", SCR_W / 2, SCR_H - 24, 2);
  } else {
    if (res.voiced) snprintf(line, sizeof(line), "%d Hz", (int)(res.pitchHz + 0.5f));
    else            snprintf(line, sizeof(line), "--");
    tft->setTextColor(glow ? TFT_GREEN : TFT_WHITE, TFT_BLACK);
    tft->drawString(line, SCR_W / 2, SCR_H - 30, 4);
    if (showBand) {
      int pct = voicedTime > 0.2f ? (int)(100.0f * inTargetTime / voicedTime + 0.5f) : 0;
      snprintf(line, sizeof(line), "%d-%d Hz  on-target %d%%  best %d%%",
               gCfg.targetLoHz, gCfg.targetHiHz, pct, gCfg.bestPct);
      tft->setTextColor(tft->color565(160, 180, 170), TFT_BLACK);
      tft->drawString(line, SCR_W / 2, SCR_H - 10, 2);
    }
  }
}

// ====================================================================
// COLOR visualisation — whole screen coloured from the chosen metric
// ====================================================================
static void renderColor(const VoxResult &res) {
  TFT_eSPI *tft = ttgo->tft;
  const int lo = gCfg.loColor, hi = gCfg.hiColor;
  float t = metricValue(res, gCfg.colorSrc);              // 0..1 chosen metric
  float loud = clampf(res.rms * 8.0f, 0.0f, 1.0f);

  switch (gCfg.effect) {
    case EFF_PULSE: {
      // Whole-screen brightness pulse; faster/deeper with loudness, flash on each syllable.
      static float phase = 0.0f;
      phase += 0.12f + 0.55f * loud;
      float s = 0.5f + 0.5f * sinf(phase);
      float v = (res.voiced ? 0.30f : 0.12f) * (0.55f + 0.45f * s) + 0.45f * res.syllableImpulse;
      tft->fillScreen(blendPal565(lo, hi, t, clampf(v, 0, 1)));
      break;
    }
    case EFF_GRADIENT: {
      // Vertical lo(bottom) -> hi(top) gradient, brightness from loudness; a white marker
      // line shows where the chosen metric currently sits.
      float v = res.voiced ? (0.30f + 0.70f * loud) : 0.15f;
      const int bands = 30, bandH = (SCR_H + bands - 1) / bands;
      for (int b = 0; b < bands; b++) {
        float frac = 1.0f - (float)b / (bands - 1);      // top = hi
        tft->fillRect(0, b * bandH, SCR_W, bandH, blendPal565(lo, hi, frac, v));
      }
      int my = TOP_MARGIN + (int)((1.0f - t) * USABLE_H);
      tft->drawFastHLine(0, my, SCR_W, TFT_WHITE);
      break;
    }
    case EFF_METER: {
      // Bottom-up level bar: fill height = chosen metric, in the high colour over a dim base.
      float v = res.voiced ? (0.40f + 0.60f * loud) : 0.20f;
      int top = SCR_H - (int)(clampf(t, 0, 1) * SCR_H);
      tft->fillRect(0, 0, SCR_W, top, blendPal565(lo, hi, 0.0f, 0.15f));
      tft->fillRect(0, top, SCR_W, SCR_H - top, blendPal565(lo, hi, 1.0f, v));
      break;
    }
    default: { // EFF_NONE
      float v = res.voiced ? (0.25f + 0.75f * loud) : 0.12f;
      tft->fillScreen(blendPal565(lo, hi, t, v));
      break;
    }
  }

  if (!gCfg.showHud) return;
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
// SETTINGS screen (paginated, item-based so it scales as options grow)
// ====================================================================
enum ItemId {
  IT_MODE, IT_SRC, IT_PRESET, IT_LO, IT_HI, IT_EFFECT,
  IT_HAPTIC, IT_HTHR, IT_AUTODIM, IT_BAND, IT_HUD, IT_ORB,
  IT_PAGE, IT_DONE
};
// Two pages of ~8 rows each.
static const uint8_t PAGE0[] = { IT_MODE, IT_SRC, IT_PRESET, IT_LO, IT_HI, IT_EFFECT, IT_PAGE, IT_DONE };
static const uint8_t PAGE1[] = { IT_HAPTIC, IT_HTHR, IT_AUTODIM, IT_BAND, IT_HUD, IT_ORB, IT_PAGE, IT_DONE };
static const uint8_t *PAGES[2] = { PAGE0, PAGE1 };
static const int PAGE_LEN[2] = { (int)(sizeof(PAGE0)), (int)(sizeof(PAGE1)) };
static int gPage = 0;
static const int ROW_Y0 = 30, ROW_DY = 24;

static void itemText(uint8_t id, char *out, size_t n) {
  switch (id) {
    case IT_MODE:    snprintf(out, n, "Mode: %s", MODE_NAMES[gCfg.mode]); break;
    case IT_SRC:     snprintf(out, n, "Color from: %s", SRC_NAMES[gCfg.colorSrc]); break;
    case IT_PRESET:  snprintf(out, n, "Preset: %s", PRESETS[gPreset].name); break;
    case IT_LO:      snprintf(out, n, "Low color: %s", PALETTE[gCfg.loColor].name); break;
    case IT_HI:      snprintf(out, n, "High color: %s", PALETTE[gCfg.hiColor].name); break;
    case IT_EFFECT:  snprintf(out, n, "Effect: %s", EFFECT_NAMES[gCfg.effect]); break;
    case IT_HAPTIC:  snprintf(out, n, "Haptics: %s", HAPTIC_NAMES[gCfg.haptic]); break;
    case IT_HTHR:    snprintf(out, n, "Haptic thr: %d%%", gCfg.hapticThr); break;
    case IT_AUTODIM: snprintf(out, n, "Auto-dim: %s", ONOFF[gCfg.autoDim ? 1 : 0]); break;
    case IT_BAND:    snprintf(out, n, "Target band: %s", ONOFF[gCfg.showBand ? 1 : 0]); break;
    case IT_HUD:     snprintf(out, n, "HUD text: %s", ONOFF[gCfg.showHud ? 1 : 0]); break;
    case IT_ORB:     snprintf(out, n, "Orb (BLE): %s", ONOFF[gCfg.orb ? 1 : 0]); break;
    case IT_PAGE:    snprintf(out, n, "%s", gPage == 0 ? "More settings >" : "< Back"); break;
    default:         snprintf(out, n, "* Done (save) *"); break;
  }
}

static void drawSettings() {
  TFT_eSPI *tft = ttgo->tft;
  tft->fillScreen(TFT_BLACK);
  tft->setTextDatum(TL_DATUM);
  tft->setTextColor(tft->color565(120, 200, 255), TFT_BLACK);
  char title[28];
  snprintf(title, sizeof(title), "Settings  %d/2", gPage + 1);
  tft->drawString(title, 12, 6, 2);
  char line[40];
  const uint8_t *items = PAGES[gPage];
  for (int i = 0; i < PAGE_LEN[gPage]; i++) {
    uint8_t id = items[i];
    itemText(id, line, sizeof(line));
    uint16_t c = (id == IT_DONE) ? TFT_GREEN : (id == IT_PAGE ? tft->color565(120, 200, 255) : TFT_WHITE);
    if (id == IT_LO || id == IT_HI) {
      int idx = (id == IT_LO) ? gCfg.loColor : gCfg.hiColor;
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
  if (i >= PAGE_LEN[gPage]) i = PAGE_LEN[gPage] - 1;
  switch (PAGES[gPage][i]) {
    case IT_MODE:    gCfg.mode = (gCfg.mode + 1) % 2; break;
    case IT_SRC:     gCfg.colorSrc = (gCfg.colorSrc + 1) % SRC_COUNT; break;
    case IT_PRESET:
      gPreset = (gPreset + 1) % N_PRESET;
      if (gPreset > 0) { gCfg.loColor = PRESETS[gPreset].lo; gCfg.hiColor = PRESETS[gPreset].hi; }
      break;
    case IT_LO:      gCfg.loColor = (gCfg.loColor + 1) % N_PAL; gPreset = 0; break;
    case IT_HI:      gCfg.hiColor = (gCfg.hiColor + 1) % N_PAL; gPreset = 0; break;
    case IT_EFFECT:  gCfg.effect = (gCfg.effect + 1) % EFF_COUNT; break;
    case IT_HAPTIC:  gCfg.haptic = (gCfg.haptic + 1) % 5; break;
    case IT_HTHR:    gCfg.hapticThr = (gCfg.hapticThr >= 75) ? 25 : gCfg.hapticThr + 25; break;
    case IT_AUTODIM: gCfg.autoDim = !gCfg.autoDim; break;
    case IT_BAND:    gCfg.showBand = !gCfg.showBand; break;
    case IT_HUD:     gCfg.showHud = !gCfg.showHud; break;
    case IT_ORB:     gCfg.orb = !gCfg.orb; break;
    case IT_PAGE:    gPage ^= 1; break;
    default:         return true; // Done
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
// BLE companion — the watch acts as a CLIENT and drives the LED orb
// (hardware/prosodyball_orb). Protocol must match prosodyball_orb.ino:
// service 5b1e0001-..., characteristic 5b1e0002-..., 5-byte [R,G,B,Res,Weight].
// ====================================================================
static BLEUUID ORB_SVC_UUID("5b1e0001-8a0e-4f1b-9c5a-2f3d4e5a6b7c");
static BLEUUID ORB_CHR_UUID("5b1e0002-8a0e-4f1b-9c5a-2f3d4e5a6b7c");

// Packet bytes recomputed each frame on core 1; read by the BLE task. Byte reads/writes are
// atomic on the ESP32, so an occasional torn frame just means one stale LED colour — harmless.
static volatile uint8_t gOrbR = 0, gOrbG = 0, gOrbB = 0, gOrbRes = 0, gOrbWgt = 128;
static volatile bool gOrbConnected = false;

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
  uint8_t R, G, B;
  if (gCfg.mode == MODE_COLOR)
    blendPalRGB(gCfg.loColor, gCfg.hiColor, metricValue(res, gCfg.colorSrc), 1.0f, &R, &G, &B);
  else
    hsvRGB(smoothHue, 0.9f, 1.0f, &R, &G, &B);
  gOrbR = R; gOrbG = G; gOrbB = B;
  gOrbRes = (uint8_t)(clampf(res.brightness, 0, 1) * 255);  // -> orb pulse rate/depth
  gOrbWgt = (uint8_t)(clampf(res.weight, 0, 1) * 255);      // -> orb body/baseline
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
  xTaskCreatePinnedToCore(bleTask, "ble", 8192, NULL, 1, NULL, 1);     // core 1, low prio

  tft->fillScreen(TFT_BLACK);
}

static void enterSettings() {
  gState = SETTINGS;
  drawSettings();
}
static void exitSettings() {
  saveSettings();
  gState = RUNNING;
  gPage = 0;                  // reopen at page 1 next time
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
  bool wantDim = gCfg.autoDim && (now - lastActivityMs) > DIM_AFTER_MS;
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
    renderBall(latest, inTarget, gCfg.showBand, gCfg.showHud);
  }

  // BLE companion: feed the orb the latest colour + a connection dot (top-right).
  if (gCfg.orb) {
    updateOrbPacket(latest);
    ttgo->tft->fillCircle(SCR_W - 9, 9, 5, gOrbConnected ? TFT_GREEN : ttgo->tft->color565(90, 90, 90));
  }

  delay(16);
}
