const path = require('path');
const fs = require('fs');
const db = require('../db/db');
const { COST_MODEL } = require('../config/costModel');
const { isTestMode, isAutoScript, checkBudget } = require('../config/settings');

function logActivity(videoId, action, detail) {
  db.prepare('INSERT INTO activity_log (video_id, action, detail) VALUES (?, ?, ?)').run(
    videoId, action, detail || ''
  );
}

function logSpend(videoId, channelId, provider, description, amount) {
  db.prepare(
    `INSERT INTO spend_log (video_id, channel_id, provider, description, amount, test_mode) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(videoId, channelId, provider, description, amount, isTestMode() ? 1 : 0);
}

function setAgentStatus(name, status, message) {
  db.prepare(
    `INSERT INTO agent_status (agent_name, last_run_at, status, last_message)
     VALUES (?, datetime('now'), ?, ?)
     ON CONFLICT(agent_name) DO UPDATE SET
       last_run_at = datetime('now'), status = excluded.status, last_message = excluded.last_message`
  ).run(name, status, message || '');
}

// Auto-scheduling: when a channel has upload_days configured (e.g.
// 'mon,thu'), spread approved videos across those slots instead of
// publishing everything the moment it's approved. Finds the next slot
// after this channel's last-scheduled video (or after now, if none).
const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function nextUploadSlot(channelId, uploadDaysStr) {
  const days = (uploadDaysStr || '')
    .split(',')
    .map((d) => DAY_MAP[d.trim().toLowerCase()])
    .filter((d) => d !== undefined);
  if (days.length === 0) return null;

  const lastRow = db
    .prepare(
      `SELECT MAX(scheduled_for) as m FROM videos WHERE channel_id = ? AND stage IN ('approved','scheduled','published')`
    )
    .get(channelId);

  let cursor = lastRow && lastRow.m ? new Date(lastRow.m) : new Date();
  cursor.setUTCHours(10, 0, 0, 0);
  if (!lastRow || !lastRow.m) {
    if (cursor < new Date()) cursor.setUTCDate(cursor.getUTCDate() + 1);
  } else {
    cursor.setUTCDate(cursor.getUTCDate() + 1); // search starting the day after the last slot
  }

  for (let i = 0; i < 21; i++) {
    if (days.includes(cursor.getUTCDay())) return cursor.toISOString();
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

// Runs exactly one queued item through the named stage. Returns
// { message } on success/no-op, throws on failure (caller records the
// failure onto agent_status - this function doesn't touch agent_status
// itself so it stays testable in isolation).
// How many un-decided candidate stories a channel is allowed to have
// sitting in the Story review queue before sourcing stops generating more
// for it. Keeps the queue from flooding while you're away, and keeps
// spend bounded even before the $ budget cap kicks in.
const MAX_PENDING_STORIES_PER_CHANNEL = 3;

async function processAgent(name, body = {}) {
  if (name === 'sourcing') {
    const { generateStory } = require('../integrations/agents/storyGenAgent');
    const { scoreStory } = require('../integrations/agents/sourcingAgent');

    const channels = db.prepare('SELECT * FROM channels WHERE active = 1').all();
    if (channels.length === 0) return { message: 'No active channels - add one on the Channels page first.' };

    for (const channel of channels) {
      const pending = db
        .prepare(`SELECT COUNT(*) as n FROM stories WHERE channel_id = ? AND produce_status = 'pending'`)
        .get(channel.id).n;
      if (pending >= MAX_PENDING_STORIES_PER_CHANNEL) continue; // this channel's queue is full, try the next one

      try {
        const result = await generateStory(channel.id);
        logActivity(null, 'story_generated', `Auto-generated story ${result.storyId} for "${channel.name}" (${result.angle})`);
        try {
          const scoreResult = await scoreStory(result.storyId);
          logActivity(null, 'story_scored', `Auto-scored story ${result.storyId}: ${scoreResult.score}/100`);
          return { message: `Generated + scored a new story for "${channel.name}": ${scoreResult.score}/100. Check Story review.` };
        } catch (e) {
          logActivity(null, 'story_score_failed', `Story ${result.storyId} generated but scoring failed: ${e.message}`);
          return { message: `Generated a story for "${channel.name}" but scoring failed: ${e.message}` };
        }
      } catch (e) {
        return { message: `Could not generate a story for "${channel.name}": ${e.message}` };
      }
    }
    return { message: 'Every active channel already has enough candidate stories waiting on your decision.' };
  }

  if (name === 'script') {
    const video = db.prepare(`SELECT * FROM videos WHERE stage = 'sourced' ORDER BY created_at LIMIT 1`).get();
    if (!video) return { message: 'Nothing waiting - no videos at "sourced" stage.' };

    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(video.channel_id);
    const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(video.story_id);

    let draftText;
    if (isTestMode()) {
      const { mockDraftScript } = require('../integrations/mock');
      draftText = await mockDraftScript({ sourceText: story ? story.source_text : '', angle: story ? story.angle : '', persona: channel.persona });
      logSpend(video.id, video.channel_id, 'anthropic', 'script draft (test mode)', 0);
    } else {
      checkBudget();
      const { draftScript } = require('../integrations/scriptgen');
      const result = await draftScript({ sourceText: story ? story.source_text : '', angle: story ? story.angle : '', persona: channel.persona });
      draftText = result.text;
      const cost = (result.inputTokens / 1000) * COST_MODEL.llmCostPer1kTokens + (result.outputTokens / 1000) * COST_MODEL.llmCostPer1kTokens;
      logSpend(video.id, video.channel_id, 'anthropic', `script draft (${result.inputTokens}in/${result.outputTokens}out tokens)`, Math.round(cost * 10000) / 10000);
    }

    // Auto-script mode: skip the human edit gate by promoting the draft
    // straight to final. Deliberately leaves edited_by_human = 0 so the
    // record honestly shows no human touched it.
    if (isAutoScript()) {
      db.prepare(`UPDATE videos SET script_draft = ?, script_final = ?, stage = 'scripted', updated_at = datetime('now') WHERE id = ?`).run(draftText, draftText, video.id);
      logActivity(video.id, 'stage_change', 'Script drafted and auto-approved (auto-script mode is ON)');
      return { message: `Drafted script for video ${video.id} (auto-script: no edit needed, voice can run).` };
    }

    db.prepare(`UPDATE videos SET script_draft = ?, stage = 'scripted', updated_at = datetime('now') WHERE id = ?`).run(draftText, video.id);
    logActivity(video.id, 'stage_change', 'Script drafted - needs your edit before voice generation');
    return { message: `Drafted script for video ${video.id}. Go edit it (script_final) before running voice.` };
  }

  if (name === 'voice') {
    const editGate = isAutoScript() ? '' : 'AND edited_by_human = 1';
    const video = db.prepare(`SELECT * FROM videos WHERE stage = 'scripted' AND script_final IS NOT NULL ${editGate} ORDER BY updated_at LIMIT 1`).get();
    if (!video) {
      const unedited = db.prepare(`SELECT COUNT(*) as n FROM videos WHERE stage = 'scripted' AND (edited_by_human = 0 OR script_final IS NULL)`).get().n;
      return { message: unedited > 0 && !isAutoScript() ? `${unedited} script(s) waiting on YOUR edit before voice can run.` : 'Nothing waiting - no scripts ready for voice.' };
    }
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(video.channel_id);
    const outDir = path.join(__dirname, '..', 'uploads', 'audio');
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = path.join(outDir, `${video.id}.mp3`);

    if (isTestMode()) {
      const { mockSynthesizeVoice } = require('../integrations/mock');
      await mockSynthesizeVoice({ outputPath });
      logSpend(video.id, video.channel_id, 'elevenlabs', 'voice synthesis (test mode)', 0);
    } else {
      checkBudget();
      const { synthesizeVoice } = require('../integrations/tts');
      await synthesizeVoice({ scriptText: video.script_final, voiceId: channel.voice_id, outputPath });
      const cost = video.script_final.length * COST_MODEL.ttsCostPerCharacter;
      logSpend(video.id, video.channel_id, 'elevenlabs', `voice synthesis (${video.script_final.length} chars)`, Math.round(cost * 10000) / 10000);
    }

    db.prepare(`UPDATE videos SET voice_file_path = ?, stage = 'voiced', updated_at = datetime('now') WHERE id = ?`).run(`/uploads/audio/${video.id}.mp3`, video.id);
    logActivity(video.id, 'stage_change', 'Voice generated');
    return { message: `Generated voice for video ${video.id}.` };
  }

  if (name === 'visual') {
    const video = db.prepare(`SELECT * FROM videos WHERE stage = 'voiced' AND images_dir IS NULL ORDER BY updated_at LIMIT 1`).get();
    if (!video) return { message: 'Nothing waiting - no voiced videos without visuals yet.' };

    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(video.channel_id);
    const outDir = path.join(__dirname, '..', 'uploads', 'images', String(video.id));
    const imagesPerVideo = COST_MODEL.imagesPerVideo;

    if (isTestMode()) {
      const { mockGenerateImages } = require('../integrations/mock');
      await mockGenerateImages({ count: imagesPerVideo, outputDir: outDir });
      logSpend(video.id, video.channel_id, 'stability', `${imagesPerVideo} images (test mode)`, 0);
      db.prepare(`UPDATE videos SET images_dir = ?, visual_provider = 'mock', visual_cost = 0, updated_at = datetime('now') WHERE id = ?`).run(outDir, video.id);
    } else {
      checkBudget();
      const { generateImages } = require('../integrations/visualgen');
      await generateImages({ scriptText: video.script_final, stylePrompt: channel.image_style_prompt, count: imagesPerVideo, outputDir: outDir });
      const cost = imagesPerVideo * COST_MODEL.imageCostPerImage;
      logSpend(video.id, video.channel_id, 'stability', `${imagesPerVideo} images`, cost);
      db.prepare(`UPDATE videos SET images_dir = ?, visual_provider = 'stability', visual_cost = ?, updated_at = datetime('now') WHERE id = ?`).run(outDir, cost, video.id);
    }

    logActivity(video.id, 'stage_change', `Generated ${imagesPerVideo} visuals`);
    return { message: `Generated visuals for video ${video.id}.` };
  }

  if (name === 'assembly') {
    const { assembleVideo } = require('../integrations/assembly');
    const video = db.prepare(`SELECT * FROM videos WHERE stage = 'voiced' AND images_dir IS NOT NULL AND voice_file_path IS NOT NULL ORDER BY updated_at LIMIT 1`).get();
    if (!video) return { message: 'Nothing waiting - no videos with both voice and visuals ready.' };

    const imageFiles = fs.readdirSync(video.images_dir).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(video.images_dir, f));
    const outDir = path.join(__dirname, '..', 'uploads', 'videos');
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = path.join(outDir, `${video.id}.mp4`);
    await assembleVideo({ audioPath: path.join(__dirname, '..', video.voice_file_path), imagePaths: imageFiles, outputPath });
    db.prepare(`UPDATE videos SET video_file_path = ?, stage = 'pending_review', updated_at = datetime('now') WHERE id = ?`).run(`/uploads/videos/${video.id}.mp4`, video.id);
    logActivity(video.id, 'stage_change', 'Assembled - ready for your review');
    return { message: `Assembled video ${video.id}. Check the Approval queue.` };
  }

  if (name === 'publish') {
    const video = db.prepare(`SELECT * FROM videos WHERE stage = 'approved' ORDER BY approved_at LIMIT 1`).get();
    if (!video) return { message: 'Nothing waiting - no approved videos to publish.' };

    let result;
    if (isTestMode()) {
      const { mockUploadVideo } = require('../integrations/mock');
      result = await mockUploadVideo({ title: video.title });
      logSpend(video.id, video.channel_id, 'youtube', 'publish (test mode - not actually uploaded)', 0);
    } else {
      const { uploadVideo } = require('../integrations/youtubeUpload');
      result = await uploadVideo({
        channelId: video.channel_id,
        videoFilePath: path.join(__dirname, '..', video.video_file_path),
        title: video.title,
        description: video.notes || '',
        scheduledFor: video.scheduled_for,
      });
    }

    db.prepare(`UPDATE videos SET youtube_video_id = ?, stage = ?, updated_at = datetime('now') WHERE id = ?`).run(
      result.youtubeVideoId, video.scheduled_for ? 'scheduled' : 'published', video.id
    );
    logActivity(video.id, 'stage_change', `Published as ${result.youtubeVideoId}${isTestMode() ? ' (TEST MODE - not real)' : ''}`);
    return { message: `${isTestMode() ? '[TEST MODE] ' : ''}Published video ${video.id} -> ${result.youtubeVideoId}` };
  }

  if (name === 'analytics') {
    const { syncChannelAnalytics } = require('../integrations/analytics');
    const channelId = body.channelId;
    if (channelId) {
      const result = await syncChannelAnalytics(channelId);
      return { message: `Synced channel ${channelId}: ${JSON.stringify(result)}` };
    }
    const channels = db.prepare('SELECT id FROM channels WHERE active = 1').all();
    const results = [];
    for (const ch of channels) {
      try { results.push(await syncChannelAnalytics(ch.id)); } catch (e) { results.push({ channelId: ch.id, error: e.message }); }
    }
    return { message: `Synced ${channels.length} channel(s).` };
  }

  throw new Error(`unknown agent: ${name}`);
}

module.exports = { processAgent, setAgentStatus, logActivity, nextUploadSlot };
