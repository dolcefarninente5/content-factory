const db = require('./db');

const channelCount = db.prepare('SELECT COUNT(*) as c FROM channels').get().c;

if (channelCount === 0) {
  const insertChannel = db.prepare(`
    INSERT INTO channels (name, persona, voice_id, upload_days)
    VALUES (@name, @persona, @voice_id, @upload_days)
  `);

  const channels = [
    { name: 'Channel 1 - Placeholder', persona: 'Describe the narrator persona and tone here', voice_id: 'voice_1', upload_days: 'mon,thu' },
    { name: 'Channel 2 - Placeholder', persona: 'Describe the narrator persona and tone here', voice_id: 'voice_2', upload_days: 'tue,fri' },
    { name: 'Channel 3 - Placeholder', persona: 'Describe the narrator persona and tone here', voice_id: 'voice_3', upload_days: 'wed,sat' },
  ];

  for (const ch of channels) insertChannel.run(ch);

  console.log(`Seeded ${channels.length} channels. Edit names/personas in the dashboard or directly in data/factory.db.`);
} else {
  console.log(`Channels already exist (${channelCount}) - skipping seed.`);
}
