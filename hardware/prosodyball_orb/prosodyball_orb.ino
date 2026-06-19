#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEServer.h>
#include <NeoPixelBus.h>

#define OTA_HOSTNAME "prosodyball-orb"
#include "ota.h"

// --- HARDWARE CONFIG ---
#define DATA_PIN    4
#define NUM_LEDS    160

NeoPixelBus<NeoGrbFeature, NeoEsp32Rmt0Ws2812xMethod> strip(NUM_LEDS, DATA_PIN);

// --- BLE UUIDs ---
#define SERVICE_UUID        "5b1e0001-8a0e-4f1b-9c5a-2f3d4e5a6b7c"
#define CHARACTERISTIC_UUID "5b1e0002-8a0e-4f1b-9c5a-2f3d4e5a6b7c"

BLEServer* pServer = NULL;
bool deviceConnected = false;

struct ColorPacket { uint8_t r, g, b, res, wgt; };
QueueHandle_t colorQueue;

class ColorPacketCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
        String value = pCharacteristic->getValue();
        size_t n = value.length();
        if (n < 3) return;  // ignore malformed writes

        // 5 bytes [R,G,B,Res,Weight] is the current protocol. Older clients may
        // send 4 bytes (no weight) or 3 bytes (color only); fill neutral defaults
        // so the orb still animates sensibly: resonance 0 (calm), weight 128 (mid body).
        ColorPacket pkt = {
            (uint8_t)value[0],
            (uint8_t)value[1],
            (uint8_t)value[2],
            (n >= 4) ? (uint8_t)value[3] : (uint8_t)0,
            (n >= 5) ? (uint8_t)value[4] : (uint8_t)128
        };
        Serial.printf("Received -> R:%d G:%d B:%d Res:%d Wgt:%d (len=%u)\n",
                      pkt.r, pkt.g, pkt.b, pkt.res, pkt.wgt, (unsigned)n);
        xQueueSend(colorQueue, &pkt, 0);
    }
};

// Global animation state
uint8_t targetR = 0;
uint8_t targetG = 0;
uint8_t targetB = 0;
uint8_t targetRes = 0;
uint8_t targetWgt = 128;   // vocal weight 0=light .. 255=heavy; mid until first packet

class ServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
        deviceConnected = true;
        Serial.println(">>> App Connected via Bluetooth!");
    }
    void onDisconnect(BLEServer* pServer) {
        deviceConnected = false;
        Serial.println(">>> App Disconnected.");
    }
};

RgbColor adjustColor(uint8_t r, uint8_t g, uint8_t b) {
    float gamma = 2.2f;
    uint8_t cr = (uint8_t)(powf((float)r / 255.0f, gamma) * 255.0f);
    uint8_t cg = (uint8_t)(powf((float)g / 255.0f, gamma) * 255.0f);
    uint8_t cb = (uint8_t)(powf((float)b / 255.0f, gamma) * 255.0f);

    // Scale green and blue to prevent washing out red (green: 60%, blue: 80%)
    cg = (uint8_t)(cg * 0.60f);
    cb = (uint8_t)(cb * 0.80f);

    return RgbColor(cr, cg, cb);
}

void setup() {
    Serial.begin(115200);
    colorQueue = xQueueCreate(5, sizeof(ColorPacket));

    strip.Begin();

    // Boot splash: Soft Teal
    RgbColor teal = adjustColor(0, 150, 150);
    for (int i = 0; i < NUM_LEDS; i++) strip.SetPixelColor(i, teal);
    strip.Show();
    delay(1000);

    BLEDevice::init("ProsodyBall-Orb");
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());

    BLEService *pService = pServer->createService(SERVICE_UUID);
    BLECharacteristic *pCharacteristic = pService->createCharacteristic(
        CHARACTERISTIC_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    pCharacteristic->setCallbacks(new ColorPacketCallbacks());
    pService->start();
    pServer->getAdvertising()->start();

    Serial.println("BLE Active. Broadcasting as: 'ProsodyBall-Orb'");

    otaSetup();
}

