// Vercel API route for bot response
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { message, bot_id, system_vars } = req.body;

        if (!message || !bot_id) {
            return res.status(400).json({ error: 'Missing message or bot_id' });
        }

        // Get bot configuration
        const { data: bot, error: botError } = await supabase
            .from('bots')
            .select('*, bot_variables(*), knowledge_bases(*), kb_files(*)')
            .eq('id', bot_id)
            .single();

        if (botError || !bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        // Build context from system vars and bot config
        const context = {
            ...system_vars,
            bot_name: bot.name,
            bot_model: bot.model,
            greeting: bot.greeting_message,
            system_prompt: bot.system_prompt,
        };

        // TODO: Integrate with OpenAI or Anthropic here
        // For now, return a simple response
        const response = `I received your message: "${message}". This is a placeholder response. Configure your LLM API to enable AI responses.`;

        return res.status(200).json({ response });
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
