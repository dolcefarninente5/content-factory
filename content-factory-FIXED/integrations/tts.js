// Darija text-to-speech via ElevenLabs.
//
// Why ElevenLabs specifically: it supports voice CLONING, which matters
// more here than picking from a generic Darija voice bank - a cloned
// voice from a real recorded sample tends to hold up better on long
// emotional narration than generic multilingual TTS (see the earlier
// conversation on Darija TTS being unproven on dramatic long-form text).
//
// One-time setup per channel:
//   1. Record ~2-3 minutes of a real voice reading varied Darija sentences
//      (or license/hire a voice actor - don't use someone's voice without
//      consent)
//   2. In ElevenLabs' dashboard, create an "Instant Voice Clone" from that
//      sample, note the resulting voice_id
//   3. Put that voice_id in the channel's settings on the Channels page
//
// Model: uses eleven_multilingual_v2, which handles Arabic script and
// French code-switching reasonably - test it on a real script before
// trusting it on a batch.

const fs = require('fs');
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

async function synthesizeVoice({ scriptText, voiceId, outputPath }) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY not set in .env');
  }
  if (!voiceId) {
    throw new Error('No voice_id set for this channel - add one on the Channels page (see setup notes in this file)');
  }

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: scriptText,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} ${errText}`);
  }

  const audioBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(audioBuffer));
  return outputPath;
}

module.exports = { synthesizeVoice };
