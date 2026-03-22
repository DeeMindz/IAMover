// api/conversation/messages.js
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

    const { conversation_id, after } = req.query;
    if (!conversation_id) {
        return res.status(400).json({ error: 'conversation_id is required' });
    }

    try {
        let query = supabase
            .from('messages')
            .select('id, role, content, created_at')
            .eq('conversation_id', conversation_id)
            .order('created_at', { ascending: true })
            .limit(100);

        // If `after` is provided, only return messages newer than that timestamp
        // This is used by the widget polling during HITL to get incremental updates
        if (after) {
            query = query.gt('created_at', after);
        }

        const { data: messages, error } = await query;
        if (error) throw error;

        // Also return current conversation HITL status so widget knows
        // when agent has left and can stop polling
        const { data: conv } = await supabase
            .from('conversations')
            .select('hitl_active, agent_typing')
            .eq('id', conversation_id)
            .single();

        return res.status(200).json({
            messages: messages || [],
            hitl_active: conv?.hitl_active || false,
            agent_typing: conv?.agent_typing || false,
        });

    } catch (error) {
        console.error('Messages fetch error:', error);
        return res.status(500).json({ error: error.message });
    }
}
