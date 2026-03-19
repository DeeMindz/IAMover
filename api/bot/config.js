// api/bot/config.js
// Public endpoint — no auth required
// Called by widget.js to get bot name, avatar, color, greeting

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { bot_id } = req.query;
  if (!bot_id) return res.status(400).json({ error: 'bot_id is required' });

  const { data: bot, error } = await supabase
    .from('bots')
    .select('id, name, color, greeting_message, theme')
    .eq('id', bot_id)
    .single();

  if (error || !bot) return res.status(404).json({ error: 'Bot not found' });

  // Return only public fields — no system prompt, no API keys
  return res.status(200).json({
    id:          bot.id,
    name:        bot.name,
    displayName: bot.theme?.displayName || bot.name,
    color:       bot.theme?.primaryColor || bot.color || '#6c63ff',
    avatarUrl:   bot.theme?.avatarUrl || '',
    greeting:    bot.greeting_message || 'Hi! How can I help you today?',
    position:    bot.theme?.position || 'bottom-right',
  });
}
