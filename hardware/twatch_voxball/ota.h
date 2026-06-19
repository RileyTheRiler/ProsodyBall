#pragma once
// Optional Wi-Fi OTA: lets you push new firmware without USB, including straight from an
// Android phone's browser (open http://<device-ip>/ and upload a .bin — no app, no PC).
// Disabled by default — only activates once secrets.h defines a non-empty WIFI_SSID.
// Copy secrets.h.example -> secrets.h and fill in your network to enable it.
#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #define WIFI_SSID     ""
  #define WIFI_PASSWORD ""
#endif

#ifndef OTA_HOSTNAME
#define OTA_HOSTNAME "prosodyball"
#endif

#include <WiFi.h>
#include <WebServer.h>
#include <Update.h>
#include <ArduinoOTA.h>

static WebServer otaWebServer(80);
static bool gOtaReady = false;

static const char OTA_UPLOAD_PAGE[] PROGMEM = R"html(<!DOCTYPE html><html><body
style="font-family:sans-serif;max-width:420px;margin:40px auto">
<h3>%HOSTNAME% firmware update</h3>
<form method="POST" action="/update" enctype="multipart/form-data">
<input type="file" name="firmware" accept=".bin"><br><br>
<input type="submit" value="Upload &amp; Flash">
</form></body></html>)html";

// Joins Wi-Fi (if WIFI_SSID is set) and starts both the espota network-port listener
// (Arduino IDE -> Tools -> Port -> "<hostname> at <ip>") and a plain HTTP upload page at
// "/" for flashing straight from a phone browser. No-op — BLE/audio run exactly as before —
// if secrets.h is missing or WIFI_SSID is blank.
static inline void otaSetup() {
  if (WIFI_SSID[0] == '\0') return;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t startMs = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startMs < 10000) delay(200);
  if (WiFi.status() != WL_CONNECTED) { WiFi.mode(WIFI_OFF); return; } // skip OTA, keep booting

  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.begin();

  otaWebServer.on("/", HTTP_GET, [] {
    String page = FPSTR(OTA_UPLOAD_PAGE);
    page.replace("%HOSTNAME%", OTA_HOSTNAME);
    otaWebServer.send(200, "text/html", page);
  });
  otaWebServer.on("/update", HTTP_POST, [] {
    otaWebServer.send(200, "text/plain", Update.hasError() ? "Update FAILED" : "Update OK, rebooting...");
    delay(500);
    ESP.restart();
  }, [] {
    HTTPUpload &up = otaWebServer.upload();
    if (up.status == UPLOAD_FILE_START) {
      Update.begin(UPDATE_SIZE_UNKNOWN);
    } else if (up.status == UPLOAD_FILE_WRITE) {
      Update.write(up.buf, up.currentSize);
    } else if (up.status == UPLOAD_FILE_END) {
      Update.end(true);
    }
  });
  otaWebServer.begin();

  gOtaReady = true;
  Serial.printf("OTA ready: browse to http://%s/ (or http://%s.local/), or use Arduino IDE's "
                "network port '%s'\n", WiFi.localIP().toString().c_str(), OTA_HOSTNAME, OTA_HOSTNAME);
}

// Call every loop() iteration; no-op until otaSetup() actually brought Wi-Fi up.
static inline void otaLoop() {
  if (!gOtaReady) return;
  ArduinoOTA.handle();
  otaWebServer.handleClient();
}
