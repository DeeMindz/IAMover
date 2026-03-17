// Vercel API route for creating conversation
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
    // Add CORS headers - handle null origin from srcdoc iframes
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { bot_id, user_id, user_identifier, metadata } = req.body;

        if (!bot_id) {
            return res.status(400).json({ error: 'Missing bot_id' });
        }

        // Build metadata from request body or use defaults
        const conversationMetadata = metadata || {
            page_url: req.body.page_url || null,
            referrer_url: req.body.referrer_url || null,
            page_title: req.body.page_title || null,
            browser_language: req.body.browser_language || null,
            user_timezone: req.body.user_timezone || null,
            device_type: req.body.device_type || null,
            user_platform: req.body.user_platform || null,
            started_at: new Date().toISOString(),
        };

        const { data: conversation, error } = await supabase
            .from('conversations')
            .insert({
                bot_id,
                user_id: user_id || null,
                user_identifier: user_identifier || 'anonymous_' + Math.random().toString(36).substr(2, 8),
                status: 'active',
                hitl_active: false,
                metadata: conversationMetadata
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
