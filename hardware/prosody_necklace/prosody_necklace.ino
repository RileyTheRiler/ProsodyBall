/**
 * ProsodyBall Necklace — standalone haptic prosody trainer
 * ----------------------------------------------------------
 * Self-contained pendant: captures the wearer's OWN voice from the onboard PDM
 * microphone, runs pitch + resonance + vocal-weight DSP on-device (dsp.cpp — the
 * same hardware-agnostic port of app.js / dsp-utils.js used by hardware/twatch_voxball),
 * and buzzes a vibration motor whenever the selected metric drifts OUTSIDE a trained
 * target. No phone needed for the core loop.
 *
 * Trigger direction (important — opposite of the T-Watch's HAP_ONTARGET mode, which
 * rewards *entering* the good zone with one ping): this is a corrective nudge, so it
 * buzzes repeatedly (throttled by a cooldown) for as long as the wearer stays outside
 * their target, and stays silent while they're in range or not speaking.
 *   - Pitch    : in range while pitchHz sits inside [targetLoHz, targetHiHz].
 *   - Resonance: in range while res.resonance <= hapticThr (don't exceed the cap).
 *   - Weight   : in range while res.weight <= hapticThr (don't exceed the cap).
 *
 * A small BLE GATT service lets the ProsodyBall web app (necklace-controller.js)
 * push calibration (which metric to train, and its target band/threshold) and read
 * back live session stats — but the necklace decides on its own when to buzz.
 *
 * Audio + DSP run on core 0; haptic eval + BLE + status LED run on core 1 (Arduino
 * loop), decoupled by a 1-slot queue — the same producer/consumer shape used by
 * hardware/twatch_voxball.
 *
 * Requires (Arduino IDE): "esp32" boards package (with Seeed XIAO ESP32S3 board
 * support installed via Boards Manager) + the "Adafruit NeoPixel" library.
 */
#include "config.h"
#include <driver/i2s.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include <Adafruit_NeoPixel.h>
#include "dsp.h"

// --- cross-core handoff ---
static QueueHandle_t gResultQueue;      // length 1, overwritten with the latest frame
static VoxDsp        gDsp;              // owned by the audio task (core 0)
static volatile bool gRecalRequest = false;

static Adafruit_NeoPixel statusLed(1, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);

static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// ====================================================================
// Persisted settings (NVS) — trimmed version of the T-Watch's Settings struct,
// with no display-related fields.
// ====================================================================
enum HapticSrc { HSRC_PITCH = 0, HSRC_RESONANCE, HSRC_WEIGHT, HSRC_COUNT };

struct NecklaceSettings {
  uint8_t  hapticSrc    = HSRC_PITCH;  // which metric drives the buzz trigger
  uint8_t  hapticThr    = 50;          // % cap, used by RESONANCE/WEIGHT modes
  uint16_t targetLoHz   = 145;         // pitch-mode target band (matches the T-Watch default)
  uint16_t targetHiHz   = 175;
  uint8_t  cooldownMs10 = 25;          // min ms between buzzes, in 10ms steps (250ms default)
};
static NecklaceSettings gCfg;
static Preferences      gPrefs;

// Clamp every persisted field to its valid range — NVS can return stale/corrupt
// values (e.g. after a firmware change).
static void sanitizeSettings() {
  if (gCfg.hapticSrc >= HSRC_COUNT) gCfg.hapticSrc = HSRC_PITCH;
  if (gCfg.hapticThr > 100) gCfg.hapticThr = 50;
  const uint16_t minHz = (uint16_t)VOX_PITCH_MIN_HZ, maxHz = (uint16_t)VOX_PITCH_MAX_HZ;
  if (gCfg.targetLoHz < minHz || gCfg.targetLoHz > maxHz - 10) gCfg.targetLoHz = 145;
  if (gCfg.targetHiHz < minHz + 10 || gCfg.targetHiHz > maxHz) gCfg.targetHiHz = 175;
  if (gCfg.targetHiHz < gCfg.targetLoHz + 10) gCfg.targetHiHz = gCfg.targetLoHz + 10;
  if (gCfg.cooldownMs10 == 0) gCfg.cooldownMs10 = 25;
}

static void loadSettings() {
  gPrefs.begin("necklace", true);
  gCfg.hapticSrc    = gPrefs.getUChar("hsrc", gCfg.hapticSrc);
  gCfg.hapticThr    = gPrefs.getUChar("hthr", gCfg.hapticThr);
  gCfg.targetLoHz   = gPrefs.getUShort("tlo", gCfg.targetLoHz);
  gCfg.targetHiHz   = gPrefs.getUShort("thi", gCfg.targetHiHz);
  gCfg.cooldownMs10 = gPrefs.getUChar("cool", gCfg.cooldownMs10);
  gPrefs.end();
  sanitizeSettings();
}
static void saveSettings() {
  gPrefs.begin("necklace", false);
  gPrefs.putUChar("hsrc", gCfg.hapticSrc);
  gPrefs.putUChar("hthr", gCfg.hapticThr);
  gPrefs.putUShort("tlo", gCfg.targetLoHz);
  gPrefs.putUShort("thi", gCfg.targetHiHz);
  gPrefs.putUChar("cool", gCfg.cooldownMs10);
  gPrefs.end();
}

