// AI-generated visuals per video via Stability AI (Stable Image Core).
// Deliberately not stock footage - each channel has its own
// image_style_prompt (set on the Channels page) so the 3-5 channels
// don't look like clones of each other.
//
// Cost note: check Stability's current per-image pricing in your
// account before running a batch - config/costModel.js's
// imageCostPerImage is a placeholder until you plug in the real number.

const fs = require('fs');
const path = require('path');
const STABILITY_API_KEY = process.env.STABILITY_API_KEY;

// Very simple scene splitter: breaks the script into `count` roughly
// equal chunks by sentence, then uses the FIRST sentence of each chunk
// as the visual prompt seed. This is a starting heuristic, not a real
// scene-detection system - if the visuals don't track the narration
// well, this is the function to improve first (e.g. asking Claude to
// pick the count most visually distinct moments in the script instead
// of a blind even split).
function splitIntoScenes(scriptText, count) {
  const sentences = scriptText.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length === 0) return [scriptText];
  const chunkSize = Math.max(1, Math.ceil(sentences.length / count));
  const scenes = [];
  for (let i = 0; i < sentences.length; i += chunkSize) {
    scenes.push(sentences.slice(i, i + chunkSize).join(' '));
  }
  return scenes.slice(0, count);
}

async function generateImages({ scriptText, stylePrompt, count = 6, outputDir }) {
  if (!STABILITY_API_KEY) {
    throw new Error('STABILITY_API_KEY not set in .env');
  }
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const scenes = splitIntoScenes(scriptText, count);
  const paths = [];

  for (let i = 0; i < scenes.length; i++) {
    const prompt = `${stylePrompt || 'cinematic, realistic, warm lighting'}. Scene: ${scenes[i]}`.slice(0, 900);

    const form = new FormData();
    form.append('prompt', prompt);
    form.append('output_format', 'png');
    form.append('aspect_ratio', '16:9');

    const response = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STABILITY_API_KEY}`,
        Accept: 'image/*',
      },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Stability AI error on scene ${i + 1}/${scenes.length}: ${response.status} ${errText}`);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    const filePath = path.join(outputDir, `scene-${String(i + 1).padStart(2, '0')}.png`);
    fs.writeFileSync(filePath, buf);
    paths.push(filePath);
  }

  return paths;
}

module.exports = { generateImages, splitIntoScenes };
