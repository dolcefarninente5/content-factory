const db = require('../db/db');

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function isTestMode() {
  // Defaults to true - safest starting state is "don't spend real money
  // until you deliberately flip this off."
  const v = getSetting('test_mode', 'true');
  return v === 'true' || v === '1';
}

module.exports = { getSetting, setSetting, isTestMode };
