const db = require('../../db/db');
const { estimateProductionCost, estimateRevenue } = require('../../config/costModel');
const { isTestMode } = require('../../config/settings');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function scoreWithClaude(story, channel, topPerformers) {
  const prompt = `You are screening a candidate story for a Darija YouTube storytelling channel, deciding whether it's worth producing.

Channel persona: ${channel.persona || 'not set'}
This channel's actual best-performing past videos (title / views), if any:
${topPerformers.length ? topPerformers.map(t => `- "${t.title}" (${t.actual_views} views)`).join('\n') : '(no performance history yet for this channel)'}

Candidate story (submitted angle: ${story.angle || 'none given'}):
"""
${story.source_text}
"""

Score this story 0-100 for how likely it is to perform well on THIS channel, and explain your reasoning in 2-4 concrete sentences referencing specific elements of the story (not generic praise). If there's no performance history yet, say so plainly and score based on genre fit and specificity/shock-value of the story elements instead.

Respond ONLY as JSON: {"score": <number>, "reasoning": "<text>"}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === 'text');
  try {
    const jsonText = textBlock.text.trim().replace(/^```json\n?|```$/g, '');
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Could not parse agent response as JSON: ${textBlock.text}`);
  }
}

// Scores one candidate story for one channel. Writes score + reasoning +
// cost/revenue estimate back onto the story row. The reasoning text is
// what you read on the Story review page before approving production.
async function scoreStory(storyId) {
  const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(storyId);
  if (!story) throw new Error(`story ${storyId} not found`);

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(story.channel_id);

  const topPerformers = db
    .prepare(
      `SELECT title, actual_views FROM videos
       WHERE channel_id = ? AND actual_views IS NOT NULL
       ORDER BY actual_views DESC LIMIT 5`
    )
    .all(story.channel_id);

  let scoreResult;
  if (isTestMode()) {
    scoreResult = {
      score: 65,
      reasoning: '[TEST MODE - not a real evaluation] Placeholder score. Switch to Real Mode on the Settings page for an actual assessment from Claude.',
    };
  } else {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set in .env - sourcing agent needs it to score stories');
    }
    scoreResult = await scoreWithClaude(story, channel, topPerformers);
  }

  const stats = db.prepare('SELECT * FROM channel_stats WHERE channel_id = ?').get(story.channel_id);
  const cost = estimateProductionCost({});
  const revenue = estimateRevenue({ channelAvgViews: stats ? stats.avg_views_per_video : null });

  db.prepare(
    `UPDATE stories SET score = ?, reasoning = ?, est_cost = ?, est_views = ?, est_revenue = ? WHERE id = ?`
  ).run(scoreResult.score, scoreResult.reasoning, cost.total, revenue.estViews, revenue.estRevenue, storyId);

  return { score: scoreResult.score, reasoning: scoreResult.reasoning, cost, revenue, hasHistory: !!stats };
}

module.exports = { scoreStory };
