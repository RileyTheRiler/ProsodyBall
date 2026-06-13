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

struct ColorPacket { uint8_t r, g, b, res; };
QueueHandle_t colorQueue;

class ColorPacketCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
        String value = pCharacteristic->getValue();
        if (value.length() == 4) {
            ColorPacket pkt = {
                (uint8_t)value[0],
                (uint8_t)value[1],
                (uint8_t)value[2],
                (uint8_t)value[3]
            };
            Serial.printf("Received -> R:%d G:%d B:%d Res:%d\n", pkt.r, pkt.g, pkt.b, pkt.res);
            xQueueSend(colorQueue, &pkt, 0);
        } else if (value.length() == 3) {
            // Backwards compatibility
            ColorPacket pkt = {
                (uint8_t)value[0],
                (uint8_t)value[1],
                (uint8_t)value[2],
                0
            };
            Serial.printf("Received (3-byte) -> R:%d G:%d B:%d\n", pkt.r, pkt.g, pkt.b);
            xQueueSend(colorQueue, &pkt, 0);
        }
    }
};

// Global animation state
uint8_t targetR = 0;
uint8_t targetG = 0;
uint8_t targetB = 0;
uint8_t targetRes = 0;

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
    }

    // --- ANIMATION ENGINE ---
    uint32_t t = millis();
    float resFactor = targetRes / 255.0f;
    
    // Breathing pulse: speed and depth scale with resonance
    float pulseSpeed = 0.002f + (0.004f * resFactor);
    float pulse = (sin(t * pulseSpeed) * 0.5f + 0.5f);
    
    // Get the properly gamma-corrected and balanced base color
    RgbColor baseColor = adjustColor(targetR, targetG, targetB);
    
    // Apply per-pixel shimmer and global pulse
    for (int i = 0; i < NUM_LEDS; i++) {
        float shimmer = 1.0f;
        if (targetRes > 0) {
            // Create a randomized twinkle effect
            float noise = (float)random(100) / 100.0f; 
            shimmer = 1.0f - (noise * resFactor * 0.5f); // up to 50% brightness dip when highly resonant
        }
        
        // Depth of the breathing pulse drops up to 30% depending on resonance
        float breathMultiplier = 1.0f - (resFactor * 0.3f * pulse);
        float finalMult = shimmer * breathMultiplier;
        
        uint8_t fr = (uint8_t)(baseColor.R * finalMult);
        uint8_t fg = (uint8_t)(baseColor.G * finalMult);
        uint8_t fb = (uint8_t)(baseColor.B * finalMult);
        
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
