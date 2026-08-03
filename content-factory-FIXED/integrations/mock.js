// Test Mode providers. These stand in for the real paid APIs so you can
// click through the entire pipeline - scoring, scripting, voice, visuals,
// assembly, "publishing" - and see exactly how it behaves, without
// spending a cent or needing any API key at all. Switch to Real Mode on
// the Settings page when you're ready to spend real money.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ffmpegPath, ffprobePath } = require('../config/ffmpeg');
const util = require('util');
const execFileAsync = util.promisify(execFile);

async function mockDraftScript({ sourceText, angle, persona }) {
  return `[TEST MODE - not a real AI script]\n\nHook: A story about ${angle || 'a dramatic event'}.\n\nBased on: ${(sourceText || '').slice(0, 200)}\n\n(This is placeholder text standing in for a real Claude-drafted script. Switch to Real Mode on the Settings page to generate actual scripts.)`;
}

async function mockSynthesizeVoice({ outputPath }) {
  // A few seconds of silence-adjacent tone, just so assembly has a real
  // audio file with a real duration to work against.
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await execFileAsync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', outputPath]);
  return outputPath;
}

async function mockGenerateImages({ count = 6, outputDir }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const colors = ['navy', 'maroon', 'darkgreen', 'purple', 'teal', 'olive', 'indigo', 'brown'];
  const paths = [];
  for (let i = 0; i < count; i++) {
    const filePath = path.join(outputDir, `scene-${String(i + 1).padStart(2, '0')}.png`);
    await execFileAsync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `color=c=${colors[i % colors.length]}:s=1280x720`, '-frames:v', '1', filePath]);
    paths.push(filePath);
  }
  return paths;
}

async function mockUploadVideo({ title }) {
  return { youtubeVideoId: `TEST-${Date.now()}` };
}

module.exports = { mockDraftScript, mockSynthesizeVoice, mockGenerateImages, mockUploadVideo };
