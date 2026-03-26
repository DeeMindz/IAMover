// Vercel API route for bot response
import { createClient } from '@supabase/supabase-js';

// Use service role key to bypass RLS for bot operations
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Structured logger for Vercel function logs
const log = {
    info: (msg, data) => console.log(JSON.stringify({ level: 'info', message: msg, ...data })),
    warn: (msg, data) => console.warn(JSON.stringify({ level: 'warn', message: msg, ...data })),
    error: (msg, data) => console.error(JSON.stringify({ level: 'error', message: msg, ...data }))
};

// ── Model Maps ──────────────────────────────────────────────────────────────
// Model-agnostic design: adding a new provider only requires adding it below
// and adding a new branch in the provider routing section

const GEMINI_MODEL_MAP = {
    // Gemini 2.5 (stable — recommended)
    'gemini-2.5-flash':              'gemini-2.5-flash',
    'gemini-2.5-flash-lite':         'gemini-2.5-flash-lite',
    'gemini-2.5-pro':                'gemini-2.5-pro',
    // Gemini 3 (preview)
    'gemini-3-flash-preview':        'gemini-3-flash-preview',
    'gemini-3.1-pro-preview':        'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite-preview',
    // Shortcuts
    'gemini-flash':                  'gemini-2.5-flash',
    'gemini-latest':                 'gemini-3-flash-preview',
};

const OPENAI_MODEL_MAP = {
    'gpt-4o':              'gpt-4o',
    'gpt-4o-mini':         'gpt-4o-mini',
    'o1':                  'o1',
    'o1-mini':             'o1-mini',
    'o1-preview':          'o1-preview',
    'o3':                  'o3',
    'o3-mini':             'o3-mini',
    'o4-mini':             'o4-mini',
    'gpt-4-turbo':         'gpt-4-turbo',
    'gpt-4':               'gpt-4',
    'gpt-3.5-turbo':       'gpt-3.5-turbo',
    'gpt-3.5-turbo-16k':   'gpt-3.5-turbo-16k',
};

// ── Main Handler ────────────────────────────────────────────────────────────

// ── Lead extraction helper ────────────────────────────────────────────────────
// Uses a fast LLM call to extract structured lead data from conversation.
// Runs after the main response — does not block user-facing latency.
async function extractAndSaveLead({ bot_id, conversation_id, supabase, log }) {
    try {
        const { data: msgs } = await supabase
            .from('messages')
            .select('role, content')
            .eq('conversation_id', conversation_id)
            .order('created_at', { ascending: true })
            .limit(30);

        if (!msgs || msgs.length < 2) return;

        const conversationText = msgs
            .filter(m => m.role === 'user' || m.role === 'bot')
            .map(m => (m.role === 'user' ? 'User: ' : 'Bot: ') + m.content)
            .join('\n');

        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (!apiKey) { log.warn('No API key for lead extraction'); return; }

        // gemini-1.5-flash is stable — gemini-2.0-flash does NOT exist in v1beta
        const extractRes = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text:
                        'Extract contact information from this conversation. Return ONLY valid JSON or the word none.\n\n' +
                        'Conversation:\n' + conversationText + '\n\n' +
                        'Return JSON: {"name":"...","email":"...","phone":"...","company":"..."}\n' +
                        'Only include fields clearly stated by the user. Omit fields not mentioned. Return none if no contact info found.'
                    }] }],
                    generationConfig: { maxOutputTokens: 200, temperature: 0 }
                })
            }
        );

        if (!extractRes.ok) {
            log.warn('Lead extraction API error', { status: extractRes.status });
            return;
        }

        const exData = await extractRes.json();
        const raw = (exData.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        log.info('Lead extraction raw result', { raw: raw.slice(0, 100) });

        if (!raw || raw.toLowerCase().trim() === 'none') return;

        let extracted;
        try {
            extracted = JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        } catch (parseErr) {
            log.warn('Lead JSON parse failed', { raw: raw.slice(0, 100) });
            return;
        }

        if (!extracted.email && !extracted.name) return;

        log.info('Lead data extracted', { name: extracted.name, email: extracted.email });

        // Dedup: email is the global primary key; fallback to conversation_id
        let existingLead = null;

        if (extracted.email) {
            const { data: byEmail } = await supabase
                .from('leads')
                .select('id, conversation_id, name, email, phone, company')
                .eq('email', extracted.email)
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
            const updates = {};
            if (extracted.name    && !existingLead.name)    updates.name    = extracted.name;
            if (extracted.email   && !existingLead.email)   updates.email   = extracted.email;
            if (extracted.phone   && !existingLead.phone)   updates.phone   = extracted.phone;
            if (extracted.company && !existingLead.company) updates.company = extracted.company;
            if (existingLead.conversation_id !== conversation_id) updates.conversation_id = conversation_id;

            if (Object.keys(updates).length > 0) {
                await supabase.from('leads').update(updates).eq('id', existingLead.id);
                log.info('Lead updated', { lead_id: existingLead.id, updates });
            } else {
                log.info('Lead already complete — no update needed', { lead_id: existingLead.id });
            }
        } else {
            const { data: newLead, error: insErr } = await supabase
                .from('leads')
                .insert({
                    bot_id,
                    conversation_id,
                    name:       extracted.name    || null,
                    email:      extracted.email   || null,
                    phone:      extracted.phone   || null,
                    company:    extracted.company || null,
                    status:     'cold',
                    extra_data: {}
                })
                .select('id')
                .single();
            if (insErr) {
                log.warn('Lead insert failed', { error: insErr.message });
            } else {
                log.info('Lead created', { lead_id: newLead?.id, name: extracted.name, email: extracted.email });
            }
        }
    } catch (e) {
        log.warn('Lead extraction crashed', { error: e.message });
    }
}


