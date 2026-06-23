import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as gen from './dsp-constants.generated.js';
import { SNR_GREEN_DB, SNR_YELLOW_DB, OVERSUB_MIN, OVERSUB_MAX, NOISE_PROFILE_UPDATE_RATE } from './dsp-utils.js';

const spec = JSON.parse(readFileSync(new URL('./dsp-constants.json', import.meta.url), 'utf8'));

test('generated JS exports every js-applicable spec constant with the spec value', () => {
  for (const [name, c] of Object.entries(spec.constants)) {
    const hasJs = c.perPlatform ? Object.hasOwn(c.perPlatform, 'js') : true;
    if (!hasJs) {
      assert.equal(gen[name], undefined, `${name} should be absent from JS (per-platform without js)`);
      continue;
    }
    const expected = c.perPlatform ? c.perPlatform.js : c.value;
    assert.equal(gen[name], expected, `${name} mismatch`);
  }
});

test('dsp-utils re-exports the SNR constants from the generated source of truth', () => {
  assert.equal(SNR_GREEN_DB, gen.SNR_GREEN_DB);
  assert.equal(SNR_YELLOW_DB, gen.SNR_YELLOW_DB);
  assert.equal(OVERSUB_MIN, gen.OVERSUB_MIN);
  assert.equal(OVERSUB_MAX, gen.OVERSUB_MAX);
  assert.equal(NOISE_PROFILE_UPDATE_RATE, gen.NOISE_PROFILE_UPDATE_RATE);
});
