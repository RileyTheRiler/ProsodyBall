import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportPortableSettings,
  importPortableSettings,
  resetPortableSettings,
} from './settings-transfer.js';

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('exports portable preferences without credentials or unrelated storage', () => {
  const storage = new MemoryStorage({
    'vox:colorMode': 'gender',
    'vox:bulb:enabled': '1',
    'vox:bulb:hueUser': 'secret-user',
    'vox:bulb:webhookUrl': 'https://example.invalid/private',
    unrelated: 'keep-me',
  });
  const bundle = exportPortableSettings(storage);
  assert.deepEqual(bundle.settings, {
    'vox:colorMode': 'gender',
    'vox:bulb:enabled': '1',
  });
});

test('imports only supported string preferences', () => {
  const storage = new MemoryStorage();
  const count = importPortableSettings(storage, {
    app: 'ProsodyBall',
    schemaVersion: 1,
    settings: {
      'vox:goalMode': 'masculinization',
      'vox:bulb:httpUrl': 'https://example.invalid/private',
      unrelated: 'no',
      'vox:motionPreference': 12,
    },
  });
  assert.equal(count, 1);
  assert.equal(storage.getItem('vox:goalMode'), 'masculinization');
  assert.equal(storage.getItem('vox:bulb:httpUrl'), null);
});

test('reset removes all app-owned storage but preserves other applications', () => {
  const storage = new MemoryStorage({ 'vox:goalMode': 'x', 'vox:future:key': 'y', unrelated: 'z' });
  assert.equal(resetPortableSettings(storage), 2);
  assert.equal(storage.getItem('unrelated'), 'z');
  assert.equal(storage.length, 1);
});
