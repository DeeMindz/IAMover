// Vercel API route for creating conversation
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { bot_id, user_id, metadata } = req.body;

        if (!bot_id) {
            return res.status(400).json({ error: 'Missing bot_id' });
        }

        const { data: conversation, error } = await supabase
            .from('conversations')
            .insert({
                bot_id,
                user_id: user_id || null,
                metadata: metadata || {},
                status: 'active'
            })
            .select()
            .single();

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json(conversation);
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
