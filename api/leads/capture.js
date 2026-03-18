// Vercel API route for capturing leads
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
        const { bot_id, conversation_id, name, email, phone, company, data } = req.body;

        if (!bot_id || !email) {
            return res.status(400).json({ error: 'Missing bot_id or email' });
        }

        const { data: lead, error } = await supabase
            .from('leads')
            .insert({
                bot_id,
                conversation_id: conversation_id || null,
                name: name || null,
                email,
                phone: phone || null,
                company: company || null,
                extra_data: data || {},
                status: 'cold'
            })
            .select()
            .single();

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json(lead);
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
