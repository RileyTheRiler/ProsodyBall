import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeFrameReliability,
  normalizeAgainstPercentiles
} from '../voice-analyzer-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'fixtures', 'audio-eval', 'reference-frames.json');

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
let failures = 0;

function inRange(value, [min, max]) {
  return value >= min && value <= max;
}

const isRebaseline = process.argv.includes('--rebaseline') || process.argv.includes('--update');

for (const frame of fixture.frames) {
  const rel = computeFrameReliability({
    pitchConfidence: frame.pitchConfidence,
    formantConfidence: frame.formantConfidence,
    voicedStrength: frame.voicedStrength,
    spectralTiltConfidence: frame.spectralTiltConfidence
  });

  const energy = normalizeAgainstPercentiles(frame.gatedRms, frame.energyP50, frame.energyP90, 1.1);
  const articulation = normalizeAgainstPercentiles(
    frame.hfEnergy,
    frame.hfNoiseFloor,
    Math.max(frame.hfNoiseFloor + 0.02, frame.hfNoiseFloor * 3.5),
    1.2
  );

  if (isRebaseline) {
    // Generate new expected ranges (+/- 0.05 around current exact values, clamped to [0,1])
    const makeRange = (val) => [
      Math.max(0, Number((val - 0.05).toFixed(3))),
      Math.min(1, Number((val + 0.05).toFixed(3)))
    ];
    frame.expected.confidenceGate = makeRange(rel.confidenceGate);
    frame.expected.voicedGate = makeRange(rel.voicedGate);
    frame.expected.energy = makeRange(energy);
    frame.expected.articulation = makeRange(articulation);
  } else {
    const checks = [
      ['confidenceGate', rel.confidenceGate, frame.expected.confidenceGate],
      ['voicedGate', rel.voicedGate, frame.expected.voicedGate],
      ['energy', energy, frame.expected.energy],
      ['articulation', articulation, frame.expected.articulation]
    ];

    for (const [name, value, range] of checks) {
      if (!inRange(value, range)) {
        failures += 1;
        console.error(`FAIL ${frame.name}.${name}: got ${value.toFixed(3)} expected [${range[0]}, ${range[1]}]`);
      }
    }
  }
}

if (isRebaseline) {
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  console.log(`Re-baselined ${fixture.frames.length} frames and saved to ${fixturePath}`);
  process.exit(0);
}

if (failures > 0) {
  process.exitCode = 1;
  console.error(`\n${failures} fixture checks failed.`);
} else {
  console.log(`All ${fixture.frames.length} fixture frames are within expected ranges.`);
}
