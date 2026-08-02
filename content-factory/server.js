require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db/db');
const { scoreStory } = require('./integrations/agents/sourcingAgent');
const { estimateProductionCost, estimateRevenue, COST_MODEL } = require('./config/costModel');
const { processAgent, setAgentStatus, logActivity, nextUploadSlot } = require('./pipeline/processAgent');
const { getSetting, setSetting, isTestMode } = require('./config/settings');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SERVER_STARTED_AT = new Date();

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(
  cookieSession({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'dev-secret-change-me'],
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
);

// ---- Simple single-password auth (this is a solo-operator dashboard, not multi-user) ----
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  if (req.path === '/api/login' || req.path === '/login.html') return next();
  return res.status(401).json({ error: 'not authenticated' });
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'wrong password' });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.use('/api', requireAuth);

// ---- Uploads (video/audio/thumbnail files land here, then get linked to a video row) ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const kind = req.query.kind === 'audio' ? 'audio' : req.query.kind === 'thumbnail' ? 'thumbnails' : 'videos';
      cb(null, path.join(__dirname, 'uploads', kind));
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.post('/api/upload-file', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file received' });
  const kind = req.query.kind === 'audio' ? 'audio' : req.query.kind === 'thumbnail' ? 'thumbnails' : 'videos';
  res.json({ path: `/uploads/${kind}/${req.file.filename}` });
});

// ---- Channels ----
app.get('/api/channels', (req, res) => {
  res.json(db.prepare('SELECT * FROM channels ORDER BY id').all());
});

