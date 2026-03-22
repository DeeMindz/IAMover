// api/agent/send.js
// Agent sends a message to a conversation during HITL
// Called by the dashboard when the agent types and submits
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

    const { conversation_id, content, agent_id } = req.body;
    if (!conversation_id || !content?.trim()) {
        return res.status(400).json({ error: 'conversation_id and content are required' });
    }

    try {
        // Verify conversation is in HITL mode
        const { data: conv, error: convErr } = await supabase
            .from('conversations')
            .select('id, hitl_active, bot_id')
            .eq('id', conversation_id)
            .single();

        if (convErr || !conv) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        if (!conv.hitl_active) {
            return res.status(400).json({ error: 'Conversation is not in HITL mode' });
        }

        // Insert the agent message
        const { data: message, error: msgErr } = await supabase
            .from('messages')
            .insert({
                conversation_id,
                role: 'human-agent',
                content: content.trim(),
            })
            .select('id, role, content, created_at')
            .single();

        if (msgErr) throw msgErr;

        // Update conversation timestamp
        await supabase
            .from('conversations')
            .update({ 
                updated_at: new Date().toISOString(),
                agent_typing: false,
            })
            .eq('id', conversation_id);

        return res.status(200).json({
            success: true,
            message,
        });

    } catch (error) {
        console.error('[Agent Send] Error:', error);
        return res.status(500).json({ error: error.message });
    }
}