// ====================================================================
// Audio capture + DSP — runs on core 0 (identical shape to twatch_voxball's audioTask)
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
  pin_cfg.ws_io_num    = MIC_CLOCK_PIN;
  pin_cfg.data_out_num = I2S_PIN_NO_CHANGE;
  pin_cfg.data_in_num  = MIC_DATA_PIN;

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
// Haptic decision — "in range" per the selected metric; the caller buzzes
// for as long as this is false (see evalHaptic below).
// ====================================================================
static bool isInRange(const VoxResult &res) {
  if (!res.voiced) return true; // don't judge silence — only while actually speaking
  float thr = gCfg.hapticThr / 100.0f;
  switch (gCfg.hapticSrc) {
    case HSRC_RESONANCE: return res.resonance <= thr;
    case HSRC_WEIGHT:    return res.weight <= thr;
    default:             return res.pitchHz >= gCfg.targetLoHz && res.pitchHz <= gCfg.targetHiHz; // HSRC_PITCH
  }
}

// 0..1 reading of whichever metric is currently selected — used for the
// status notification's live readout.
static float metricValue01(const VoxResult &res) {
  switch (gCfg.hapticSrc) {
    case HSRC_RESONANCE: return res.resonance;
    case HSRC_WEIGHT:    return res.weight;
    default:             return res.pitchPos; // HSRC_PITCH
  }
}

// Buzzes once per cooldown window for as long as the wearer stays outside their
// trained target. Unlike the T-Watch's HAP_ONTARGET (one reward ping on entry),
// this is a recurring corrective nudge, so there's no rising-edge gate — only the
// cooldown throttle.
static bool evalHaptic(bool inRange, uint32_t nowMs) {
  static uint32_t lastBuzzMs = 0;
  if (inRange) return false;
  uint32_t cooldownMs = (uint32_t)gCfg.cooldownMs10 * 10;
  if (nowMs - lastBuzzMs < cooldownMs) return false;
  lastBuzzMs = nowMs;
  return true;
}

// ====================================================================
// Vibration motor — non-blocking one-shot (no delay(), so it never stalls
// the audio/BLE work happening in the same loop()).
// ====================================================================
static uint32_t gMotorOffAtMs = 0;

static void buzzMotor(uint32_t nowMs, uint16_t ms = 60) {
  digitalWrite(MOTOR_GATE_PIN, HIGH);
  gMotorOffAtMs = nowMs + ms;
}
static void serviceMotor(uint32_t nowMs) {
  if (gMotorOffAtMs && nowMs >= gMotorOffAtMs) {
    digitalWrite(MOTOR_GATE_PIN, LOW);
    gMotorOffAtMs = 0;
  }
}

// ====================================================================
// BLE GATT server — peripheral role (the necklace IS the device the phone
// connects to), unlike the T-Watch's BLE *client* mode that drives the orb.
// ====================================================================
#define NECKLACE_SERVICE_UUID     "5b1e0010-8a0e-4f1b-9c5a-2f3d4e5a6b7c"
#define NECKLACE_CALIB_CHAR_UUID  "5b1e0011-8a0e-4f1b-9c5a-2f3d4e5a6b7c"
#define NECKLACE_STATUS_CHAR_UUID "5b1e0012-8a0e-4f1b-9c5a-2f3d4e5a6b7c"

static BLEServer *gBleServer = nullptr;
static BLECharacteristic *gStatusChar = nullptr;
static volatile bool gBleConnected = false;

class NecklaceServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { gBleConnected = true; }
  void onDisconnect(BLEServer *) override {
    gBleConnected = false;
    BLEDevice::startAdvertising(); // resume advertising so the phone can reconnect
  }
};

// Calibration packet, 6 bytes: [hapticSrc, hapticThr, targetLoHz LE u16, targetHiHz LE u16].
// Fixed-length, no variable-length parsing — this is a brand-new protocol with no
// legacy clients to support.
class CalibCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *ch) override {
    String v = ch->getValue();
    if (v.length() < 6) return; // ignore malformed writes
    gCfg.hapticSrc  = (uint8_t)v[0];
    gCfg.hapticThr  = (uint8_t)v[1];
    gCfg.targetLoHz = (uint16_t)((uint8_t)v[2] | ((uint16_t)(uint8_t)v[3] << 8));
    gCfg.targetHiHz = (uint16_t)((uint8_t)v[4] | ((uint16_t)(uint8_t)v[5] << 8));
    sanitizeSettings();
    saveSettings();
    gRecalRequest = true; // re-run noise-floor calibration now that we're freshly paired
  }
};

