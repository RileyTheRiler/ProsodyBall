// Pin map for the ProsodyBall Necklace (Seeed Studio XIAO ESP32S3 Sense).
// NOTE: the Sense board's PDM microphone pins below match Seeed's published
// PDM examples for this board; verify against your specific board revision's
// schematic before flashing (see the README's "Tuning & troubleshooting").
#pragma once

// --- PDM microphone (onboard, Sense expansion board) ---
#define MIC_CLOCK_PIN   42   // PDM CLK
#define MIC_DATA_PIN    41   // PDM DATA
#define MIC_PORT        I2S_NUM_0

// --- Vibration motor driver (logic-level N-MOSFET gate, e.g. AO3400/2N7002) ---
#define MOTOR_GATE_PIN   2   // XIAO silkscreen D1

// --- Status LED (single WS2812B/SK6805, data-only) ---
#define STATUS_LED_PIN   3   // XIAO silkscreen D2

// --- Battery / power ---
// No dedicated GPIO needed: the XIAO ESP32S3's onboard charge IC + JST battery
// connector handle charging autonomously.

// --- Onboard power switch ---
// SPDT slide switch wired in series with the LiPo's + lead -> true hardware off.
// No GPIO involved.
