// Vercel API route for creating conversation
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const {
            bot_id,
            user_id,
            page_url,
            referrer_url,
            page_title,
            browser_language,
            user_timezone,
            device_type,
            user_platform,
        } = req.body;

        if (!bot_id) {
            return res.status(400).json({ error: 'bot_id is required' });
        }

        // visitor_id is a persistent anonymous browser ID
        // It looks like vis_abc123xyz and is stored in the visitor's localStorage
        // It has NOTHING to do with Supabase Auth
        const visitor_id = user_id || 'anonymous_' + Math.random().toString(36).substr(2, 9);

        console.log(JSON.stringify({
            level: 'INFO', step: 'conversation_create',
            msg: 'Request received',
            bot_id, visitor_id
        }));

        // Check if this visitor already has an active conversation
        // with this bot in the last 24 hours
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        const { data: existing, error: lookupError } = await supabase
            .from('conversations')
            .select('id')
            .eq('bot_id', bot_id)
            .eq('user_id', visitor_id)
            .eq('status', 'active')
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (lookupError) {
            console.warn(JSON.stringify({ level: 'WARN', msg: 'Lookup error', error: lookupError.message }));
        }

        if (existing) {
            console.log(JSON.stringify({
                level: 'INFO', msg: 'Returning visitor — reusing conversation',
                conversation_id: existing.id, visitor_id
            }));
            return res.status(200).json({
                conversation_id: existing.id,
                returning: true
            });
        }

        // Create new conversation
        const { data: conversation, error: convError } = await supabase
            .from('conversations')
            .insert({
                bot_id,
                user_id: visitor_id,
                status: 'active',
                hitl_active: false,
                metadata: {
                    page_url: page_url || null,
                    referrer_url: referrer_url || null,
                    page_title: page_title || null,
                    browser_language: browser_language || null,
                    user_timezone: user_timezone || null,
                    device_type: device_type || null,
                    user_platform: user_platform || null,
                    started_at: new Date().toISOString(),
                }
            })
            .select()
            .single();

        if (convError) {
            console.error(JSON.stringify({ level: 'ERROR', msg: 'Insert failed', error: convError.message }));
            throw convError;
        }

        console.log(JSON.stringify({
            level: 'INFO', msg: 'New conversation created',
            conversation_id: conversation.id, visitor_id
        }));

        // Save the bot greeting as the first message
        const { data: bot } = await supabase
            .from('bots')
            .select('greeting_message')
            .eq('id', bot_id)
            .single();

        if (bot?.greeting_message) {
            await supabase.from('messages').insert({
                conversation_id: conversation.id,
                role: 'bot',
                content: bot.greeting_message
            });
        }

        return res.status(200).json({
            conversation_id: conversation.id,
            returning: false
        });

    } catch (error) {
        console.error(JSON.stringify({
            level: 'ERROR', msg: 'Unhandled error in conversation/create',
            error: error.message
        }));
        return res.status(500).json({ error: error.message });
    }
}