static void initBle() {
  BLEDevice::init("ProsodyBall-Necklace");
  gBleServer = BLEDevice::createServer();
  gBleServer->setCallbacks(new NecklaceServerCallbacks());

  BLEService *svc = gBleServer->createService(NECKLACE_SERVICE_UUID);

  BLECharacteristic *calibChar = svc->createCharacteristic(
      NECKLACE_CALIB_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE);
  calibChar->setCallbacks(new CalibCallbacks());

  gStatusChar = svc->createCharacteristic(
      NECKLACE_STATUS_CHAR_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  gStatusChar->addDescriptor(new BLE2902());

  svc->start();
  gBleServer->getAdvertising()->addServiceUUID(NECKLACE_SERVICE_UUID);
  gBleServer->getAdvertising()->start();
  Serial.println("BLE active. Broadcasting as: 'ProsodyBall-Necklace'");
}

// Status packet, 8 bytes: [flags, onTargetPct, voicedSeconds LE u16,
// currentMetricVal, batteryPct, reserved, reserved]. Throttled to ~1 Hz by the caller.
static void sendStatusNotify(const VoxResult &latest, bool micOk, uint16_t voicedSeconds,
                              uint8_t onTargetPct) {
  if (!gBleConnected || !gStatusChar) return;
  uint8_t flags = 0;
  if (micOk) flags |= 0x01;
  if (gDsp.calibrating()) flags |= 0x02;
  flags |= 0x04; // sessionActive — always true while the firmware is running
  uint8_t metricVal = (uint8_t)(clampf(metricValue01(latest), 0.0f, 1.0f) * 100.0f + 0.5f);
  uint8_t pkt[8] = {
    flags,
    onTargetPct,
    (uint8_t)(voicedSeconds & 0xff), (uint8_t)((voicedSeconds >> 8) & 0xff),
    metricVal,
    0xFF, // batteryPct — not available on this board revision (see README)
    0, 0, // reserved
  };
  gStatusChar->setValue(pkt, 8);
  gStatusChar->notify();
}

// ====================================================================
void setup() {
  Serial.begin(115200);
  loadSettings();

  pinMode(MOTOR_GATE_PIN, OUTPUT);
  digitalWrite(MOTOR_GATE_PIN, LOW);

  statusLed.begin();
  statusLed.setBrightness(60);
  statusLed.setPixelColor(0, statusLed.Color(0, 150, 150)); // boot teal — mirrors the
  statusLed.show();                                          // orb/watch self-test
  delay(800);

  bool micOk = initMic();
  gResultQueue = xQueueCreate(1, sizeof(VoxResult));
  BaseType_t audioOk = (micOk && gResultQueue)
      ? xTaskCreatePinnedToCore(audioTask, "audio", 8192, NULL, 2, NULL, 0) // core 0
      : pdFAIL;

  initBle();

  if (!micOk || !gResultQueue || audioOk != pdPASS) {
    statusLed.setPixelColor(0, statusLed.Color(150, 0, 0)); // red: startup failed
    statusLed.show();
    Serial.println("Startup failed (mic or audio task).");
    for (;;) delay(1000);
  }

  statusLed.setPixelColor(0, statusLed.Color(20, 20, 20)); // dim white: idle/running
  statusLed.show();
  Serial.println("ProsodyBall Necklace ready.");
}

void loop() {
  static VoxResult latest = {};
  static uint32_t lastMs = 0, lastStatusMs = 0;
  static float voicedTime = 0.0f, inTargetTime = 0.0f;
  static uint32_t ledFlashUntilMs = 0;

  VoxResult got;
  if (xQueueReceive(gResultQueue, &got, 0) == pdTRUE) latest = got;

  uint32_t now = millis();
  float dt = lastMs ? (now - lastMs) / 1000.0f : 0.064f;
  lastMs = now;

  bool inRange = isInRange(latest);
  if (latest.voiced) { voicedTime += dt; if (inRange) inTargetTime += dt; }

  if (evalHaptic(inRange, now)) {
    buzzMotor(now);
    statusLed.setPixelColor(0, statusLed.Color(150, 40, 0)); // amber flash: "you're outside your range"
    statusLed.show();
    ledFlashUntilMs = now + 150;
  }
  if (ledFlashUntilMs && now >= ledFlashUntilMs) {
    statusLed.setPixelColor(0, gBleConnected ? statusLed.Color(0, 0, 90) : statusLed.Color(20, 20, 20));
    statusLed.show();
    ledFlashUntilMs = 0;
  }
  serviceMotor(now);

  if (now - lastStatusMs >= 1000) {
    lastStatusMs = now;
    uint8_t pct = voicedTime > 1.0f ? (uint8_t)(100.0f * inTargetTime / voicedTime + 0.5f) : 0;
    uint16_t vSec = (uint16_t)fminf(voicedTime, 65535.0f);
    sendStatusNotify(latest, true, vSec, pct);
  }

  delay(16);
}
