const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

// 1. Add practicePresetSelect variable and coachingToast
code = code.replace("const voiceProfileSelect = document.getElementById('voiceProfileSelect');",
  "const voiceProfileSelect = document.getElementById('voiceProfileSelect');\n" +
  "    const practicePresetSelect = document.getElementById('practicePresetSelect');\n" +
  "    const coachingToast = document.getElementById('coachingToast');\n" +
  "    this.coachingToastHideTimer = 0;"
);

// 2. Add event listener for practicePresetSelect
code = code.replace("voiceProfileSelect?.addEventListener('change', (e) => {",
  "practicePresetSelect?.addEventListener('change', (e) => {\n" +
  "      if (this.analyzer) {\n" +
  "        this.analyzer.setPracticePreset(e.target.value);\n" +
  "      }\n" +
  "    });\n\n" +
  "    voiceProfileSelect?.addEventListener('change', (e) => {"
);

// 3. Inject coaching hint toast rendering into onFrame loop
// There is an onFrame method in VoxBallGame. It calls this.update(dt), then this.draw().
// We can add it at the end of this.update(dt) or inside the game loop where we check things.
// Let's find "this.lastFrameTime = now;" in app.js inside the requestAnimationFrame loop to inject our logic.

const toastLogic = `
    if (this.analyzer && this.analyzer.coachingHint) {
      if (coachingToast) {
        coachingToast.textContent = this.analyzer.coachingHint;
        coachingToast.classList.add('visible');
      }
      this.coachingToastHideTimer = 3.0; // Show toast for 3 seconds
      this.analyzer.state.coachingHint = null; // Clear so we don't re-trigger immediately
    }
    
    if (this.coachingToastHideTimer > 0) {
      this.coachingToastHideTimer -= dt;
      if (this.coachingToastHideTimer <= 0 && coachingToast) {
        coachingToast.classList.remove('visible');
      }
    }
`;

// It's probably easier to inject it right after computeProsodyScore call in app.js
code = code.replace("this.prosodyScore = computeProsodyScore(this.prosodyScore, m, this.analyzer.currentPreset, scoreSmoothing);",
  "this.prosodyScore = computeProsodyScore(this.prosodyScore, m, this.analyzer.currentPreset, scoreSmoothing);\n" + toastLogic
);

fs.writeFileSync('app.js', code);
console.log('Updated app.js');