app.post('/api/channels', (req, res) => {
  const { name, persona, voice_id, upload_days } = req.body;
  const info = db
    .prepare('INSERT INTO channels (name, persona, voice_id, upload_days) VALUES (?, ?, ?, ?)')
    .run(name, persona || '', voice_id || '', upload_days || 'mon,thu');
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/channels/:id', (req, res) => {
  const { name, persona, voice_id, upload_days, active } = req.body;
  db.prepare(
    'UPDATE channels SET name=?, persona=?, voice_id=?, upload_days=?, active=? WHERE id=?'
  ).run(name, persona, voice_id, upload_days, active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ---- Overview (dashboard home) ----
app.get('/api/overview', (req, res) => {
  const channels = db.prepare('SELECT * FROM channels ORDER BY id').all();
  const counts = db
    .prepare(
      `SELECT channel_id, stage, COUNT(*) as n FROM videos GROUP BY channel_id, stage`
    )
    .all();
  const today = db
    .prepare(
      `SELECT COUNT(*) as n FROM activity_log WHERE date(created_at) = date('now')`
    )
    .get().n;
  const pendingReview = db
    .prepare(`SELECT COUNT(*) as n FROM videos WHERE stage = 'pending_review'`)
    .get().n;

  const byChannel = channels.map((ch) => {
    const stageMap = {};
    counts.filter((c) => c.channel_id === ch.id).forEach((c) => (stageMap[c.stage] = c.n));
    return { ...ch, stageCounts: stageMap };
  });

  res.json({ channels: byChannel, activityToday: today, pendingReview });
});

// ---- Stories (raw intake) ----
app.post('/api/stories', (req, res) => {
  const { channel_id, source_text, source_type, angle } = req.body;
  const info = db
    .prepare(
      'INSERT INTO stories (channel_id, source_text, source_type, angle, produce_status) VALUES (?, ?, ?, ?, ?)'
    )
    .run(channel_id, source_text, source_type || 'submitted', angle || '', 'pending');
  // No video row yet - the story sits in the pre-production review queue
  // until you approve the spend.
  res.json({ storyId: info.lastInsertRowid });

  // Fire-and-forget: score it in the background so it's usually already
  // scored by the time you open Story review, instead of making you
  // click "Score" for every single submission. This costs one small LLM
  // call, not a production spend, so auto-running it is safe.
  setAgentStatus('sourcing', 'running', `Auto-scoring story ${info.lastInsertRowid}`);
  scoreStory(info.lastInsertRowid)
    .then((result) => setAgentStatus('sourcing', 'ok', `Auto-scored story ${info.lastInsertRowid}: ${result.score}/100`))
    .catch((e) => setAgentStatus('sourcing', 'needs_setup', e.message));
});

// ---- Story review (pre-production gate) ----
app.get('/api/stories', (req, res) => {
  const { produce_status } = req.query;
  let query = `SELECT s.*, c.name as channel_name FROM stories s JOIN channels c ON s.channel_id = c.id WHERE 1=1`;
  const params = [];
  if (produce_status) {
    query += ' AND s.produce_status = ?';
    params.push(produce_status);
  }
  query += ' ORDER BY s.score DESC, s.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/stories/:id/score', async (req, res) => {
  setAgentStatus('sourcing', 'running', `Scoring story ${req.params.id}`);
  try {
    const result = await scoreStory(req.params.id);
    setAgentStatus('sourcing', 'ok', `Scored story ${req.params.id}: ${result.score}/100`);
    res.json(result);
  } catch (e) {
    setAgentStatus('sourcing', 'needs_setup', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stories/:id/approve-production', (req, res) => {
  const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(req.params.id);
  if (!story) return res.status(404).json({ error: 'not found' });
  if (story.produce_status !== 'pending') {
    return res.status(400).json({ error: `This story was already ${story.produce_status} - can't approve it again.` });
  }
  if (story.score === null) {
    return res.status(400).json({ error: 'story has not been scored yet - run the sourcing agent first' });
  }

  const videoInfo = db
    .prepare(
      `INSERT INTO videos (story_id, channel_id, stage, story_score, story_reasoning, est_cost, est_views, est_revenue)
       VALUES (?, ?, 'sourced', ?, ?, ?, ?, ?)`
    )
    .run(story.id, story.channel_id, story.score, story.reasoning, story.est_cost, story.est_views, story.est_revenue);
  db.prepare('UPDATE stories SET produce_status = ? WHERE id = ?').run('approved_for_production', req.params.id);
  logActivity(videoInfo.lastInsertRowid, 'sourced', `Approved for production from story ${story.id}`);
  res.json({ videoId: videoInfo.lastInsertRowid });
});

app.post('/api/stories/:id/reject-production', (req, res) => {
  const { reason } = req.body;
  db.prepare('UPDATE stories SET produce_status = ?, reject_reason = ? WHERE id = ?').run(
    'rejected', reason || '', req.params.id
  );
  res.json({ ok: true });
});

// ---- Videos (the core pipeline objects) ----
app.get('/api/videos', (req, res) => {
  const { stage, channel_id } = req.query;
  let query = `SELECT v.*, c.name as channel_name FROM videos v JOIN channels c ON v.channel_id = c.id WHERE 1=1`;
  const params = [];
  if (stage) {
    query += ' AND v.stage = ?';
    params.push(stage);
  }
  if (channel_id) {
    query += ' AND v.channel_id = ?';
    params.push(channel_id);
  }
  query += ' ORDER BY v.updated_at DESC';
  res.json(db.prepare(query).all(...params));
});

app.get('/api/videos/:id', (req, res) => {
  const video = db
    .prepare(
      `SELECT v.*, c.name as channel_name, s.source_text FROM videos v
       JOIN channels c ON v.channel_id = c.id
       LEFT JOIN stories s ON v.story_id = s.id
       WHERE v.id = ?`
    )
    .get(req.params.id);
  if (!video) return res.status(404).json({ error: 'not found' });
  const log = db
    .prepare('SELECT * FROM activity_log WHERE video_id = ? ORDER BY created_at DESC')
    .all(req.params.id);
  res.json({ ...video, log });
});

// Update any pipeline field (script draft/final, file paths, stage, notes)
app.put('/api/videos/:id', (req, res) => {
  const allowed = [
    'title', 'script_draft', 'script_final', 'edited_by_human',
    'voice_file_path', 'video_file_path', 'thumbnail_path',
    'stage', 'notes', 'scheduled_for',
  ];
  const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
  if (fields.length === 0) return res.status(400).json({ error: 'no valid fields' });

  const setClause = fields.map((f) => `${f} = ?`).join(', ');
  const values = fields.map((f) => req.body[f]);
  db.prepare(
    `UPDATE videos SET ${setClause}, updated_at = datetime('now') WHERE id = ?`
  ).run(...values, req.params.id);

  if (fields.includes('stage')) {
    logActivity(req.params.id, 'stage_change', `Moved to ${req.body.stage}`);
  }
  res.json({ ok: true });
});

// The approval action - this is the human checkpoint the whole pipeline design depends on
app.post('/api/videos/:id/approve', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'not found' });
  if (!video.video_file_path) {
    return res.status(400).json({ error: 'cannot approve a video with no rendered file attached' });
  }

  // Auto-schedule into the channel's next configured upload slot, unless
  // a specific time was already set - this is what actually uses each
  // channel's upload_days setting instead of publishing everything the
  // instant it's approved (spreads releases out, keeps a predictable cadence).
  let scheduledFor = video.scheduled_for;
  if (!scheduledFor) {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(video.channel_id);
    scheduledFor = nextUploadSlot(video.channel_id, channel.upload_days);
  }

  db.prepare(
    `UPDATE videos SET stage = 'approved', approved_at = datetime('now'), scheduled_for = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(scheduledFor, req.params.id);
  logActivity(req.params.id, 'approved', `${req.body.notes || ''}${scheduledFor ? ` (scheduled for ${scheduledFor})` : ''}`);
  res.json({ ok: true, scheduledFor });
});

app.post('/api/videos/:id/reject', (req, res) => {
  const { reason } = req.body;
  db.prepare(
    `UPDATE videos SET stage = 'rejected', reject_reason = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(reason || '', req.params.id);
  logActivity(req.params.id, 'rejected', reason || '');
  res.json({ ok: true });
});

// ---- Agents status board ----
// Each row here is one stage of the pipeline. "queue_depth" tells you how
// much is waiting on that stage right now, so you can see where things are
// backed up without opening every page.
app.get('/api/agents', (req, res) => {
  const statuses = db.prepare('SELECT * FROM agent_status').all();
  const queueDepths = {
    sourcing: db.prepare(`SELECT COUNT(*) as n FROM stories WHERE produce_status = 'pending'`).get().n,
    script: db.prepare(`SELECT COUNT(*) as n FROM videos WHERE stage = 'sourced'`).get().n,
    voice: db.prepare(`SELECT COUNT(*) as n FROM videos WHERE stage = 'scripted' AND edited_by_human = 1 AND script_final IS NOT NULL`).get().n,
    visual: db.prepare(`SELECT COUNT(*) as n FROM videos WHERE stage = 'voiced' AND images_dir IS NULL`).get().n,
    assembly: db.prepare(`SELECT COUNT(*) as n FROM videos WHERE stage = 'voiced' AND images_dir IS NOT NULL AND voice_file_path IS NOT NULL`).get().n,
    publish: db.prepare(`SELECT COUNT(*) as n FROM videos WHERE stage = 'approved'`).get().n,
    analytics: db.prepare(`SELECT COUNT(*) as n FROM videos WHERE stage IN ('published','scheduled') AND analytics_synced_at IS NULL`).get().n,
  };
  res.json(statuses.map((s) => ({ ...s, queue_depth: queueDepths[s.agent_name] ?? 0 })));
});

// Generic "run this agent now" trigger. Each agent picks the next
// eligible video off its own queue and processes exactly one item per
// call (simple, predictable, easy to reason about when something fails
// partway through a batch).
app.post('/api/agents/:name/run', async (req, res) => {
  const { name } = req.params;
  if (name === 'sourcing') {
    return res.status(400).json({ error: 'Run sourcing per-story from the Story review page, not globally.' });
  }
  setAgentStatus(name, 'running', 'Started manually from dashboard');
  try {
    const { message } = await processAgent(name, req.body);
    setAgentStatus(name, 'ok', message);
    res.json({ ok: true, message });
  } catch (e) {
    setAgentStatus(name, 'needs_setup', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Runs every processing stage once, in pipeline order, in a single call -
// a convenience for pushing everything forward one step without six
// separate clicks. Each stage still only advances what's actually ready
// (e.g. voice still refuses unedited scripts) - this doesn't bypass any
// gate, it just saves the clicking.
app.post('/api/agents/run-all', async (req, res) => {
  const order = ['script', 'voice', 'visual', 'assembly', 'publish'];
  const results = {};
  for (const name of order) {
    setAgentStatus(name, 'running', 'Started via run-all');
    try {
      const { message } = await processAgent(name);
      setAgentStatus(name, 'ok', message);
      results[name] = { ok: true, message };
    } catch (e) {
      setAgentStatus(name, 'needs_setup', e.message);
      results[name] = { ok: false, error: e.message };
    }
  }
  res.json(results);
});

// ---- Settings (test mode, YouTube client credentials) ----
app.get('/api/settings', (req, res) => {
  res.json({
    testMode: isTestMode(),
    ytClientId: getSetting('yt_client_id', ''),
    ytClientConfigured: !!(getSetting('yt_client_id') && getSetting('yt_client_secret')),
  });
});

app.post('/api/settings', (req, res) => {
  if (typeof req.body.testMode === 'boolean') {
    setSetting('test_mode', req.body.testMode ? 'true' : 'false');
  }
  if (req.body.ytClientId) setSetting('yt_client_id', req.body.ytClientId);
  if (req.body.ytClientSecret) setSetting('yt_client_secret', req.body.ytClientSecret);
  res.json({ ok: true });
});

// ---- YouTube connect (browser OAuth flow, replaces the CLI script) ----
app.get('/api/channels/:id/youtube/connect', (req, res) => {
  try {
    const { getOAuthClient } = require('./integrations/youtubeUpload');
    const redirectUri = `${req.protocol}://${req.get('host')}/api/oauth/youtube/callback`;
    const oauth2Client = getOAuthClient(redirectUri);
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      state: req.params.id,
      scope: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
        'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
      ],
    });
    res.redirect(authUrl);
  } catch (e) {
    res.status(400).send(`<p>${e.message}</p><p><a href="/channels.html">Back to Channels</a></p>`);
  }
});

app.get('/api/oauth/youtube/callback', async (req, res) => {
  const { code, state: channelId, error } = req.query;
  if (error) {
    return res.status(400).send(`<p>Google returned an error: ${error}</p><p><a href="/channels.html">Back to Channels</a></p>`);
  }
  try {
    const { getOAuthClient } = require('./integrations/youtubeUpload');
    const redirectUri = `${req.protocol}://${req.get('host')}/api/oauth/youtube/callback`;
    const oauth2Client = getOAuthClient(redirectUri);
    const { tokens } = await oauth2Client.getToken(code);
    db.prepare('UPDATE channels SET youtube_refresh_token = ? WHERE id = ?').run(tokens.refresh_token, channelId);
    res.redirect('/channels.html?youtube_connected=' + channelId);
  } catch (e) {
    res.status(400).send(`<p>Failed to connect: ${e.message}</p><p><a href="/channels.html">Back to Channels</a></p>`);
  }
});

// ---- Real spend (actual dollars logged at the moment each paid call happened) ----
app.get('/api/spend', (req, res) => {
  const byProvider = db
    .prepare(
      `SELECT provider, test_mode, SUM(amount) as total, COUNT(*) as calls
       FROM spend_log GROUP BY provider, test_mode ORDER BY provider`
    )
    .all();
  const totalReal = db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM spend_log WHERE test_mode = 0`).get().t;
  res.json({ byProvider, totalReal });
});

// ---- Server health ----
app.get('/api/health', (req, res) => {
  const uptimeSeconds = Math.round((Date.now() - SERVER_STARTED_AT.getTime()) / 1000);
  res.json({
    status: 'live',
    startedAt: SERVER_STARTED_AT.toISOString(),
    uptimeSeconds,
    nodeVersion: process.version,
    now: new Date().toISOString(),
  });
});

// ---- Analytics / cost vs revenue overview ----
app.get('/api/analytics/overview', (req, res) => {
  const channels = db.prepare('SELECT * FROM channels').all();
  const perChannel = channels.map((ch) => {
    const agg = db
      .prepare(
        `SELECT
           COALESCE(SUM(est_cost), 0) as totalEstCost,
           COALESCE(SUM(actual_revenue), 0) as totalActualRevenue,
           COALESCE(SUM(est_revenue), 0) as totalEstRevenue,
           COALESCE(SUM(actual_views), 0) as totalActualViews,
           COUNT(*) as videoCount,
           SUM(CASE WHEN stage = 'published' THEN 1 ELSE 0 END) as publishedCount
         FROM videos WHERE channel_id = ?`
      )
      .get(ch.id);
    const stats = db.prepare('SELECT * FROM channel_stats WHERE channel_id = ?').get(ch.id);
    return { channel: ch, ...agg, rollingStats: stats || null };
  });
  res.json({ perChannel, rpmAssumption: COST_MODEL.rpmPer1000Views });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Content factory dashboard running at http://localhost:${PORT}`);
  console.log(`Admin password is set via ADMIN_PASSWORD in .env (default: "changeme" - change this before exposing to the internet)`);
});

// ---- Background automation ----
// Runs script/voice/visual/assembly/publish automatically on a timer, so
// the pipeline keeps moving between the two human gates (story approval,
// video approval) without you having to click "Run now" all day. Set
// AUTO_RUN_ENABLED=false in .env to turn this off entirely and only run
// agents manually from the dashboard.
const AUTO_RUN_ENABLED = process.env.AUTO_RUN_ENABLED !== 'false';
const AUTO_RUN_INTERVAL_MINUTES = parseFloat(process.env.AUTO_RUN_INTERVAL_MINUTES || '15');

if (AUTO_RUN_ENABLED) {
  const stages = ['script', 'voice', 'visual', 'assembly', 'publish'];
  setInterval(async () => {
    for (const name of stages) {
      try {
        const { message } = await processAgent(name);
        setAgentStatus(name, 'ok', message);
      } catch (e) {
        setAgentStatus(name, 'needs_setup', e.message);
      }
    }
  }, AUTO_RUN_INTERVAL_MINUTES * 60 * 1000);
  console.log(`Background automation running every ${AUTO_RUN_INTERVAL_MINUTES} minutes. Set AUTO_RUN_ENABLED=false in .env to disable.`);
} else {
  console.log('Background automation disabled (AUTO_RUN_ENABLED=false) - run agents manually from the dashboard.');
}
