# Darija Content Factory - backend + approval dashboard

## Test Mode - start here
The app defaults to **Test Mode**: every stage (scoring, script, voice,
visuals, publishing) uses fast, free, fake outputs instead of real paid
APIs. You can click through the entire pipeline - submit a story,
approve it, watch a real assembled video come out the other end - with
**zero API keys and zero cost**. Switch to Real Mode on the **Settings**
page only when you're ready to spend real money. The Overview page
always shows which mode you're in.

## YouTube setup - now entirely in the browser
No more CLI script for this. On the **Settings** page, paste your
Google Cloud OAuth client ID/secret once (shared across channels). Then
on the **Channels** page, click **Connect YouTube** next to each
channel - it opens Google's consent screen right in your browser, you
approve, and it's connected. (The Google Cloud Console setup itself -
creating the project and OAuth client - still has to happen on
Google's own site; nothing gets you around that part. But once the
client ID/secret exist, connecting each channel is one button click,
no terminal.)

One setup detail that matters: when creating the OAuth client in Google
Cloud Console, use type **"Web application"**, not "Desktop app," and
add this as an Authorized redirect URI:
```
<your app's URL>/api/oauth/youtube/callback
```

## Real spend tracking
The Analytics page now shows **actual dollars spent**, logged the
moment each real paid call happens - separate from the pre-production
*estimates* on the Story review page. Test-mode calls are tracked too,
tagged separately, so they never get counted as real spend.

A local web app for running 3-5 Darija storytelling channels through one
pipeline, with a dashboard so you can watch every rendered video, see why
each story was picked, check cost vs. return before spending anything,
and monitor every stage without babysitting it.

## Two approval gates, not one
This matters enough to say up front:
1. **Story review (pre-production gate)** - before ANY money is spent.
   A story comes in, the sourcing agent scores it and writes out its
   reasoning plus an estimated cost and estimated revenue. You approve
   or reject based on that - this is where you avoid spending on stories
   unlikely to perform.
2. **Approval queue (pre-publish gate)** - after the video is fully
   produced. You watch it, read the script, approve or reject before it
   can go to YouTube.

Nothing gets produced without gate 1, and nothing gets published without
gate 2.

## What's built and working right now
- SQLite database tracking channels, stories, and videos through every
  pipeline stage (sourced -> scripted -> voiced -> assembled ->
  pending_review -> approved/rejected -> scheduled -> published)
- A dashboard with six pages:
  - **Overview** - counts per channel per stage, today's activity
  - **Story review** - candidate stories with the agent's score,
    written reasoning, and cost/revenue estimate; approve for
    production or reject before anything is spent
  - **Approval queue** - watch each finished video inline, read its
    script, approve or reject with a note
  - **Agents** - one card per pipeline stage (sourcing, script, voice,
    visual, assembly, publish, analytics) showing live status, queue
    depth, last run, and last message - so you can see at a glance
    what's stuck without opening every page
  - **Analytics** - server status/uptime, and per-channel spend vs.
    return (real once the analytics agent is wired, estimated until then)
  - **Channels** - add/edit channels, each with its own persona,
    voice id, and visual style prompt
- Simple password-protected login (single shared password - this is a
  solo-operator tool, not a multi-user system)
- File upload endpoint for video/audio/thumbnail files
- Activity log for every stage change
- A cost model (`config/costModel.js`) that computes estimated
  production cost and estimated revenue for every candidate story, all
  in one editable file

## Automation added on top of the manual pipeline
Four things now run without you clicking anything, plus a way to force
a full pass on demand:

- **Auto-scoring**: submitting a story on the Story review page kicks
  off scoring in the background immediately - it's usually already
  scored by the time you look at it, instead of needing a separate click.
- **Background scheduler**: script/voice/visual/assembly/publish run
  automatically every `AUTO_RUN_INTERVAL_MINUTES` (default 15, set in
  `.env`). Each still only advances what's actually ready - voice still
  refuses an unedited script, publish still only touches videos you've
  approved. Set `AUTO_RUN_ENABLED=false` to turn this off and run
  everything manually instead.
- **"Run all stages now"** button on the Agents page - forces one pass
  through every stage immediately, useful right after you edit a script
  and don't want to wait for the next scheduled tick.
