/**
 * ProsodyBall — standalone Vox Ball for the LilyGo T-Watch 2020 V3
 * ----------------------------------------------------------------
 * A self-contained wearable port of the web app's flagship "Vox Ball" mode. The watch
 * captures its OWN voice from the V3's PDM microphone, runs pitch + energy DSP on-device
 * (see dsp.cpp — a faithful port of app.js / dsp-utils.js), and renders the ball locally
 * on the 240x240 screen. No phone, no browser, no BLE.
 *
 *   pitch  -> ball's vertical position (high voice = ball rises) and hue (low=blue, high=pink)
 *   syllable onsets -> the ball hops; the hop is taller when your intonation is livelier
 *
 * Audio capture + DSP run on core 0; rendering/physics run on core 1 (the Arduino loop),
 * decoupled through a 1-slot queue — the same producer/consumer shape as the orb sketch.
 *
 * Requires (Arduino IDE): "esp32" boards package + "TTGO TWatch Library" (Library Manager).
 * Tap the screen any time to re-run noise-floor calibration when you change rooms.
 */
#include "config.h"          // selects LILYGO_WATCH_2020_V3 then includes <LilyGoWatch.h>
#include <driver/i2s.h>
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
// Rendering — runs on core 1 (Arduino loop)
// ====================================================================
// Screen mapping: pos 0..1 (1 = top). margins keep the ball fully on-screen.
static const int SCR_W = 240, SCR_H = 240;
static const int TOP_MARGIN = 34, BOT_MARGIN = 46; // bottom leaves room for the Hz HUD
static const int USABLE_H = SCR_H - TOP_MARGIN - BOT_MARGIN;

// Ball physics state.
static float ballPos = 0.5f, ballVel = 0.0f; // pitch-tracked baseline height
static float bounceY = 0.0f, bounceVel = 0.0f; // syllable hop on top of the baseline
static float prevImpulse = 0.0f;
static float smoothHue = 270.0f;
static float smoothR = 18.0f;

// --- Pitch-target training band ---
// The user trains toward a pitch range: the ball glows and the motor buzzes when their
// voice sits inside the band. Default to the androgynous zone (~145-175 Hz) the web app
// references; shift it with the top/bottom touch zones. Band width is held constant.
static float targetLoHz = 145.0f, targetHiHz = 175.0f;
static const float TARGET_STEP_HZ = 5.0f;   // per tap
static bool  prevInTarget = false;

// Session stats (seconds), for a "% of voiced time on target" readout.
static float voicedTime = 0.0f, inTargetTime = 0.0f;

// Previous ball footprint, so we can erase exactly what we drew (memory-safe, no sprite).
static int prevX = -1, prevY = -1, prevR = 0;

