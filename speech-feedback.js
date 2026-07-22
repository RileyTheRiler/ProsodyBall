// ============================================================
// SPEECH FEEDBACK
// Composes short, TTS-friendly summaries of a scored phrase-practice take,
// combining the coaching layer's takeaway (phrase-coach.js) with a nudge
// toward the user's chosen voice-training goal ('feminization' |
// 'masculinization'). Pure functions, no DOM/WebAudio/speechSynthesis —
// app.js is responsible for actually speaking the returned string.
// Unit-tested in speech-feedback.test.mjs.
// ============================================================

const RETRY_SCORE_CEILING = 90; // below this, the summary includes a retry nudge

const GOAL_LABEL = {
  feminization: 'a lighter, brighter voice',
  masculinization: 'a deeper, heavier voice',
};

// Focus-specific phrasing for each training goal. Falls back to a generic
// goal-direction nudge when a phrase's focus isn't one of these four.
const GOAL_FOCUS_NUDGE = {
  feminization: {
    resonance: 'keep the resonance bright and forward, not chesty',
    intonation: 'let the pitch lift and swoop more — stay light and expressive',
    elongation: 'stretch the vowels while keeping the pitch riding high',
    articulation: 'keep the consonants light and crisp, not heavy',
  },
  masculinization: {
    resonance: 'let the tone sit heavier, further back in the throat',
    intonation: 'keep the pitch swings smaller and let it settle low at the end',
    elongation: 'stretch the vowels while keeping the pitch low and relaxed',
    articulation: 'keep the consonants firm and grounded',
  },
};

// Short natural-language nudge for the retry, blending the goal direction with
// the phrase's own focus, then closing with the phrase's built-in coaching tip
// (already well-tuned, focus-specific advice from PRACTICE_PHRASES) — the goal
// nudge supplements that tip, it doesn't replace it.
export function buildGoalTip({ phraseDef, goalMode } = {}) {
  const goal = goalMode === 'masculinization' ? 'masculinization' : 'feminization';
  const nudge = GOAL_FOCUS_NUDGE[goal][phraseDef?.focus] || `aim for ${GOAL_LABEL[goal]}`;
  const tip = phraseDef?.tip ? ` ${phraseDef.tip}` : '';
  return `for ${GOAL_LABEL[goal]}, ${nudge}.${tip}`;
}

// Build the full spoken-feedback summary for a completed take. `scored` is
// scorePhraseTake() output (or null/undefined for an unusable take);
// `phraseDef` is the PRACTICE_PHRASES entry that was read; `goalMode` is
// 'feminization' | 'masculinization'. Kept short (2-3 sentences) since raw
// numbers (Hz, pace, etc.) don't read well aloud — that detail stays visual.
export function buildPhraseSpeechSummary({ scored, phraseDef, goalMode } = {}) {
  if (!scored) {
    return 'No usable recording — try again in a quieter spot, a little closer to the microphone.';
  }
  const parts = [`Score: ${scored.score}. ${scored.takeaway}`];
  if (scored.score < RETRY_SCORE_CEILING) {
    parts.push(`Try again — ${buildGoalTip({ phraseDef, goalMode })}`);
  }
  return parts.join(' ');
}