void loop() {
    otaLoop();

    ColorPacket pkt;
    if (xQueueReceive(colorQueue, &pkt, 0)) {
        targetR = pkt.r;
        targetG = pkt.g;
        targetB = pkt.b;
        targetRes = pkt.res;
        targetWgt = pkt.wgt;
    }

    // ====================================================================
    // ANIMATION ENGINE — whole-globe resonance PULSE + weight body
    // --------------------------------------------------------------------
    // Resonance (0..1, dark..bright) -> a whole-globe pulse/blink. A
    //   brighter voice pulses FASTER and DEEPER; a darker voice is a slow,
    //   shallow throb. A uniform brightness pulse is the most diffuser-proof
    //   cue there is, so it stays obvious through the frosted globe.
    // Weight (0..1) -> baseline brightness ("body") plus a mild calming of
    //   the pulse: heavy = fuller and steadier, light = dimmer and livelier.
    // ====================================================================

    // ---- Tunable feel (grouped so you never hunt through the math) ----
    const float PULSE_SPEED_MIN   = 0.0025f; // pulse rate (rad/ms) at dark resonance  (~2.5 s period, slow throb)
    const float PULSE_SPEED_MAX   = 0.0130f; // pulse rate (rad/ms) at bright resonance (~0.5 s period, fast blink)
    const float PULSE_DEPTH_MIN   = 0.15f;   // brightness dip at dark resonance   (gentle, 0..1)
    const float PULSE_DEPTH_MAX   = 0.70f;   // brightness dip at bright resonance (deep blink, 0..1; raise toward 0.9 for near-off troughs)
    const float PULSE_SHAPE       = 1.0f;    // waveform: 1 = smooth pulse; >1 = blinkier (quick flash, longer dark)
    const float BASE_BRIGHT_LIGHT = 0.55f;   // baseline brightness for the lightest voice (weight 0)
    const float BASE_BRIGHT_HEAVY = 0.95f;   // baseline brightness for the heaviest voice (weight 1)
    const float STEADINESS_MAX    = 0.35f;   // how much full weight calms the pulse depth (0 = none, 1 = flat)
    const float MULT_CEILING      = 1.00f;   // hard clamp on final multiplier -> never exceeds the old peak power

    uint32_t t = millis();
    float res = targetRes / 255.0f;          // 0..1 resonance (0 = dark, 1 = bright)
    float wgt = targetWgt / 255.0f;          // 0..1 weight    (0 = light, 1 = heavy)

    // WEIGHT -> baseline brightness ("body") + a mild steadiness.
    float baseline   = BASE_BRIGHT_LIGHT + (BASE_BRIGHT_HEAVY - BASE_BRIGHT_LIGHT) * wgt;
    float steadiness = STEADINESS_MAX * wgt;                          // heavier = a touch calmer

    // RESONANCE -> pulse rate and depth (brighter resonance = faster + deeper).
    float pulseSpeed = PULSE_SPEED_MIN + (PULSE_SPEED_MAX - PULSE_SPEED_MIN) * res;
    float pulseDepth = (PULSE_DEPTH_MIN + (PULSE_DEPTH_MAX - PULSE_DEPTH_MIN) * res) * (1.0f - steadiness);

    // One global pulse for the whole globe (uniform -> maximally diffuser-proof).
    float s = sinf(t * pulseSpeed) * 0.5f + 0.5f;    // 0..1 raw sine
    s = powf(s, PULSE_SHAPE);                         // 1 = smooth; >1 = blinkier
    float pulse = 1.0f - pulseDepth * (1.0f - s);     // dips from baseline toward dim

    float mult = baseline * pulse;
    if (mult > MULT_CEILING) mult = MULT_CEILING;     // power-safe clamp
    if (mult < 0.0f) mult = 0.0f;

    RgbColor baseColor = adjustColor(targetR, targetG, targetB);
    RgbColor outColor = RgbColor((uint8_t)(baseColor.R * mult),
                                 (uint8_t)(baseColor.G * mult),
                                 (uint8_t)(baseColor.B * mult));

    for (int i = 0; i < NUM_LEDS; i++) {
        strip.SetPixelColor(i, outColor);
    }
    strip.Show();

    if (!deviceConnected) {
        delay(500);
        pServer->getAdvertising()->start();
        Serial.println("Re-advertising...");
        deviceConnected = true;
    }

    delay(10);
}