- **Auto-scheduling on approval**: approving a video in the queue
  assigns it to the channel's next configured `upload_days` slot
  automatically (unless you'd already set one), so approved videos
  spread out on a predictable cadence instead of every channel
  publishing the instant something's approved.
- **Double-approval guard**: a story that's already been approved or
  rejected for production can't be approved again by accident.

## Pipeline page - manual override for testing
New page for watching or overriding any in-flight video by hand: edit
and save a script directly, upload an audio or video file manually to
skip a stage, or force a stage change. This is what lets you exercise
the whole approval flow today even before your voice/visual API keys
are live - attach a placeholder audio/video file here, then it behaves
exactly like something the real agents would have produced.

## Integrations - now wired to real providers
Every stage is implemented against a real API, not a stub. Each just needs
its API key (or, for YouTube, a one-time OAuth step per channel) to go live.

1. **Sourcing/scoring + script drafting** (`integrations/agents/sourcingAgent.js`,
   `integrations/scriptgen.js`) - Claude. Needs `ANTHROPIC_API_KEY`.

2. **Voice** (`integrations/tts.js`) - ElevenLabs, using voice cloning
   rather than a generic voice bank (holds up better on long emotional
   narration - see setup notes in the file for how to clone a voice per
   channel). Needs `ELEVENLABS_API_KEY` plus a `voice_id` set per channel.

3. **Visuals** (`integrations/visualgen.js`) - Stability AI, generating
   images per channel style (`image_style_prompt`), not stock footage.
   Needs `STABILITY_API_KEY`.

4. **Assembly** (`integrations/assembly.js`) - local ffmpeg, no API key
   needed at all. Combines the narration audio with the generated images
   into a real video file, timed to the audio's length. **Honest gap**:
   this does not produce word-synced captions yet - that needs a
   speech-to-text alignment pass (e.g. Whisper) as a follow-up piece of
   work. YouTube's own auto-captions are a real fallback until then.

5. **Publish** (`integrations/youtubeUpload.js`) - YouTube Data API v3.
   Needs a Google Cloud project (`YT_CLIENT_ID`/`YT_CLIENT_SECRET`,
   shared across channels) plus a refresh token per channel:
   ```bash
   node scripts/getYoutubeToken.js 1   # repeat per channel id
   ```
   This opens a URL you visit while logged into that specific channel's
   Google account - the one step that genuinely can't be automated,
   since Google requires a human to click "allow" per channel.

6. **Analytics** (`integrations/analytics.js`) - YouTube Analytics API,
   using the same per-channel token (the helper script above already
   requests the right scopes). Updates each channel's rolling average,
   which feeds the cost/ROI estimates on new stories.

Run any stage manually from the Agents page ("Run now"), or trigger them
via `POST /api/agents/<name>/run`. Each call processes exactly one queued
item, so you can watch it work one step at a time before trusting it to
run unattended.

## Backups
```bash
./scripts/backup.sh
```
Safely snapshots the live database (even while the server is running)
and archives it with the uploads folder into `backups/`, keeping the
last `BACKUP_KEEP_DAYS` (default 14) locally. Set `RCLONE_REMOTE` in
`.env` to also push backups off-server (recommended - a backup on the
same disk as the thing it protects doesn't survive a disk failure).

Run it daily via cron:
```bash
crontab -e
# add this line (runs at 3am server time):
0 3 * * * cd /root/content-factory && ./scripts/backup.sh >> /var/log/content-factory-backup.log 2>&1
```

## The cost model - and an honest limit on what it can predict
`config/costModel.js` holds every dollar assumption in one place:
per-token LLM cost, per-character TTS cost, per-image cost, and the
revenue-per-1000-views assumption. **That last number defaults to
$0.40/1000 views** - the real figure from the benchmark Darija channel we
looked at, not the much higher English-market number. Update it once you
have your own AdSense data.

Be clear-eyed about what "estimated views" means here: it is this
channel's own recent rolling average (once you have published videos to
average from), or a conservative flat fallback for a brand-new channel.
It is **not** a machine-learning prediction of how a specific unpublished
story will perform - nothing can reliably do that before the video
exists and gets real watch-time data. The estimate is there so you're
comparing a story's cost against "what this channel has actually been
getting lately", which is the honest baseline, not a promise.

## Running it locally
```bash
cd content-factory
npm install
cp .env.example .env
# edit .env - at minimum set ADMIN_PASSWORD to something real
npm run seed      # creates 3 placeholder channels to start from
npm start
```
Then open http://localhost:3000 - it'll redirect to the login page.

## Using it day to day
1. Stories come in (manually via the Story review page for now, or wire
   up a WhatsApp webhook later) and sit at "pending" - no cost yet
2. Score it (from Story review) - reads the score, reasoning, and
   cost/ROI estimate, then approve for production or reject
3. Run the script agent (Agents page or it'll pick up automatically if
   you schedule it) -> drafts a script, video moves to "scripted"
4. **You edit the script** (`script_final`, mark `edited_by_human`) -
   the voice agent refuses to run on anything that hasn't been edited,
   by design
5. Run voice -> "voiced". Run visual -> generates images for that
   channel's style. Run assembly -> renders the real video file,
   moves to "pending_review"
6. **Open the Approval queue every day** - watch each video, check the
   script, approve or reject
7. Run publish -> uploads to YouTube, scheduled per-channel
8. Run analytics periodically (daily is reasonable) -> pulls real
   views/revenue back, which sharpens future cost/ROI estimates

Each agent processes one item per run, so early on it's worth running
them manually from the Agents page to watch each stage work correctly
before considering a cron job to run them unattended.

## Important operational notes carried over from planning
- Every video needs a human edit pass on its script and a human watch
  before approval - this isn't just quality control, it's what keeps
  the channels inside YouTube's 2026 inauthentic-content policy
- Each channel needs its own persona, voice, and upload schedule -
  the Channels page has fields for exactly this
- Don't launch all channels the same week; stagger it
- Change `ADMIN_PASSWORD` and `SESSION_SECRET` before exposing this
  past localhost - right now the dashboard has no HTTPS/hardening for
  public internet exposure, which matters if you deploy it to a VPS so
  you can check it from your phone

## Deploying so you can check it from your phone
Runs on a small always-on VPS (DigitalOcean/Hetzner, ~$5-6/month) with
`pm2` keeping it alive across restarts, and Caddy in front for free
HTTPS if you have a domain. Flat pricing was chosen deliberately over a
usage-billed platform like Railway, since this app accumulates video
files over time and per-GB storage billing compounds in a way flat VPS
pricing doesn't. See the deployment steps covered separately, or ask
again if you need them re-sent.
