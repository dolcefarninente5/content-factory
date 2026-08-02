// Script drafting via Claude API.
// Requires ANTHROPIC_API_KEY in .env
//
// This produces a FIRST DRAFT only. Per the pipeline design, every draft
// must go through a human edit pass (script_final, edited_by_human=1)
// before it can move to voice generation. Do not wire this to skip that step.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function draftScript({ sourceText, angle, persona }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set in .env - see README for setup');
  }

  const prompt = `You are drafting a Darija storytelling video script (8-12 minutes narrated) for a YouTube channel.
Channel persona/tone: ${persona || 'not set - configure in channel settings'}
Story angle: ${angle || 'general'}
Source material (submitted story, may be rough): ${sourceText}

Write a first-draft narration script in Darija. Structure: hook (first 15 seconds), setup, escalation, twist/resolution, closing line.
This is a DRAFT for human editing, not final output - keep it natural, not overly polished.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === 'text');
  return {
    text: textBlock ? textBlock.text : '',
    inputTokens: data.usage ? data.usage.input_tokens : 0,
    outputTokens: data.usage ? data.usage.output_tokens : 0,
  };
}

module.exports = { draftScript };