static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// HSV (h in deg, s/v in 0..1) -> RGB565 for TFT_eSPI.
static uint16_t hsv565(float h, float s, float v) {
  h = fmodf(h, 360.0f); if (h < 0) h += 360.0f;
  float c = v * s;
  float x = c * (1 - fabsf(fmodf(h / 60.0f, 2.0f) - 1));
  float m = v - c;
  float r, g, b;
  if      (h < 60)  { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  uint8_t R = (uint8_t)((r + m) * 255), G = (uint8_t)((g + m) * 255), B = (uint8_t)((b + m) * 255);
  return ttgo->tft->color565(R, G, B);
}

static void updatePhysics(const VoxResult &res, float dt) {
  dt = clampf(dt, 0.0f, 0.05f); // guard against long stalls

  // Baseline height springs toward the current pitch position (rest mid-screen if silent).
  float target = res.voiced ? res.pitchPos : 0.5f;
  const float K = 14.0f, DAMP = 7.0f;
  ballVel += (target - ballPos) * K * dt;
  ballVel -= ballVel * DAMP * dt;
  ballPos = clampf(ballPos + ballVel * dt, 0.0f, 1.0f);

  // Each syllable onset kicks an upward hop; livelier intonation -> taller hop.
  if (res.syllableImpulse > 0.6f && prevImpulse <= 0.6f) {
    bounceVel += 1.6f * (0.35f + 0.65f * res.bounce);
  }
  prevImpulse = res.syllableImpulse;
  bounceVel -= 6.0f * dt;                 // gravity
  bounceY = bounceY + bounceVel * dt;
  if (bounceY < 0.0f) { bounceY = 0.0f; bounceVel = 0.0f; }
  if (bounceY > 0.45f) { bounceY = 0.45f; }  // cap the hop

  // Hue follows pitch (blue low -> pink high), matching the web app's pitch ramp.
  float hueTarget = res.voiced ? (210.0f + clampf(res.pitchPos, 0, 1) * 130.0f) : 270.0f;
  smoothHue += (hueTarget - smoothHue) * 0.25f;

  // Radius breathes a little with loudness.
  float rTarget = 14.0f + 24.0f * clampf(res.rms * 8.0f, 0.0f, 1.0f);
  smoothR += (rTarget - smoothR) * 0.3f;
}

// Map a pitch in Hz to a screen Y, consistent with the ball's pitchPos mapping.
static int hzToY(float hz) {
  float pos = clampf((hz - VOX_PITCH_MIN_HZ) / (VOX_PITCH_MAX_HZ - VOX_PITCH_MIN_HZ), 0, 1);
  return TOP_MARGIN + (int)((1.0f - pos) * USABLE_H);
}

// Dashed horizontal line across the play area (used for the target band edges).
static void dashedHLine(int y, uint16_t color) {
  TFT_eSPI *tft = ttgo->tft;
  for (int x = 8; x < SCR_W - 8; x += 12) tft->drawFastHLine(x, y, 7, color);
}

static void render(const VoxResult &res, bool inTarget) {
  TFT_eSPI *tft = ttgo->tft;

  float renderPos = clampf(ballPos + bounceY, 0.0f, 1.0f);
  int x = SCR_W / 2;
  int y = TOP_MARGIN + (int)((1.0f - renderPos) * USABLE_H);
  int r = (int)smoothR;

  // In-target voices glow brighter; off-target dims a touch so the goal reads clearly.
  float base = res.voiced ? (0.45f + 0.55f * clampf(res.confidence, 0, 1)) : 0.22f;
  float val = inTarget ? clampf(base + 0.25f, 0, 1) : base;
  uint16_t color = hsv565(smoothHue, 0.9f, val);

  // Erase the previous ball (and its glow ring), then repaint the target band so the
  // erase can't leave a gap where the ball crossed a band line.
  if (prevX >= 0) tft->fillCircle(prevX, prevY, prevR + 3, TFT_BLACK);

  // When the band moves (on a tap), clear the old line rows so they don't ghost.
  static int prevYLo = -1, prevYHi = -1;
  int yLo = hzToY(targetLoHz), yHi = hzToY(targetHiHz);
  if (prevYLo >= 0 && (prevYLo != yLo || prevYHi != yHi)) {
    tft->drawFastHLine(0, prevYLo, SCR_W, TFT_BLACK);
    tft->drawFastHLine(0, prevYHi, SCR_W, TFT_BLACK);
  }
  prevYLo = yLo; prevYHi = yHi;

  uint16_t bandColor = inTarget ? TFT_GREEN : tft->color565(70, 90, 80);
  dashedHLine(yHi, bandColor);
  dashedHLine(yLo, bandColor);

  tft->fillCircle(x, y, r, color);
  if (inTarget) tft->drawCircle(x, y, r + 3, TFT_GREEN); // glow ring
  prevX = x; prevY = y; prevR = r;

  // HUD: pitch + target band + % of voiced time spent on target.
  tft->fillRect(0, SCR_H - BOT_MARGIN + 6, SCR_W, BOT_MARGIN - 6, TFT_BLACK);
  tft->setTextDatum(MC_DATUM);
  tft->setTextColor(TFT_WHITE, TFT_BLACK);
  char line[40];
  if (gDsp.calibrating()) {
    tft->drawString("Calibrating... stay quiet", SCR_W / 2, SCR_H - 24, 2);
  } else {
    if (res.voiced) snprintf(line, sizeof(line), "%d Hz", (int)(res.pitchHz + 0.5f));
    else            snprintf(line, sizeof(line), "--");
    tft->setTextColor(inTarget ? TFT_GREEN : TFT_WHITE, TFT_BLACK);
    tft->drawString(line, SCR_W / 2, SCR_H - 30, 4);

    int pct = voicedTime > 0.2f ? (int)(100.0f * inTargetTime / voicedTime + 0.5f) : 0;
    snprintf(line, sizeof(line), "target %d-%d Hz   on-target %d%%",
             (int)targetLoHz, (int)targetHiHz, pct);
    tft->setTextColor(tft->color565(160, 180, 170), TFT_BLACK);
    tft->drawString(line, SCR_W / 2, SCR_H - 10, 2);
  }
}

// ====================================================================
void setup() {
  Serial.begin(115200);

  ttgo = TTGOClass::getWatch();
  ttgo->begin();        // inits AXP202 PMU, ST7789 display, touch
  ttgo->openBL();       // backlight on
  ttgo->motor_begin();  // vibration motor — haptic "on-target" feedback

  TFT_eSPI *tft = ttgo->tft;
  tft->setRotation(0);
  tft->fillScreen(TFT_BLACK);

  // Boot splash: soft teal across the screen — mirrors the orb sketch's power-on
  // self-test so you can confirm display + board bring-up before speaking.
  tft->fillScreen(tft->color565(0, 150, 150));
  delay(800);
  tft->fillScreen(TFT_BLACK);
  tft->setTextDatum(MC_DATUM);
  tft->setTextColor(TFT_WHITE, TFT_BLACK);
  tft->drawString("Vox Ball", SCR_W / 2, SCR_H / 2 - 12, 4);
  tft->drawString("calibrating mic...", SCR_W / 2, SCR_H / 2 + 16, 2);

  initMic();

  gResultQueue = xQueueCreate(1, sizeof(VoxResult));
  xTaskCreatePinnedToCore(audioTask, "audio", 8192, NULL, 2, NULL, 0); // core 0

  tft->fillScreen(TFT_BLACK);
}

void loop() {
  static VoxResult latest = {};
  static uint32_t lastMs = 0;
  static bool touchedPrev = false;

  // Pull the freshest analysis frame (non-blocking; keep last if none arrived).
  VoxResult got;
  if (xQueueReceive(gResultQueue, &got, 0) == pdTRUE) latest = got;

  // Touch zones (rising edge only):
  //   top third    -> raise the target band
  //   bottom third -> lower the target band
  //   middle third -> recalibrate the noise floor
  int16_t tx, ty;
  bool touched = ttgo->getTouch(tx, ty);
  if (touched && !touchedPrev) {
    if (ty < SCR_H / 3) {
      targetLoHz = clampf(targetLoHz + TARGET_STEP_HZ, VOX_PITCH_MIN_HZ, VOX_PITCH_MAX_HZ - 10);
      targetHiHz = clampf(targetHiHz + TARGET_STEP_HZ, VOX_PITCH_MIN_HZ + 10, VOX_PITCH_MAX_HZ);
    } else if (ty > 2 * SCR_H / 3) {
      targetLoHz = clampf(targetLoHz - TARGET_STEP_HZ, VOX_PITCH_MIN_HZ, VOX_PITCH_MAX_HZ - 10);
      targetHiHz = clampf(targetHiHz - TARGET_STEP_HZ, VOX_PITCH_MIN_HZ + 10, VOX_PITCH_MAX_HZ);
    } else {
      gRecalRequest = true;
      voicedTime = inTargetTime = 0.0f; // also resets the session score
    }
  }
  touchedPrev = touched;

  uint32_t now = millis();
  float dt = lastMs ? (now - lastMs) / 1000.0f : 0.016f;
  lastMs = now;

  // In-target detection + session stats + haptic reinforcement on entry.
  bool inTarget = latest.voiced &&
                  latest.pitchHz >= targetLoHz && latest.pitchHz <= targetHiHz;
  if (latest.voiced) {
    voicedTime += dt;
    if (inTarget) inTargetTime += dt;
  }
  if (inTarget && !prevInTarget) ttgo->motor->onec(); // buzz once when you hit the band
  prevInTarget = inTarget;

  updatePhysics(latest, dt);
  render(latest, inTarget);

  delay(16); // ~60 fps cap; physics/erase-draw is cheap
}
