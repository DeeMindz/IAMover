// Vercel API route for fetching conversation messages
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

    const { conversation_id } = req.query;
    if (!conversation_id) {
        return res.status(400).json({ error: 'conversation_id is required' });
    }

    try {
        const { data: messages, error } = await supabase
            .from('messages')
            .select('role, content, created_at')
            .eq('conversation_id', conversation_id)
            .order('created_at', { ascending: true })
            .limit(50);

        if (error) throw error;

        return res.status(200).json({ messages: messages || [] });
    } catch (error) {
        console.error('Messages fetch error:', error);
        return res.status(500).json({ error: error.message });
    }
}
