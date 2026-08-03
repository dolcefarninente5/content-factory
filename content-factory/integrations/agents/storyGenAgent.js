// Story generation agent. Generates ORIGINAL fictional Darija stories -
// deliberately instead of scraping stories from forums/Wattpad, which
// would be monetizing other authors' copyrighted work without permission.
//
// Generated stories land in the normal Story review queue and get
// auto-scored like any submission, so your approval gate still applies.

const db = require('../../db/db');
const { isTestMode, checkBudget } = require('../../config/settings');
const { COST_MODEL } = require('../../config/costModel');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const ANGLES = ['betrayal', 'family inheritance dispute', 'workplace revenge', 'marriage secret', 'neighbor conflict', 'in-law drama'];

async function generateStory(channelId) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) throw new Error(`channel ${channelId} not found`);

  const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
  let storyText;
  let cost = 0;

  if (isTestMode()) {
    storyText = `[TEST MODE - placeholder story] Wahda qissa khayaliya 3la ${angle}. (Switch to Real Mode on the Settings page to generate actual original stories with AI.)`;
  } else {
    checkBudget();
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set - story generation needs it in Real Mode');

    const prompt = `Write an ORIGINAL fictional dramatic story premise in Moroccan Darija (Arabic script), 150-250 words, on the theme: ${angle}.
Channel persona it should suit: ${channel.persona || 'general Darija storytelling'}.
Make it specific and vivid (names, places, one sharp twist) but entirely fictional - do not retell any known real story.
Respond with ONLY the story text, no preamble.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Claude API error: ${response.status} ${await response.text()}`);
    const data = await response.json();
    storyText = data.content.find((b) => b.type === 'text').text;
    const usage = data.usage || { input_tokens: 0, output_tokens: 0 };
    cost = ((usage.input_tokens + usage.output_tokens) / 1000) * COST_MODEL.llmCostPer1kTokens;
  }

  const info = db
    .prepare(`INSERT INTO stories (channel_id, source_text, source_type, angle, produce_status) VALUES (?, ?, 'ai_generated', ?, 'pending')`)
    .run(channelId, storyText, angle);

  db.prepare(`INSERT INTO spend_log (video_id, channel_id, provider, description, amount, test_mode) VALUES (NULL, ?, 'anthropic', 'story generation', ?, ?)`)
    .run(channelId, Math.round(cost * 10000) / 10000, isTestMode() ? 1 : 0);

  return { storyId: info.lastInsertRowid, angle };
}

module.exports = { generateStory };
