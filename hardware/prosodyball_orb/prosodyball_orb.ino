// ProsodyBall DIY orb firmware — ESP32 + WS2812B
// =================================================
// Turns an ESP32 into an open Bluetooth-LE "smart bulb" that ProsodyBall's
// browser app drives directly (no app, no hub, no Wi-Fi). The app's
// Esp32BleTransport connects to the service below and writes a 3-byte [R,G,B]
// color whenever the on-screen ball changes. We own both ends, so there's
// nothing to reverse-engineer and no pairing/bonding dance.
//
// Libraries (install once in Arduino IDE):
//   - ESP32 board package (Boards Manager: "esp32" by Espressif). The BLE*
//     headers ship with it — no separate download.
//   - "FastLED" (Library Manager).
//
// Board: select your ESP32 dev board (e.g. "ESP32 Dev Module"), then Upload.
//
// IMPORTANT — keep these UUIDs identical to bulb-controller.js
// (ESP32_SERVICE_UUID / ESP32_COLOR_UUID). If you change one, change both.

#include <FastLED.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// ---- Hardware config — edit to match your build ---------------------------
#define LED_PIN     4      // data wire from the strip -> this GPIO
#define NUM_LEDS    160    // pixels on the strip (Xnbada 1m @ 160/m)
#define LED_TYPE    WS2812B
#define COLOR_ORDER GRB    // WS2812B is GRB

// Power safety: a laptop USB port supplies only ~0.5-0.9 A. FastLED's governor
// auto-dims so the LEDs can NEVER exceed this draw and brown out the ESP32.
// NOTE: this caps the LED strip ONLY — the ESP32 + active BLE radio pull another
// ~150-250 mA on top. So 500 here ≈ 750 mA total, safe on a USB 3.0 / USB-C port
// (and fine on most laptop USB-A ports). For a strict 500 mA USB 2.0 port, drop
// to ~250; for full brightness, power the strip from a 5V/3A+ brick and raise this.
#define MAX_MILLIAMPS 500

static const char* SERVICE_UUID = "5b1e0001-8a0e-4f1b-9c5a-2f3d4e5a6b7c";
static const char* COLOR_UUID   = "5b1e0002-8a0e-4f1b-9c5a-2f3d4e5a6b7c";
static const char* DEVICE_NAME  = "ProsodyBall-01";

CRGB leds[NUM_LEDS];

// Apply a solid color to the whole orb.
static void showColor(uint8_t r, uint8_t g, uint8_t b) {
  fill_solid(leds, NUM_LEDS, CRGB(r, g, b));
  FastLED.show();
}

// Receives the 3-byte [R,G,B] packets the browser writes.
class ColorCallback : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String v = ch->getValue();
    if (v.length() >= 3) {
      showColor((uint8_t)v[0], (uint8_t)v[1], (uint8_t)v[2]);
    }
  }
};

void setup() {
  FastLED.addLeds<LED_TYPE, LED_PIN, COLOR_ORDER>(leds, NUM_LEDS);
  FastLED.setMaxPowerInVoltsAndMilliamps(5, MAX_MILLIAMPS);
  showColor(0, 0, 0); // start dark

  BLEDevice::init(DEVICE_NAME);
  BLEServer* server = BLEDevice::createServer();
  BLEService* service = server->createService(SERVICE_UUID);
  BLECharacteristic* color = service->createCharacteristic(
      COLOR_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  color->setCallbacks(new ColorCallback());
  service->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID); // so the browser can filter by service
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
}

void loop() {
  // All work happens in the BLE write callback; nothing to poll here.
  delay(1000);
}
