// Resolves ffmpeg/ffprobe paths. Uses the static binaries bundled via
// npm (ffmpeg-static / ffprobe-static) so the app works on hosts that
// don't have ffmpeg installed system-wide - which includes Render's
// default Node runtime. Falls back to plain "ffmpeg"/"ffprobe" (system
// PATH) if the packages are somehow missing.

let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';

try {
  const staticFfmpeg = require('ffmpeg-static');
  if (staticFfmpeg) ffmpegPath = staticFfmpeg;
} catch (e) { /* fall back to system ffmpeg */ }

try {
  const staticFfprobe = require('ffprobe-static');
  if (staticFfprobe && staticFfprobe.path) ffprobePath = staticFfprobe.path;
} catch (e) { /* fall back to system ffprobe */ }

module.exports = { ffmpegPath, ffprobePath };
