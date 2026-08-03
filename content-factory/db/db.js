const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'factory.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  persona TEXT,
  voice_id TEXT,
  image_style_prompt TEXT,
  youtube_channel_id TEXT,
  upload_days TEXT DEFAULT 'mon,wed,fri',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER REFERENCES channels(id),
  source_text TEXT,
  source_type TEXT DEFAULT 'submitted',
  angle TEXT,
  status TEXT DEFAULT 'new',
  produce_status TEXT DEFAULT 'pending',
  score REAL,
  reasoning TEXT,
  est_cost REAL,
  est_views INTEGER,
  est_revenue REAL,
  reject_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id INTEGER REFERENCES stories(id),
  channel_id INTEGER REFERENCES channels(id),
  title TEXT,
  script_draft TEXT,
  script_final TEXT,
  edited_by_human INTEGER DEFAULT 0,
  voice_file_path TEXT,
  video_file_path TEXT,
  thumbnail_path TEXT,
  visual_provider TEXT,
  visual_cost REAL,
  stage TEXT DEFAULT 'sourced',
  reject_reason TEXT,
  notes TEXT,
  scheduled_for TEXT,
  youtube_video_id TEXT,
  story_score REAL,
  story_reasoning TEXT,
  est_cost REAL,
  est_views INTEGER,
  est_revenue REAL,
  actual_views INTEGER,
  actual_revenue REAL,
  analytics_synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER,
  action TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_status (
  agent_name TEXT PRIMARY KEY,
  last_run_at TEXT,
  status TEXT DEFAULT 'never_run',
  last_message TEXT
);

CREATE TABLE IF NOT EXISTS channel_stats (
  channel_id INTEGER PRIMARY KEY REFERENCES channels(id),
  avg_views_per_video REAL,
  avg_revenue_per_video REAL,
  videos_counted INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Simple key-value store for anything that should be changeable from the
-- dashboard without editing .env or restarting the server: test mode,
-- shared YouTube client credentials, etc.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Real spend, logged at the moment each paid API call actually happens -
-- separate from the pre-production ESTIMATES in stories/videos. This is
-- what answers "how much have I actually spent so far."
CREATE TABLE IF NOT EXISTS spend_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER,
  channel_id INTEGER,
  provider TEXT,
  description TEXT,
  amount REAL,
  test_mode INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

const migrations = [
  `ALTER TABLE channels ADD COLUMN image_style_prompt TEXT`,
  `ALTER TABLE channels ADD COLUMN youtube_refresh_token TEXT`,
  `ALTER TABLE stories ADD COLUMN produce_status TEXT DEFAULT 'pending'`,
  `ALTER TABLE stories ADD COLUMN score REAL`,
  `ALTER TABLE stories ADD COLUMN reasoning TEXT`,
  `ALTER TABLE stories ADD COLUMN est_cost REAL`,
  `ALTER TABLE stories ADD COLUMN est_views INTEGER`,
  `ALTER TABLE stories ADD COLUMN est_revenue REAL`,
  `ALTER TABLE stories ADD COLUMN reject_reason TEXT`,
  `ALTER TABLE videos ADD COLUMN visual_provider TEXT`,
  `ALTER TABLE videos ADD COLUMN visual_cost REAL`,
  `ALTER TABLE videos ADD COLUMN story_score REAL`,
  `ALTER TABLE videos ADD COLUMN story_reasoning TEXT`,
  `ALTER TABLE videos ADD COLUMN est_cost REAL`,
  `ALTER TABLE videos ADD COLUMN est_views INTEGER`,
  `ALTER TABLE videos ADD COLUMN est_revenue REAL`,
  `ALTER TABLE videos ADD COLUMN actual_views INTEGER`,
  `ALTER TABLE videos ADD COLUMN actual_revenue REAL`,
  `ALTER TABLE videos ADD COLUMN analytics_synced_at TEXT`,
  `ALTER TABLE videos ADD COLUMN images_dir TEXT`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* column already exists */ }
}

const AGENTS = ['sourcing', 'script', 'voice', 'visual', 'assembly', 'publish', 'analytics'];
const insertAgent = db.prepare(
  `INSERT OR IGNORE INTO agent_status (agent_name, status) VALUES (?, 'never_run')`
);
for (const a of AGENTS) insertAgent.run(a);

// Auto-seed starter channels if the database is completely empty - this
// used to require manually running `node db/seed.js`, which is easy to
// forget on a fresh deploy (e.g. a host whose start command is just
// `npm start`). Runs once, harmlessly no-ops after that.
const channelCount = db.prepare('SELECT COUNT(*) as c FROM channels').get().c;
if (channelCount === 0) {
  const insertChannel = db.prepare(
    `INSERT INTO channels (name, persona, voice_id, upload_days) VALUES (?, ?, ?, ?)`
  );
  insertChannel.run('Channel 1 - Placeholder', 'Describe the narrator persona and tone here', 'voice_1', 'mon,thu');
  insertChannel.run('Channel 2 - Placeholder', 'Describe the narrator persona and tone here', 'voice_2', 'tue,fri');
  insertChannel.run('Channel 3 - Placeholder', 'Describe the narrator persona and tone here', 'voice_3', 'wed,sat');
}

module.exports = db;
