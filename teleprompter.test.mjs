import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Teleprompter } from './teleprompter.js';

test('splitSentences keeps terminal punctuation and trims', () => {
  const tp = new Teleprompter();
  const out = tp.splitSentences('Hello there. How are you? Fine!');
  assert.deepEqual(out, ['Hello there.', 'How are you?', 'Fine!']);
});

test('splitSentences captures a trailing fragment without final punctuation', () => {
  const tp = new Teleprompter();
  const out = tp.splitSentences('Done. And then more');
  assert.deepEqual(out, ['Done.', 'And then more']);
});

test('splitSentences returns empty for empty input', () => {
  const tp = new Teleprompter();
  assert.deepEqual(tp.splitSentences(''), []);
  assert.deepEqual(tp.splitSentences(null), []);
});

test('sourceText switches between rainbow and custom passages', () => {
  const tp = new Teleprompter({ customText: 'my words.' });
  tp.mode = 'rainbow';
  assert.ok(tp.sourceText().startsWith('When the sunlight'));
  tp.mode = 'custom';
  assert.equal(tp.sourceText(), 'my words.');
});

test('advanceManual wraps around and is a no-op when off', () => {
  const tp = new Teleprompter({ customText: 'One. Two. Three.' });
  tp.mode = 'custom';
  assert.equal(tp.sentenceIndex, 0);
  tp.advanceManual();
  assert.equal(tp.sentenceIndex, 1);
  tp.advanceManual();
  tp.advanceManual();
  assert.equal(tp.sentenceIndex, 0); // wrapped past the 3rd sentence

  tp.mode = 'off';
  tp.advanceManual();
  assert.equal(tp.sentenceIndex, 0); // unchanged when off
});
