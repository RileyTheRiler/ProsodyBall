import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoalTip, buildPhraseSpeechSummary } from './speech-feedback.js';

const phraseDef = {
  text: 'Where are you going on Wednesday?',
  focus: 'intonation',
  contourHint: 'rising',
  tip: 'Let the pitch lift toward the end of the question.',
  weakWords: ['are', 'on'],
};

test('buildPhraseSpeechSummary: no usable take → guard sentence, no crash', () => {
  const text = buildPhraseSpeechSummary({ scored: null, phraseDef, goalMode: 'feminization' });
  assert.match(text, /try again/i);
});

test('buildPhraseSpeechSummary: high score → no retry nudge appended', () => {
  const scored = { score: 95, takeaway: 'Solid take — press on!' };
  const text = buildPhraseSpeechSummary({ scored, phraseDef, goalMode: 'feminization' });
  assert.equal(text, 'Score: 95. Solid take — press on!');
});

test('buildPhraseSpeechSummary: low score → includes score, takeaway, and a retry nudge', () => {
  const scored = { score: 60, takeaway: 'Strongest: “going” · work on “Wednesday”' };
  const text = buildPhraseSpeechSummary({ scored, phraseDef, goalMode: 'feminization' });
  assert.match(text, /^Score: 60\. Strongest: “going” · work on “Wednesday” Try again — /);
  assert.match(text, /Let the pitch lift toward the end of the question\.$/);
});

test('buildGoalTip: feminization and masculinization produce different, goal-specific language', () => {
  const fem = buildGoalTip({ phraseDef, goalMode: 'feminization' });
  const masc = buildGoalTip({ phraseDef, goalMode: 'masculinization' });
  assert.notEqual(fem, masc);
  assert.match(fem, /lighter, brighter voice/);
  assert.match(masc, /deeper, heavier voice/);
  // Always closes with the phrase's own coaching tip.
  assert.match(fem, /Let the pitch lift toward the end of the question\.$/);
  assert.match(masc, /Let the pitch lift toward the end of the question\.$/);
});

test('buildGoalTip: unknown/missing focus falls back to a generic goal nudge without throwing', () => {
  const text = buildGoalTip({ phraseDef: { tip: 'Go dramatic.' }, goalMode: 'masculinization' });
  assert.match(text, /aim for a deeper, heavier voice/);
  assert.match(text, /Go dramatic\.$/);
});

test('buildGoalTip: defaults to feminization when goalMode is missing/invalid', () => {
  const text = buildGoalTip({ phraseDef, goalMode: undefined });
  assert.match(text, /lighter, brighter voice/);
});
