#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEServer.h>
#include <NeoPixelBus.h>

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
}

void loop() {
    ColorPacket pkt;
    if (xQueueReceive(colorQueue, &pkt, 0)) {
        targetR = pkt.r;
        targetG = pkt.g;
        targetB = pkt.b;
        targetRes = pkt.res;
        targetWgt = pkt.wgt;
    }

    // ====================================================================
    // ANIMATION ENGINE — coherent traveling wave + breath + weight body
    // --------------------------------------------------------------------
    // Resonance (0..1) -> a large-wavelength sine that SWEEPS across the
    //   strip, so it survives opal-glass diffusion (random per-pixel noise
    //   does not — the diffuser averages it into a flat field).
    // Weight (0..1)    -> baseline brightness + steadiness: heavy = fuller
    //   and calmer, light = dimmer and free to flutter.
    // Wave and breath oscillate around 1.0, so a more resonant voice never
    //   makes the globe dimmer on average.
    // ====================================================================

    // ---- Tunable feel (grouped so you never hunt through the math) ----
    const float WAVE_SPATIAL_FREQ = 0.10f;   // rad/LED; 2pi/0.10 ~ 63-LED wavelength (~2.5 waves across 160). Lower = broader, more diffusion-proof.
    const float WAVE_SPEED_MIN    = 0.0010f; // wave travel speed (rad/ms) at zero resonance
    const float WAVE_SPEED_MAX    = 0.0060f; // wave travel speed at full resonance
    const float WAVE_AMP_MAX      = 0.22f;   // peak +/- brightness swing of the wave (full resonance, zero weight)
    const float BREATH_SPEED_MIN  = 0.0015f; // global breath speed (rad/ms) at zero resonance
    const float BREATH_SPEED_MAX  = 0.0050f; // global breath speed at full resonance
    const float BREATH_DEPTH_MAX  = 0.10f;   // peak +/- breath swing at full resonance
    const float BASE_BRIGHT_LIGHT = 0.55f;   // baseline brightness for the lightest voice (weight 0)
    const float BASE_BRIGHT_HEAVY = 0.95f;   // baseline brightness for the heaviest voice (weight 1)
    const float STEADINESS_MAX    = 0.85f;   // how much full weight DAMPENS the wave (1 = kill wave, 0 = none)
    const float MULT_CEILING      = 1.00f;   // hard clamp on final multiplier -> never exceeds the old peak power

    uint32_t t = millis();
    float res = targetRes / 255.0f;          // 0..1 resonance
    float wgt = targetWgt / 255.0f;          // 0..1 weight (0 = light, 1 = heavy)

    // WEIGHT -> baseline brightness ("body") + steadiness (wave damping).
    float baseline   = BASE_BRIGHT_LIGHT + (BASE_BRIGHT_HEAVY - BASE_BRIGHT_LIGHT) * wgt;
    float steadiness = STEADINESS_MAX * wgt;                          // heavier = calmer

    // RESONANCE -> wave & breath parameters (both oscillate around 1.0).
    float waveSpeed   = WAVE_SPEED_MIN   + (WAVE_SPEED_MAX   - WAVE_SPEED_MIN)   * res;
    float breathSpeed = BREATH_SPEED_MIN + (BREATH_SPEED_MAX - BREATH_SPEED_MIN) * res;
    float waveAmp     = WAVE_AMP_MAX     * res * (1.0f - steadiness); // weight calms the wave
    float breathDepth = BREATH_DEPTH_MAX * res;

    // Global breath (same for every pixel) — computed once per frame.
    float breath    = 1.0f + breathDepth * sinf(t * breathSpeed);
    float wavePhase = t * waveSpeed;

    RgbColor baseColor = adjustColor(targetR, targetG, targetB);

    for (int i = 0; i < NUM_LEDS; i++) {
        // Spatially-COHERENT wave: neighbors differ by only WAVE_SPATIAL_FREQ rad,
        // so the pattern reads as one moving glow through the frosted globe.
        float wave = 1.0f + waveAmp * sinf(i * WAVE_SPATIAL_FREQ - wavePhase);

        float mult = baseline * breath * wave;
        if (mult > MULT_CEILING) mult = MULT_CEILING;   // power-safe clamp
        if (mult < 0.0f) mult = 0.0f;

        uint8_t fr = (uint8_t)(baseColor.R * mult);
        uint8_t fg = (uint8_t)(baseColor.G * mult);
        uint8_t fb = (uint8_t)(baseColor.B * mult);

        strip.SetPixelColor(i, RgbColor(fr, fg, fb));
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
