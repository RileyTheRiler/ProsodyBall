const fs = require('fs');

let content = fs.readFileSync('app.js', 'utf8');

// The reviewer mentioned VOICE_CANVAS_GUIDE_HZ was placed before imports.
// Let's remove it from the very top and place it after imports.
content = content.replace('const VOICE_CANVAS_GUIDE_HZ = [100, 150, 200, 250, 300];\n', '');

// Find the last import and add it after
const importsEnd = `import { computeFrameReliability, normalizeAgainstPercentiles, normalizeAgainstRange } from './voice-analyzer-core.js';`;

const replaceWith = `import { computeFrameReliability, normalizeAgainstPercentiles, normalizeAgainstRange } from './voice-analyzer-core.js';

const VOICE_CANVAS_GUIDE_HZ = [100, 150, 200, 250, 300];`;

if (content.includes(importsEnd)) {
    content = content.replace(importsEnd, replaceWith);
    fs.writeFileSync('app.js', content, 'utf8');
    console.log("Moved successfully.");
} else {
    console.log("Could not find imports.");
}
