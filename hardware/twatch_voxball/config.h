// Board selection for the LilyGo TTGO_TWatch_Library. This MUST be defined before
// LilyGoWatch.h is included, so the library pulls in the 2020 V3 pin map (ST7789
// display, AXP202 PMU, FT6236 touch, and the V3-only PDM microphone). Mirrors the
// pattern used by the library's own examples/BasicUnit/TwatcV3Special/Microphone.
#pragma once

#define LILYGO_WATCH_2020_V3   // <-- the only variant with the on-board microphone
#define LILYGO_WATCH_LVGL      // harmless; keeps parity with the stock examples

#include <LilyGoWatch.h>
