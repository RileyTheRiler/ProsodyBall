const PORTABLE_KEY_PATTERNS = [
  /^vox:colorMode$/,
  /^vox:daf:(enabled|delayMs|bassFilter)$/,
  /^vox:genderCue:[A-Za-z0-9_-]+$/,
  /^vox:goalMode$/,
  /^vox:motionPreference$/,
  /^vox:(micDeviceId|echoCancellation|noiseSuppression|autoGainControl)$/,
  /^vox:vibration:v1$/,
  /^vox:bulb:(enabled|transport|lightId|bleNamePrefix|bleServiceUuid|bleWriteUuid|autoReconnect|throttleMs)$/,
];

export function isPortableSettingKey(key) {
  return PORTABLE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function exportPortableSettings(storage) {
  const settings = {};
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key && isPortableSettingKey(key)) settings[key] = storage.getItem(key);
  }
  return {
    app: 'ProsodyBall',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    settings,
  };
}

export function importPortableSettings(storage, bundle) {
  if (!bundle || bundle.app !== 'ProsodyBall' || bundle.schemaVersion !== 1 ||
      !bundle.settings || typeof bundle.settings !== 'object' || Array.isArray(bundle.settings)) {
    throw new Error('This is not a supported ProsodyBall settings file.');
  }
  let imported = 0;
  for (const [key, value] of Object.entries(bundle.settings)) {
    if (!isPortableSettingKey(key) || typeof value !== 'string') continue;
    storage.setItem(key, value);
    imported++;
  }
  return imported;
}

export function resetPortableSettings(storage) {
  const keys = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith('vox:')) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
  return keys.length;
}
