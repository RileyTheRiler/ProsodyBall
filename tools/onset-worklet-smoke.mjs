// Headless-Chrome check for the onset-timing AudioWorklet. The regular browser
// smoke never clicks Start, so it never loads the worklet. Here we load the
// processor directly, feed it a synthesized oscillator gated on/off, and assert
// it (a) actually runs process() on the audio thread (heartbeats) and (b) detects
// silent→voiced onsets. Chrome only (Firefox headless has no realtime audio sink).
//
// The page.evaluate() body runs in the browser, so the Web Audio constructors
// below are browser globals, not Node ones.
/* global AudioContext, AudioWorkletNode, OscillatorNode, GainNode */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const port = Number(process.env.PORT || 4188);
const baseUrl = `http://127.0.0.1:${port}/index.html`;

const server = spawn('npx', ['serve', '.', '-l', String(port)], { stdio: 'ignore', shell: true, detached: true });
function killServer() {
  try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* gone */ } }
}

const deadline = Date.now() + 30000;
let ready = false;
while (Date.now() < deadline) {
  try { const r = await fetch(baseUrl, { method: 'HEAD' }); if (r.ok) { ready = true; break; } } catch { /* wait */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!ready) { console.error('server not ready'); killServer(); process.exit(2); }

let browser;
try {
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async () => {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    await ctx.audioWorklet.addModule('audio/onset-worklet.js');

    const node = new AudioWorkletNode(ctx, 'onset-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { windowSize: 4096, noiseFloor: 0 },
    });

    let onsets = 0, heartbeats = 0;
    node.port.onmessage = (e) => {
      if (e.data?.type === 'onset') onsets++;
      else if (e.data?.type === 'rms') heartbeats++;
    };
    node.port.postMessage({ armed: true, noiseFloor: 0, onThreshold: 0.05, offThreshold: 0.01 });

    const osc = new OscillatorNode(ctx, { frequency: 220 });
    const gain = new GainNode(ctx, { gain: 0 });
    osc.connect(gain).connect(node);
    node.connect(ctx.destination); // silent; keeps the graph pulling process()
    osc.start();

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Two loud bursts (each long enough to fill the ~93ms RMS window) separated
    // by silence → expect two silent→voiced onsets.
    gain.gain.value = 0.3; await wait(250);
    gain.gain.value = 0;   await wait(250);
    gain.gain.value = 0.3; await wait(250);

    osc.stop();
    await ctx.close();
    return { onsets, heartbeats };
  });

  if (result.heartbeats <= 0) throw new Error('worklet process() never ran (no heartbeats)');
  if (result.onsets < 1) throw new Error(`expected >=1 onset, got ${result.onsets}`);

  console.log(`[onset-worklet] PASS (onsets=${result.onsets}, heartbeats=${result.heartbeats})`);
} catch (err) {
  console.error('[onset-worklet] FAIL', err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  killServer();
}
