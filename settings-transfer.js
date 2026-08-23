const PORTABLE_KEY_PATTERNS = [
  /^vox:colorMode$/,
  /^vox:daf:(enabled|delayMs|bassFilter)$/,
  /^vox:genderCue:[A-Za-z0-9_-]+$/,
  /^vox:goalMode$/,
  /^vox:motionPreference$/,
  /^vox:(micDeviceId|echoCancellation|noiseSuppression|autoGainControl|speechGate)$/,
  /^vox:vibration:v1$/,
  /^vox:bulb:(enabled|transport|hueLightId|bleNamePrefix|bleServiceUuid|bleWriteUuid|autoReconnect|throttleMs)$/,
];

const BOOLEAN_KEYS = new Set([
  'vox:daf:enabled',
  'vox:daf:bassFilter',
  'vox:echoCancellation',
  'vox:noiseSuppression',
  'vox:autoGainControl',
  'vox:speechGate',
  'vox:bulb:enabled',
  'vox:bulb:autoReconnect',
]);

const BULB_TRANSPORTS = new Set([
  'mock', 'hue', 'homeassistant', 'http', 'webbluetooth', 'genericble', 'esp32',
]);

function normalizeBoolean(value) {
  if (value === 'true' || value === '1') return 'true';
  if (value === 'false' || value === '0') return 'false';
  return null;
}

export function normalizePortableSetting(key, value) {
  if (!isPortableSettingKey(key) || typeof value !== 'string') return null;
  if (BOOLEAN_KEYS.has(key) || key.startsWith('vox:genderCue:')) return normalizeBoolean(value);

  if (key === 'vox:colorMode') return new Set(['pitch', 'gender']).has(value) ? value : null;
  if (key === 'vox:goalMode') return new Set(['feminization', 'masculinization']).has(value) ? value : null;
  if (key === 'vox:motionPreference') return new Set(['auto', 'low', 'full']).has(value) ? value : null;
  if (key === 'vox:daf:delayMs') {
    const delay = Number(value);
    return Number.isInteger(delay) && delay >= 0 && delay <= 200 ? String(delay) : null;
  }
  if (key === 'vox:bulb:throttleMs') {
    const delay = Number(value);
    return Number.isInteger(delay) && delay >= 50 && delay <= 5000 ? String(delay) : null;
  }
  if (key === 'vox:bulb:transport') return BULB_TRANSPORTS.has(value) ? value : null;
  if (key === 'vox:vibration:v1') {
    if (value.length > 100000) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? value : null;
    } catch {
      return null;
    }
  }
  return value.length <= 512 ? value : null;
}

export function isPortableSettingKey(key) {
  return PORTABLE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function exportPortableSettings(storage) {
  const settings = {};
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key) continue;
    const value = normalizePortableSetting(key, storage.getItem(key));
    if (value !== null) settings[key] = value;
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
    const normalized = normalizePortableSetting(key, value);
    if (normalized === null) continue;
    storage.setItem(key, normalized);
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
