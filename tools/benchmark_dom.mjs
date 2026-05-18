import { performance } from 'perf_hooks';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!DOCTYPE html>
<html>
<body>
  <div id="meterBounce"></div>
  <div id="meterTempo"></div>
  <div id="meterVowel"></div>
  <div id="meterArtic"></div>
  <div id="valPitch"></div>
  <div id="meterPitch"></div>
  <div id="meterResonance"></div>
  <div id="valResonance"></div>
  <div id="valBounce"></div>
  <div id="valTempo"></div>
  <div id="valVowel"></div>
  <div id="valArtic"></div>
  <div class="meter-bounce"><div class="meter-label"></div></div>
  <div class="meter-tempo"><div class="meter-label"></div></div>
  <div class="meter-vowel"><div class="meter-label"></div></div>
  <div class="meter-artic"><div class="meter-label"></div></div>
  <div id="mapSplatter"></div>
  <div id="pitchProfileLearned"></div>
  <div id="tiltProfileLearned"></div>
  <div id="frameConfidenceLabel"></div>
</body>
</html>`);

global.document = dom.window.document;

function runTest(useCache) {
  const ITERS = 10000;
  let cache = {};

  if (useCache) {
    cache = {
      meterBounce: document.getElementById('meterBounce'),
      meterTempo: document.getElementById('meterTempo'),
      meterVowel: document.getElementById('meterVowel'),
      meterArtic: document.getElementById('meterArtic'),
      valPitch: document.getElementById('valPitch'),
      meterPitch: document.getElementById('meterPitch'),
      meterResonance: document.getElementById('meterResonance'),
      valResonance: document.getElementById('valResonance'),
      valBounce: document.getElementById('valBounce'),
      valTempo: document.getElementById('valTempo'),
      valVowel: document.getElementById('valVowel'),
      valArtic: document.getElementById('valArtic'),
      labelBounce: document.querySelector('.meter-bounce .meter-label'),
      labelTempo: document.querySelector('.meter-tempo .meter-label'),
      labelVowel: document.querySelector('.meter-vowel .meter-label'),
      labelArtic: document.querySelector('.meter-artic .meter-label'),
      mapSplatter: document.getElementById('mapSplatter'),
      pitchProfileLearned: document.getElementById('pitchProfileLearned'),
      tiltProfileLearned: document.getElementById('tiltProfileLearned'),
      frameConfidenceLabel: document.getElementById('frameConfidenceLabel')
    };
  }

  const start = performance.now();
  let dummy = 0;

  for (let i = 0; i < ITERS; i++) {
    if (useCache) {
      dummy += cache.meterBounce ? 1 : 0;
      dummy += cache.meterTempo ? 1 : 0;
      dummy += cache.meterVowel ? 1 : 0;
      dummy += cache.meterArtic ? 1 : 0;
      dummy += cache.valPitch ? 1 : 0;
      dummy += cache.meterPitch ? 1 : 0;
      dummy += cache.meterResonance ? 1 : 0;
      dummy += cache.valResonance ? 1 : 0;
      dummy += cache.valBounce ? 1 : 0;
      dummy += cache.valTempo ? 1 : 0;
      dummy += cache.valVowel ? 1 : 0;
      dummy += cache.valArtic ? 1 : 0;
      dummy += cache.labelBounce ? 1 : 0;
      dummy += cache.labelTempo ? 1 : 0;
      dummy += cache.labelVowel ? 1 : 0;
      dummy += cache.labelArtic ? 1 : 0;
      dummy += cache.mapSplatter ? 1 : 0;
      dummy += cache.pitchProfileLearned ? 1 : 0;
      dummy += cache.tiltProfileLearned ? 1 : 0;
      dummy += cache.frameConfidenceLabel ? 1 : 0;
    } else {
      dummy += document.getElementById('meterBounce') ? 1 : 0;
      dummy += document.getElementById('meterTempo') ? 1 : 0;
      dummy += document.getElementById('meterVowel') ? 1 : 0;
      dummy += document.getElementById('meterArtic') ? 1 : 0;
      dummy += document.getElementById('valPitch') ? 1 : 0;
      dummy += document.getElementById('meterPitch') ? 1 : 0;
      dummy += document.getElementById('meterResonance') ? 1 : 0;
      dummy += document.getElementById('valResonance') ? 1 : 0;
      dummy += document.getElementById('valBounce') ? 1 : 0;
      dummy += document.getElementById('valTempo') ? 1 : 0;
      dummy += document.getElementById('valVowel') ? 1 : 0;
      dummy += document.getElementById('valArtic') ? 1 : 0;
      dummy += document.querySelector('.meter-bounce .meter-label') ? 1 : 0;
      dummy += document.querySelector('.meter-tempo .meter-label') ? 1 : 0;
      dummy += document.querySelector('.meter-vowel .meter-label') ? 1 : 0;
      dummy += document.querySelector('.meter-artic .meter-label') ? 1 : 0;
      dummy += document.getElementById('mapSplatter') ? 1 : 0;
      dummy += document.getElementById('pitchProfileLearned') ? 1 : 0;
      dummy += document.getElementById('tiltProfileLearned') ? 1 : 0;
      dummy += document.getElementById('frameConfidenceLabel') ? 1 : 0;
    }
  }

  const end = performance.now();
  return { time: end - start, dummy };
}

console.log(`Uncached: ${runTest(false).time.toFixed(2)}ms`);
console.log(`Cached: ${runTest(true).time.toFixed(2)}ms`);
