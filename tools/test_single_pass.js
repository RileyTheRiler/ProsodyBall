const appSource = require('fs').readFileSync('./app.js', 'utf8');

const regex = /const pitches = \[\];[\s\S]*?let paceLabel = '';/m;
const match = appSource.match(regex);
if (match) {
  console.log("Found match block length:", match[0].length);
  // Just syntax check the extracted block wrapped in a function
  try {
    const fn = new Function('crystallized', 'avgPitch', 'minPitch', 'maxPitch', 'pitchRange', 'avgVowelScore', 'avgResonance', 'avgConfidence', 'intonationScore', 'intonationLabel', 'paceConsistency', 'paceLabel', `
      ${match[0]}
    `);
    console.log("Syntax check passed!");
  } catch (e) {
    console.error("Syntax Error in block:", e);
  }
} else {
  console.log("Block not found.");
}
