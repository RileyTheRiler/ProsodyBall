export function runCalibrationWithTimeout(wizard, analyzer, timeoutMs = 15000) {
  if (!wizard || typeof wizard.run !== 'function' || typeof wizard.cancel !== 'function') {
    return Promise.reject(new TypeError('A calibration wizard with run() and cancel() is required.'));
  }

  let timerId;
  const timeout = Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 15000);
  const runPromise = Promise.resolve().then(() => wizard.run(analyzer));
  const timeoutPromise = new Promise((resolve) => {
    timerId = setTimeout(() => {
      wizard.cancel();
      resolve({ outcome: 'incomplete', skipped: true, reason: 'wizard-timeout' });
    }, timeout);
  });

  return Promise.race([runPromise, timeoutPromise]).finally(() => clearTimeout(timerId));
}
