export const VIBRATION_STORAGE_KEY = 'vox:vibration:v1';

export const VIBRATION_METRIC_SPECS = Object.freeze([
  { value: 'pitch', label: 'Pitch (Hz)', unit: 'Hz', min: 50, max: 500, step: 5, defaultBelow: 150, defaultAbove: 250 },
  { value: 'resonance', label: 'Resonance', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 30, defaultAbove: 70 },
  { value: 'energy', label: 'Energy', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
  { value: 'bounce', label: 'Pitch Variation', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
  { value: 'tempo', label: 'Tempo Var.', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
  { value: 'vowel', label: 'Vowel Sustain', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 70 },
  { value: 'articulation', label: 'Articulation', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
]);

const METRIC_SPECS_BY_VALUE = new Map(VIBRATION_METRIC_SPECS.map((spec) => [spec.value, spec]));

export function parseVibrationPreferences(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { enabled: false, rules: [], nextId: 1 };
    }
  }

  if (!value || typeof value !== 'object') {
    return { enabled: false, rules: [], nextId: 1 };
  }

  const rules = [];
  for (const candidate of Array.isArray(value.rules) ? value.rules.slice(0, 20) : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const spec = METRIC_SPECS_BY_VALUE.get(candidate.metric);
    if (!spec) continue;
    const direction = candidate.direction === 'above' ? 'above' : 'below';
    const numericThreshold = Number(candidate.threshold);
    const fallbackThreshold = direction === 'above' ? spec.defaultAbove : spec.defaultBelow;
    const threshold = Number.isFinite(numericThreshold)
      ? Math.min(spec.max, Math.max(spec.min, numericThreshold))
      : fallbackThreshold;
    const id = Number.isSafeInteger(candidate.id) && candidate.id > 0
      ? candidate.id
      : rules.length + 1;
    // The metric version and the suspension flag round-trip verbatim. They are NOT defaulted
    // to "current" here: an unversioned stored rule predates the resonance metric split and
    // must stay unversioned so migrateResonanceRules can see it and suspend it
    // (docs/RESONANCE_REDESIGN.md §3.5). A parser that helpfully stamped the current version
    // would erase the exact fact the migration exists to detect.
    const rule = {
      id,
      metric: spec.value,
      direction,
      threshold,
      enabled: candidate.enabled !== false,
      cooldownTimer: 0,
      tripped: false,
    };
    if (Number.isFinite(candidate.metricVersion)) rule.metricVersion = candidate.metricVersion;
    // Which personal span the threshold was chosen against. A resonance threshold is a position
    // inside a span, so a rule that outlives its span is as un-interpretable as one that
    // outlives its metric version — see _suspendResonanceRulesForNewSpan in app.js.
    if (typeof candidate.spanId === 'string' && candidate.spanId.length <= 128) rule.spanId = candidate.spanId;
    if (candidate.suspended === true) {
      rule.suspended = true;
      if (typeof candidate.suspendedReason === 'string') rule.suspendedReason = candidate.suspendedReason;
    }
    rules.push(rule);
  }

  const highestId = rules.reduce((max, rule) => Math.max(max, rule.id), 0);
  return {
    enabled: value.enabled === true,
    rules,
    nextId: highestId + 1,
  };
}

export function serializeVibrationPreferences(vibration) {
  return JSON.stringify({
    enabled: vibration?.enabled === true,
    rules: (Array.isArray(vibration?.rules) ? vibration.rules : []).map((rule) => {
      const out = {
        id: rule.id,
        metric: rule.metric,
        direction: rule.direction,
        threshold: rule.threshold,
        enabled: rule.enabled !== false,
      };
      if (Number.isFinite(rule.metricVersion)) out.metricVersion = rule.metricVersion;
      if (typeof rule.spanId === 'string') out.spanId = rule.spanId;
      if (rule.suspended === true) {
        out.suspended = true;
        if (typeof rule.suspendedReason === 'string') out.suspendedReason = rule.suspendedReason;
      }
      return out;
    }),
  });
}
