export async function getMicDiagnostics(audioCtx) {
  let permission = 'unknown';
  try {
    if (navigator.permissions?.query) {
      const result = await navigator.permissions.query({ name: 'microphone' });
      permission = result.state;
    }
  } catch (e) {
    permission = 'unsupported';
  }

  const inIframe = window.self !== window.top;
  const mediaDevices = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const secureContext = !!window.isSecureContext;
  const audioState = audioCtx?.state || 'not-created';

  return { permission, inIframe, mediaDevices, secureContext, audioState };
}

export async function ensureAudioContextRunning(audioCtx) {
  if (!audioCtx) return { ok: false, reason: 'missing-context' };
  if (audioCtx.state === 'running') return { ok: true };
  try {
    await audioCtx.resume();
    return { ok: audioCtx.state === 'running', reason: audioCtx.state };
  } catch (e) {
    return { ok: false, reason: e?.message || 'resume-failed' };
  }
}
