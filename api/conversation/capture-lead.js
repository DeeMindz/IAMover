// api/conversation/capture-lead.js
// Saves pre-chat form data (name, email) to the leads table.
// Called by the widget immediately when the user submits the pre-chat form.
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

    const { bot_id, conversation_id, name, email, phone, company } = req.body;

    if (!bot_id || !conversation_id) {
        return res.status(400).json({ error: 'bot_id and conversation_id are required' });
    }
    if (!name && !email) {
        return res.status(400).json({ error: 'At least name or email is required' });
    }

    try {
        // Check by email first (global dedup key)
        let existingLead = null;

        if (email) {
            const { data: byEmail } = await supabase
                .from('leads')
                .select('id, conversation_id, name, email, phone, company')
                .eq('email', email)
                .limit(1)
                .maybeSingle();
            existingLead = byEmail;
        }

        if (!existingLead) {
            const { data: byConv } = await supabase
                .from('leads')
                .select('id, conversation_id, name, email, phone, company')
                .eq('conversation_id', conversation_id)
                .limit(1)
                .maybeSingle();
            existingLead = byConv;
        }

        if (existingLead) {
            // Update missing fields only
            const updates = {};
            if (name    && !existingLead.name)    updates.name    = name;
            if (email   && !existingLead.email)   updates.email   = email;
            if (phone   && !existingLead.phone)   updates.phone   = phone;
            if (company && !existingLead.company) updates.company = company;
            if (existingLead.conversation_id !== conversation_id) updates.conversation_id = conversation_id;

            if (Object.keys(updates).length > 0) {
                const { data, error } = await supabase
                    .from('leads')
                    .update(updates)
                    .eq('id', existingLead.id)
                    .select()
                    .single();
                if (error) throw error;
                return res.status(200).json({ lead: data, action: 'updated' });
            }
            return res.status(200).json({ lead: existingLead, action: 'unchanged' });

        } else {
            // Create new lead
            const { data, error } = await supabase
                .from('leads')
                .insert({
                    bot_id,
                    conversation_id,
                    name:       name    || null,
                    email:      email   || null,
                    phone:      phone   || null,
                    company:    company || null,
                    status:     'cold',
                    extra_data: {}
                })
                .select()
                .single();
            if (error) throw error;
            return res.status(200).json({ lead: data, action: 'created' });
        }

    } catch (err) {
        console.error('[capture-lead] Error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}