export default async function handler(req, res) {
    // CORS — handle null origin from srcdoc iframes
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Verify env vars
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        log.error('Missing Supabase env vars', {});
        return res.status(500).json({ error: 'Server configuration error' });
    }

    // Startup log — useful for debugging env vars in Vercel
    log.info('Startup check', {
        hasUrl:        !!process.env.SUPABASE_URL,
        hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        keyLength:     process.env.SUPABASE_SERVICE_ROLE_KEY?.length || 0,
        hasGeminiKey:  !!process.env.GEMINI_API_KEY,
        hasOpenAIKey:  !!process.env.OPENAI_API_KEY,
        hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    });

    try {
        // FIX 1: conversation_id in first destructure
        const { message, bot_id, conversation_id, system_vars, user_language } = req.body;

        log.info('Incoming request', { bot_id, conversation_id: conversation_id || 'none', messageLength: message?.length, user_language });

        if (!message || !bot_id) {
            log.warn('Missing required fields', { hasMessage: !!message, hasBotId: !!bot_id });
            return res.status(400).json({ error: 'Missing message or bot_id' });
        }

        // ── Step 1: Load bot config ─────────────────────────────────────────
        const { data: bot, error: botError } = await supabase
            .from('bots')
            .select('*')
            .eq('id', bot_id)
            .single();

        if (botError || !bot) {
            log.error('Bot not found', { bot_id, error: botError?.message });
            return res.status(404).json({ error: 'Bot not found' });
        }

        log.info('Bot loaded', { botName: bot.name, model: bot.model, antiHallucination: bot.anti_hallucination });

        // ── Load custom Autonomous Actions ─────────────────────────────────────
        const { data: botActions } = await supabase
            .from('bot_actions')
            .select('*')
            .eq('bot_id', bot_id);
        const hasActions = botActions && botActions.length > 0;

        // ── HITL Check: if human agent is active, do not call LLM ──────────
        if (conversation_id) {
            const { data: convCheck } = await supabase
                .from('conversations')
                .select('hitl_active')
                .eq('id', conversation_id)
                .single();

            if (convCheck?.hitl_active) {
                log.info('HITL active — skipping LLM response', { conversation_id });
                // Still save the user message so agent can see it
                await supabase.from('messages').insert({
                    conversation_id,
                    role: 'user',
                    content: message
                });
                return res.status(200).json({ response: null, hitl_active: true });
            }
        }

        // ── Step 2: Semantic search over KB chunks (RAG) ───────────────────
        let knowledgeContext = '';
        const { data: kbLinks } = await supabase
            .from('bot_knowledge_bases')
            .select('kb_id')
            .eq('bot_id', bot_id);

        if (kbLinks && kbLinks.length > 0) {
            const kbIds = kbLinks.map(k => k.kb_id);
            log.info('KB attached', { kbCount: kbIds.length });

            try {
                // Embed the user message for semantic search
                const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
                // gemini-embedding-001 via v1beta — text-embedding-004 was shut down Jan 14 2026
                const embedRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: 'models/gemini-embedding-001',
                            content: { parts: [{ text: message }] },
                            taskType: 'RETRIEVAL_QUERY',
                            outputDimensionality: 1536,
                        })
                    }
                );

                if (embedRes.ok) {
                    const embedData = await embedRes.json();
                    const queryVec = embedData.embedding.values;
                    const vectorStr = '[' + queryVec.join(',') + ']';

                    // Semantic similarity search in pgvector
                    const { data: chunks, error: searchErr } = await supabase.rpc('match_kb_chunks', {
                        query_embedding:      vectorStr,
                        kb_ids_filter:        kbIds,
                        match_count:          6,
                        similarity_threshold: 0.4,
                    });

                    if (searchErr) {
                        log.warn('Semantic search failed, falling back to content stuffing', { error: searchErr.message });
                        // Fallback: load raw content from kb_files
                        const { data: files } = await supabase
                            .from('kb_files')
                            .select('name, content')
                            .in('kb_id', kbIds)
                            .not('content', 'is', null)
                            .limit(10);

                        const filesWithContent = files?.filter(f => f.content?.trim().length > 0) || [];
                        if (filesWithContent.length > 0) {
                            knowledgeContext = '\n\n--- KNOWLEDGE BASE ---\n' +
                                filesWithContent.map(f => `[${f.name}]\n${f.content.slice(0, 3000)}`).join('\n\n') +
                                '\n--- END KNOWLEDGE BASE ---';
                        }
                    } else if (chunks && chunks.length > 0) {
                        log.info('Semantic search results', { chunks: chunks.length });
                        // Build source citations with the actual URL or filename so the frontend
                        // can render them as clickable links in the chat bubble.
                        knowledgeContext = '\n\n--- RELEVANT KNOWLEDGE BASE CONTENT ---\n' +
                            chunks.map((c, i) => {
                                const sourceUrl = c.metadata?.source_url;
                                const fileName  = c.metadata?.file_name || 'document';
                                // Use the URL as the source ref if available, otherwise the file name
                                const sourceRef = sourceUrl || fileName;
                                return `[Source ${i+1}: ${sourceRef}]\n${c.content}`;
                            }).join('\n\n') +
                            '\n--- END KNOWLEDGE BASE CONTENT ---';
                        log.info('RAG context built', { chars: knowledgeContext.length, chunks: chunks.length });

                    } else {
                        log.info('No relevant KB chunks found for this query', {});
                    }
                } else {
                    log.warn('Embedding failed for RAG', { status: embedRes.status });
                }
            } catch (ragErr) {
                log.warn('RAG pipeline error', { error: ragErr.message });
            }
        }

        // ── Step 3: Load conversation history ──────────────────────────────
        let conversationHistory = [];
        if (conversation_id) {
            const { data: messages } = await supabase
                .from('messages')
                .select('role, content')
                .eq('conversation_id', conversation_id)
                .order('created_at', { ascending: true })
                .limit(20);

            if (messages) {
                const mapped = messages
                    // Exclude system notification messages from LLM history
                    .filter(m => m.role === 'user' || m.role === 'bot' || m.role === 'human-agent')
                    .map(m => {
                        if (m.role === 'bot') return { role: 'assistant', content: m.content };
                        if (m.role === 'human-agent') return { role: 'assistant', content: `[Live Agent]: ${m.content}` };
                        return { role: 'user', content: m.content };
                    });

                // All LLMs require history to start with user role — trim leading assistant messages
                const firstUserIndex = mapped.findIndex(m => m.role === 'user');
                conversationHistory = firstUserIndex > -1 ? mapped.slice(firstUserIndex) : [];
                log.info('Conversation history loaded', { messages: conversationHistory.length });
            }
        }

        // ── Step 4: Save user message ───────────────────────────────────────
        if (conversation_id) {
            const { error: saveUserErr } = await supabase.from('messages').insert({
                conversation_id,
                role:    'user',
                content: message
            });
            if (saveUserErr) {
                log.warn('Failed to save user message', { error: saveUserErr.message });
            } else {
                log.info('User message saved', { conversation_id });
            }
        }

        // ── Step 5: Build system prompt ─────────────────────────────────────
        // Resolve temperature and token limit from saved bot settings
        const botTemperature = typeof bot.temperature === 'number' ? bot.temperature : 0.5;
        const botMaxTokens   = bot.max_response_length === 'short' ? 300
                             : bot.max_response_length === 'long'  ? 2048
                             : 1024; // medium (default)

        let systemPrompt = bot.system_prompt || 'You are a helpful AI assistant.';

        // ── Variable substitution ────────────────────────────────────────────
        const now = new Date();
        const padZ = n => String(n).padStart(2, '0');
        const builtInVars = {
            current_timestamp: `${now.getFullYear()}-${padZ(now.getMonth()+1)}-${padZ(now.getDate())} ${padZ(now.getHours())}:${padZ(now.getMinutes())}:${padZ(now.getSeconds())}`,
            current_date:      `${now.getFullYear()}-${padZ(now.getMonth()+1)}-${padZ(now.getDate())}`,
            current_time:      `${padZ(now.getHours())}:${padZ(now.getMinutes())}`,
            current_day:       ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()],
            current_month:     ['January','February','March','April','May','June','July','August','September','October','November','December'][now.getMonth()],
            current_year:      String(now.getFullYear()),
            bot_name:          bot.name || 'Assistant',
        };
        const { data: botVars } = await supabase.from('bot_variables').select('name, value').eq('bot_id', bot_id);
        const allVars = { ...builtInVars };
        if (botVars) botVars.forEach(v => { allVars[v.name] = v.value; });
        systemPrompt = systemPrompt.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
            const k = key.trim();
            return allVars.hasOwnProperty(k) ? allVars[k] : match;
        });

        // Tell the LLM never to echo unresolved {{variable}} placeholders in responses.
        systemPrompt += `\n\nIMPORTANT: Never output text like {{variable_name}} in your responses. If you want to reference a user's name or email, use the actual value they provided in the conversation, not a placeholder.`;

        // ── Language Enforcement ─────────────────────────────────────────────
        if (user_language && user_language !== 'Auto') {
            systemPrompt += `\n\nCRITICAL INSTRUCTION: You MUST respond to the user EXCLUSIVELY in ${user_language}. No matter what language the user types in, or what language the source material is in, translate and formulate your final response entirely in ${user_language}.`;
        }

        // ── Inject captured lead data so bot never asks again ────────────────
        // Check if name/email was already captured for this conversation.
        // If yes, tell the LLM explicitly so it doesn't ask again.
        if (conversation_id) {
            let existingLead = null;
            try {
                const { data: _lead } = await supabase
                    .from('leads')
                    .select('name, email, phone, company')
                    .eq('conversation_id', conversation_id)
                    .limit(1)
                    .maybeSingle(); // maybeSingle() returns null (not error) when no row found
                existingLead = _lead;
            } catch (_) { /* no lead found, continue normally */ }

            if (existingLead) {
                const known = [];
                if (existingLead.name)    known.push('name: "' + existingLead.name + '"');
                if (existingLead.email)   known.push('email: "' + existingLead.email + '"');
                if (existingLead.phone)   known.push('phone: "' + existingLead.phone + '"');
                if (existingLead.company) known.push('company: "' + existingLead.company + '"');
                if (known.length > 0) {
                    const missing = ['name','email','phone','company'].filter(f => !existingLead[f]);
                    systemPrompt += '\n\nUSER CONTACT INFO ALREADY CAPTURED: ' + known.join(', ') + '.'
                        + ' Do NOT ask for these again. Address user by name.'
                        + (missing.length > 0 ? ' You may still collect: ' + missing.join(', ') + '.' : ' You have complete contact info.');
                }
            }
        }

        // FIX: inject anti-hallucination rules when enabled
        if (bot.anti_hallucination) {
            systemPrompt += `\n\nIMPORTANT RULES:
- Only answer using information explicitly provided in the knowledge base below.
- If the answer is not in the knowledge base, respond with: "${bot.fallback_message || "I don't have that information. Would you like to speak with a human agent?"}"
- Never guess, assume, or make up information.
- Always be honest about what you do and do not know.`;
        }

        // Append knowledge base context
        if (knowledgeContext) {
            systemPrompt += knowledgeContext;
        }

        log.info('System prompt built', {
            promptLength:   systemPrompt.length,
            hasKnowledge:   !!knowledgeContext,
            antiHallucination: bot.anti_hallucination
        });

        // ── Anti-hallucination hard block ───────────────────────────────────
        // If anti-hallucination is ON and there is no KB context (no KB attached,
        // no chunks matched, or embedding failed), return the fallback immediately.
        // Never let the LLM answer from its training data in this mode.
        if (bot.anti_hallucination && !knowledgeContext) {
            const fallback = bot.fallback_message
                || "I don't have that information in my knowledge base. Would you like to speak with a human agent?";
            // Note: user message was already saved in Step 4 — don't insert again
            if (conversation_id) {
                const { data: fbMsg } = await supabase
                    .from('messages')
                    .insert({ conversation_id, role: 'bot', content: fallback })
                    .select('id, created_at')
                    .single();
                await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversation_id);
                log.info('Anti-hallucination block — no KB context, returning fallback', { conversation_id });
                return res.status(200).json({ response: fallback, bot_msg_ts: fbMsg?.created_at || null });
            }
            log.info('Anti-hallucination block — no KB context, returning fallback', { conversation_id });
            return res.status(200).json({ response: fallback, bot_msg_ts: null });
        }

        // ── Step 6: Call the configured LLM ────────────────────────────────
        const botModel = bot.model || 'gemini-2.5-flash';
        let responseText = '';
        let redirectUrl = null;

        if (botModel.startsWith('gemini')) {
            // ── Google Gemini ────────────────────────────────────────────────
            const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
            if (!apiKey) {
                responseText = 'Gemini API key not configured. Please add GEMINI_API_KEY to your Vercel environment variables.';
            } else {
                const { GoogleGenerativeAI } = await import('@google/generative-ai');
                const genAI = new GoogleGenerativeAI(apiKey);
                const resolvedModel = GEMINI_MODEL_MAP[botModel] || botModel;

                log.info('Calling Gemini', { resolvedModel });

                let geminiConfig = {
                    model: resolvedModel,
                    systemInstruction: systemPrompt,
                };

                if (hasActions) {
                    geminiConfig.tools = [{
                        functionDeclarations: botActions.map(act => {
                            const props = {};
                            const required = [];
                            (act.parameters || []).forEach(p => {
                                props[p.name] = { type: p.type.toUpperCase(), description: p.description };
                                required.push(p.name);
                            });
                            return {
                                name: act.name,
                                description: act.description,
                                parameters: { type: 'OBJECT', properties: props, required }
                            };
                        })
                    }];
                }

                const model = genAI.getGenerativeModel(geminiConfig);

                // Ensure history never starts with 'model' role — Gemini requirement
                const safeHistory = conversationHistory[0]?.role === 'assistant'
                    ? conversationHistory.slice(1)
                    : conversationHistory;

                const chat = model.startChat({
                    history: safeHistory.map(msg => ({
                        role:  msg.role === 'user' ? 'user' : 'model',
                        parts: [{ text: msg.content }]
                    })),
                    generationConfig: {
                        maxOutputTokens: botMaxTokens,
                        temperature:     botTemperature,
                    },
                });

                const result = await chat.sendMessage(message);
                
                const call = result.response.functionCalls()?.[0];
                if (call) {
                    const actionDef = botActions.find(a => a.name === call.name);
                    if (actionDef) {
                        redirectUrl = actionDef.url_template;
                        Object.entries(call.args).forEach(([k, v]) => {
                            redirectUrl = redirectUrl.replace(new RegExp(`{${k}}`, 'g'), encodeURIComponent(v));
                        });
                        log.info('Gemini invoked action redirect', { action: call.name, url: redirectUrl });
                        responseText = "I've gathered exactly what you are looking for.";
                    }
                }
                
                responseText = result.response.text();
                log.info('Gemini response received', { chars: responseText.length });
            }

        } else if (
            botModel.startsWith('gpt') ||
            botModel.startsWith('o1') ||
            botModel.startsWith('o3') ||
            botModel.startsWith('o4')
        ) {
            // ── OpenAI ───────────────────────────────────────────────────────
            if (!process.env.OPENAI_API_KEY) {
                responseText = 'OpenAI API key not configured. Please add OPENAI_API_KEY to your Vercel environment variables.';
            } else {
                const { default: OpenAI } = await import('openai');
                const client       = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                const resolvedModel = OPENAI_MODEL_MAP[botModel] || botModel;

                // Reasoning models (o1/o3/o4) do not support system role or temperature
                const isReasoning = botModel.startsWith('o1') || botModel.startsWith('o3') || botModel.startsWith('o4');

                const messages = isReasoning
                    ? [
                        { role: 'user', content: `[Instructions]\n${systemPrompt}\n\n[User message]\n${message}` },
                        ...conversationHistory.slice(1),
                      ]
                    : [
                        { role: 'system', content: systemPrompt },
                        ...conversationHistory,
                        { role: 'user', content: message }
                      ];

                let openaiTools = [];
                // Reasoning models rarely support native tool calling yet without strict schemas, so we disable it for `o1/o3` series for now.
                if (hasActions && !isReasoning) {
                    openaiTools = botActions.map(act => {
                        const props = {};
                        const required = [];
                        (act.parameters || []).forEach(p => {
                            props[p.name] = { type: p.type, description: p.description };
                            required.push(p.name);
                        });
                        return {
                            type: 'function',
                            function: {
                                name: act.name,
                                description: act.description,
                                parameters: { type: 'object', properties: props, required, additionalProperties: false }
                            }
                        };
                    });
                }

                log.info('Calling OpenAI', { resolvedModel, isReasoning });

                const response = await client.chat.completions.create({
                    model: resolvedModel,
                    messages,
                    tools: openaiTools.length > 0 ? openaiTools : undefined,
                    ...(isReasoning
                        ? { max_completion_tokens: 2048 }
                        : { max_tokens: botMaxTokens, temperature: botTemperature })
                });

                const choice = response.choices[0].message;
                if (choice.tool_calls && choice.tool_calls.length > 0) {
                    const call = choice.tool_calls[0].function;
                    const actionDef = botActions.find(a => a.name === call.name);
                    if (actionDef) {
                        const args = JSON.parse(call.arguments);
                        redirectUrl = actionDef.url_template;
                        Object.entries(args).forEach(([k, v]) => {
                            redirectUrl = redirectUrl.replace(new RegExp(`{${k}}`, 'g'), encodeURIComponent(v));
                        });
                        log.info('OpenAI invoked action redirect', { action: call.name, url: redirectUrl });
                        responseText = "I've gathered exactly what you are looking for.";
                    }
                }

                responseText = choice.content || '';
                log.info('OpenAI response received', { chars: responseText.length });
            }

        } else if (botModel.startsWith('claude')) {
            // ── Anthropic Claude ─────────────────────────────────────────────
            if (!process.env.ANTHROPIC_API_KEY) {
                responseText = 'Anthropic API key not configured. Please add ANTHROPIC_API_KEY to your Vercel environment variables.';
            } else {
                const Anthropic = await import('@anthropic-ai/sdk');
                const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

                log.info('Calling Claude', { model: botModel });

                let anthropicTools = [];
                if (hasActions) {
                    anthropicTools = botActions.map(act => {
                        const props = {};
                        const required = [];
                        (act.parameters || []).forEach(p => {
                            props[p.name] = { type: p.type, description: p.description };
                            required.push(p.name);
                        });
                        return {
                            name: act.name,
                            description: act.description,
                            input_schema: { type: 'object', properties: props, required }
                        };
                    });
                }

                const response = await client.messages.create({
                    model:      botModel,
                    max_tokens: botMaxTokens,
                    system:     systemPrompt,
                    messages:   [
                        ...conversationHistory,
                        { role: 'user', content: message }
                    ],
                    tools: anthropicTools.length > 0 ? anthropicTools : undefined
                });

                const toolBlock = response.content.find(b => b.type === 'tool_use');
                if (toolBlock) {
                    const actionDef = botActions.find(a => a.name === toolBlock.name);
                    if (actionDef) {
                        const args = toolBlock.input;
                        redirectUrl = actionDef.url_template;
                        Object.entries(args).forEach(([k, v]) => {
                            redirectUrl = redirectUrl.replace(new RegExp(`{${k}}`, 'g'), encodeURIComponent(v));
                        });
                        log.info('Claude invoked action redirect', { action: toolBlock.name, url: redirectUrl });
                        responseText = "I've gathered exactly what you are looking for.";
                    }
                }

                responseText = response.content.find(b => b.type === 'text')?.text || '';
                log.info('Claude response received', { chars: responseText.length });
            }

        } else {
            log.warn('Unknown model — using fallback', { botModel });
            responseText = `Unknown model "${botModel}". Please select a supported model in your bot configuration.`;
        }

        // ── Step 7: Save bot response and update conversation ───────────────
        let savedMsg = null;
        if (conversation_id && responseText) {
            const { data: _sm, error: saveBotErr } = await supabase
                .from('messages')
                .insert({ conversation_id, role: 'bot', content: responseText })
                .select('id, created_at')
                .single();
            if (saveBotErr) {
                log.warn('Failed to save bot response', { error: saveBotErr.message });
            } else {
                savedMsg = _sm;
            }

            await supabase
                .from('conversations')
                .update({ updated_at: new Date().toISOString() })
                .eq('id', conversation_id);

            log.info('Bot response saved', { conversation_id });
        }

        log.info('Request complete', { bot_id, model: botModel, responseLength: responseText.length });

        // ── Lead Capture: extract name/email/phone from conversation ─────────
        // Run async extraction in background — don't block the response
        if (conversation_id && responseText) {
            extractAndSaveLead({ bot_id, conversation_id, supabase, log }).catch(() => {});
        }

        if (redirectUrl) {
            return res.status(200).json({ action: 'redirect', url: redirectUrl, bot_msg_ts: savedMsg?.created_at || null });
        }
        return res.status(200).json({ response: responseText, bot_msg_ts: savedMsg?.created_at || null });

    } catch (error) {
        log.error('Request failed', {
            bot_id: req.body?.bot_id,
            error:  error.message,
            stack:  error.stack?.split('\n').slice(0, 4).join(' | ')
        });
        return res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
}
