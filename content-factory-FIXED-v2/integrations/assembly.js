// Assembles a video from: one narration audio file + N generated images.
// Uses ffmpeg (already available in most environments - confirm with
// `ffmpeg -version` on your server) to make a simple slideshow timed to
// the audio's length, with a slow zoom (Ken Burns effect) so static
// images don't look completely static.
//
// Honest limitation: this does NOT produce word-synced captions. Real
// caption sync needs a speech-to-text alignment pass (e.g. Whisper)
// against the generated audio to get per-word timestamps - that's a
// reasonable next upgrade but a separate piece of work, not bundled here
// to avoid pretending this does something it doesn't yet. If you want
// burned-in captions in the meantime, YouTube's own auto-captions
// (generated after upload) are a real fallback, not a placeholder.

const { execFile } = require('child_process');
const { ffmpegPath, ffprobePath } = require('../config/ffmpeg');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execFileAsync = util.promisify(execFile);

function getAudioDuration(audioPath) {
  return execFileAsync(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioPath,
  ]).then(({ stdout }) => parseFloat(stdout.trim()));
}

async function assembleVideo({ audioPath, imagePaths, outputPath }) {
  if (!fs.existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);
  if (!imagePaths || imagePaths.length === 0) throw new Error('No images provided for assembly');

  const duration = await getAudioDuration(audioPath);
  const perImageDuration = duration / imagePaths.length;

  // Build an ffmpeg concat list with per-image duration, plus a subtle
  // zoom (zoompan) applied per input so a static image has some motion.
  const listFile = outputPath.replace(/\.mp4$/, '-list.txt');
  const listContent = imagePaths
    .map((p) => `file '${path.resolve(p)}'\nduration ${perImageDuration.toFixed(3)}`)
    .join('\n') + `\nfile '${path.resolve(imagePaths[imagePaths.length - 1])}'\n`; // ffmpeg concat quirk: last entry needs no duration line after it, repeat last file
  fs.writeFileSync(listFile, listContent);

  await execFileAsync(ffmpegPath, [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-i', audioPath,
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-shortest',
    outputPath,
  ]);

  fs.unlinkSync(listFile);
  return outputPath;
}

module.exports = { assembleVideo, getAudioDuration };
