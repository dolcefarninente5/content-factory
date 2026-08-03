// Real YouTube Data API v3 upload via googleapis.
//
// Setup (all from the dashboard now, not the terminal):
//   1. Google Cloud Console -> new project -> enable "YouTube Data API v3"
//   2. Create OAuth2 credentials: type "Web application" (not Desktop -
//      this matters, since the browser-based connect flow needs a
//      registered redirect URI)
//   3. Under "Authorized redirect URIs", add:
//        <your app's URL>/api/oauth/youtube/callback
//      e.g. https://your-app.onrender.com/api/oauth/youtube/callback
//   4. Put the client ID/secret into the Settings page in the dashboard
//   5. On the Channels page, click "Connect YouTube" for each channel -
//      this opens Google's consent screen in your browser and handles
//      the rest automatically once you approve it

const fs = require('fs');
const { google } = require('googleapis');
const db = require('../db/db');
const { getSetting } = require('../config/settings');

function getOAuthClient(redirectUri) {
  const clientId = getSetting('yt_client_id') || process.env.YT_CLIENT_ID;
  const clientSecret = getSetting('yt_client_secret') || process.env.YT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('YouTube client ID/secret not set - add them on the Settings page first.');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getAuthClientForChannel(channelId) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  const refreshToken = (channel && channel.youtube_refresh_token) || process.env[`YT_REFRESH_TOKEN_CHANNEL_${channelId}`];
  if (!refreshToken) {
    throw new Error(`Channel ${channelId} isn't connected to YouTube yet - click "Connect YouTube" on the Channels page.`);
  }
  const oauth2Client = getOAuthClient(null);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

async function uploadVideo({ channelId, videoFilePath, title, description, scheduledFor, privacyStatus }) {
  const auth = getAuthClientForChannel(channelId);
  const youtube = google.youtube({ version: 'v3', auth });

  if (!fs.existsSync(videoFilePath)) {
    throw new Error(`Video file not found: ${videoFilePath}`);
  }

  const requestBody = {
    snippet: { title: title || 'Untitled', description: description || '' },
    status: {
      privacyStatus: privacyStatus || 'private',
      ...(scheduledFor ? { publishAt: new Date(scheduledFor).toISOString() } : {}),
      selfDeclaredMadeForKids: false,
    },
  };

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody,
    media: { body: fs.createReadStream(videoFilePath) },
  });

  return { youtubeVideoId: res.data.id };
}

module.exports = { uploadVideo, getAuthClientForChannel, getOAuthClient };
