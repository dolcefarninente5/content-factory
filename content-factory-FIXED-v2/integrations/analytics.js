// Real YouTube Analytics sync via googleapis.
// Uses the same per-channel OAuth token as uploadVideo, but needs the
// yt-analytics.readonly (or yt-analytics-monetary.readonly for revenue)
// scope included in the consent screen - see scripts/getYoutubeToken.js.

const { google } = require('googleapis');
const db = require('../db/db');
const { getAuthClientForChannel } = require('./youtubeUpload');

async function syncChannelAnalytics(channelId) {
  const auth = getAuthClientForChannel(channelId);
  const youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth });

  const videos = db
    .prepare(`SELECT id, youtube_video_id FROM videos WHERE channel_id = ? AND youtube_video_id IS NOT NULL`)
    .all(channelId);

  if (videos.length === 0) {
    return { synced: 0, message: 'No published videos with a youtube_video_id yet for this channel.' };
  }

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = '2020-01-01'; // lifetime totals - simplest correct default for a young channel

  let syncedCount = 0;
  for (const v of videos) {
    // estimatedRevenue requires the yt-analytics-monetary.readonly scope
    // AND that channel being monetized (YPP-approved) - if either is
    // missing this metric silently comes back as 0, not an error.
    const res = await youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views,estimatedRevenue',
      filters: `video==${v.youtube_video_id}`,
    });

    const row = res.data.rows && res.data.rows[0];
    const views = row ? row[0] : 0;
    const revenue = row ? row[1] : 0;

    db.prepare(
      `UPDATE videos SET actual_views = ?, actual_revenue = ?, analytics_synced_at = datetime('now') WHERE id = ?`
    ).run(views, revenue, v.id);
    syncedCount++;
  }

  recomputeChannelStats(channelId);
  return { synced: syncedCount };
}

function recomputeChannelStats(channelId) {
  const rows = db
    .prepare(`SELECT actual_views, actual_revenue FROM videos WHERE channel_id = ? AND actual_views IS NOT NULL`)
    .all(channelId);
  if (rows.length === 0) return null;

  const avgViews = rows.reduce((sum, r) => sum + r.actual_views, 0) / rows.length;
  const avgRevenue = rows.reduce((sum, r) => sum + (r.actual_revenue || 0), 0) / rows.length;

  db.prepare(
    `INSERT INTO channel_stats (channel_id, avg_views_per_video, avg_revenue_per_video, videos_counted, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(channel_id) DO UPDATE SET
       avg_views_per_video = excluded.avg_views_per_video,
       avg_revenue_per_video = excluded.avg_revenue_per_video,
       videos_counted = excluded.videos_counted,
       updated_at = datetime('now')`
  ).run(channelId, avgViews, avgRevenue, rows.length);

  return { avgViews, avgRevenue, videosCounted: rows.length };
}

module.exports = { syncChannelAnalytics, recomputeChannelStats };
