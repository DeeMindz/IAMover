// api/agent/leave.js
// Agent ends HITL and returns conversation to bot
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { conversation_id } = req.body;
    if (!conversation_id) {
        return res.status(400).json({ error: 'conversation_id is required' });
    }

    try {
        // Mark conversation as no longer HITL
        const { error: updateErr } = await supabase
            .from('conversations')
            .update({
                hitl_active: false,
                claimed_by: null,
                agent_typing: false,
                updated_at: new Date().toISOString(),
            })
            .eq('id', conversation_id);

        if (updateErr) throw updateErr;

        // Insert system notification — widget polls this and shows "bot resumed"
        const { error: msgErr } = await supabase
            .from('messages')
            .insert({
                conversation_id,
                role: 'system',
                content: 'agent_left',
            });

        if (msgErr) throw msgErr;

        return res.status(200).json({ success: true, hitl_active: false });

    } catch (error) {
        console.error('[Agent Leave] Error:', error);
        return res.status(500).json({ error: error.message });
    }
}
