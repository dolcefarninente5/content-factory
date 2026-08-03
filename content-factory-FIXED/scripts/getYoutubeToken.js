// Run this once per channel: node scripts/getYoutubeToken.js <channel_id>
//
// Opens a URL. Open it in a browser WHILE LOGGED INTO THAT SPECIFIC
// CHANNEL'S GOOGLE ACCOUNT (this is the part that can't be automated -
// Google requires a human to click "allow" for each channel separately).
//
// Important: this uses the "loopback" redirect flow (a tiny local web
// server catches the response), which means the browser you approve in
// must be on the SAME MACHINE this script is running on. If your app
// runs on a remote VPS, the easiest path is to run this script on your
// own laptop instead (it doesn't need the rest of the app - just Node
// and this one file) and then paste the resulting refresh token into
// the server's .env over SSH. Google deprecated the old copy/paste
// "out-of-band" flow in 2023, so that older pattern no longer works.

require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');

const channelId = process.argv[2];
if (!channelId) {
  console.error('Usage: node scripts/getYoutubeToken.js <channel_id>');
  process.exit(1);
}

if (!process.env.YT_CLIENT_ID || !process.env.YT_CLIENT_SECRET) {
  console.error('Set YT_CLIENT_ID and YT_CLIENT_SECRET in .env first (see integrations/youtubeUpload.js for setup steps).');
  process.exit(1);
}

const scopes = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
];

const server = http.createServer();

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const oauth2Client = new google.auth.OAuth2(
    process.env.YT_CLIENT_ID,
    process.env.YT_CLIENT_SECRET,
    redirectUri
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent', // forces a refresh_token even if this Google account approved before
  });

  console.log(`\nOpen this URL in a browser on THIS machine, logged into channel ${channelId}'s Google account:\n`);
  console.log(authUrl);
  console.log('\nWaiting for you to approve it...\n');

  server.on('request', async (req, res) => {
    const reqUrl = new URL(req.url, redirectUri);
    const code = reqUrl.searchParams.get('code');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      res.end('Authorization was denied. You can close this tab.');
      console.error(`\nGoogle returned an error: ${error}`);
      server.close();
      process.exit(1);
    }

    if (code) {
      res.end('Success - you can close this tab and go back to the terminal.');
      server.close();
      try {
        const { tokens } = await oauth2Client.getToken(code);
        console.log('Success. Add this line to your .env (on whichever machine runs the server):\n');
        console.log(`YT_REFRESH_TOKEN_CHANNEL_${channelId}=${tokens.refresh_token}`);
        console.log('');
      } catch (e) {
        console.error('\nFailed to exchange code for tokens:', e.message);
        process.exit(1);
      }
    }
  });
});

