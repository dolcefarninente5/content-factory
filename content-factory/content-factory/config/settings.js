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

function isAutoScript() {
  // When on, the pipeline skips the human script-edit gate: the AI draft
  // becomes the final script automatically. Off by default - turning it
  // on increases YouTube inauthentic-content policy risk, since the only
  // human editorial step left is the final video approval.
  const v = getSetting('auto_script', 'false');
  return v === 'true' || v === '1';
}

function getBudgetLimit() {
  return parseFloat(getSetting('budget_limit_usd', '15'));
}

// Throws if real (non-test) spend has reached the budget limit. Called
// before every real-mode paid API call, so the whole pipeline halts
// cleanly at the cap instead of drifting past it.
function checkBudget() {
  const spent = db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM spend_log WHERE test_mode = 0`).get().t;
  const limit = getBudgetLimit();
  if (spent >= limit) {
    throw new Error(`Budget limit reached: $${spent.toFixed(2)} of $${limit.toFixed(2)} spent. Raise the limit on the Settings page to continue.`);
  }
  return { spent, limit };
}

module.exports = { getSetting, setSetting, isTestMode, isAutoScript, getBudgetLimit, checkBudget };
