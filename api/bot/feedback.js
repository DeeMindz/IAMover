import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function logDebug(msg, data) {
    console.log(`[Feedback API] ${msg}`, data ? JSON.stringify(data) : '');
}

export default async function handler(req, res) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'false');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (!supabase) {
        logDebug('Error', 'Missing Supabase credentials');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    try {
        const { id, bot_id, conversation_id, message_text, rating, comment } = req.body;

        if (id) {
            // Update existing feedback (e.g., adding a comment after thumbs down)
            const { data, error } = await supabase
                .from('message_feedback')
                .update({ rating: rating || undefined, comment: comment || undefined })
                .eq('id', id)
                .select()
                .single();
            if (error) throw error;
            return res.status(200).json(data);
        } else {
            // Insert new feedback
            if (!bot_id || !conversation_id || !message_text || !rating) {
                return res.status(400).json({ error: 'Missing required fields' });
            }
            const { data, error } = await supabase
                .from('message_feedback')
                .insert({ bot_id, conversation_id, message_text, rating, comment })
                .select()
                .single();
            if (error) throw error;
            return res.status(200).json(data);
        }
    } catch (error) {
        logDebug('Execution error', error.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
