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
        const { message, bot_id, conversation_id, system_vars } = req.body;

        log.info('Incoming request', { bot_id, conversation_id: conversation_id || 'none', messageLength: message?.length });

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
                const embedRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: 'models/text-embedding-004',
                            content: { parts: [{ text: message }] },
                            taskType: 'RETRIEVAL_QUERY',
                        })
                    }
                );

                if (embedRes.ok) {
                    const embedData = await embedRes.json();
                    const queryVec = embedData.embedding.values;
                    const padded = [...queryVec, ...new Array(1536 - queryVec.length).fill(0)];
                    const vectorStr = '[' + padded.join(',') + ']';

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
                        knowledgeContext = '\n\n--- RELEVANT KNOWLEDGE BASE CONTENT ---\n' +
                            chunks.map((c, i) => `[Source ${i+1}: ${c.metadata?.file_name || 'document'}]\n${c.content}`).join('\n\n') +
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
        let systemPrompt = bot.system_prompt || 'You are a helpful AI assistant.';

        // ── Variable substitution ────────────────────────────────────────────
        // Replace {{variable}} placeholders in the system prompt before sending to LLM
        const now = new Date();
        const padZ = n => String(n).padStart(2, '0');
        const currentTimestamp = `${now.getFullYear()}-${padZ(now.getMonth()+1)}-${padZ(now.getDate())} ${padZ(now.getHours())}:${padZ(now.getMinutes())}:${padZ(now.getSeconds())}`;
        const currentDate      = `${now.getFullYear()}-${padZ(now.getMonth()+1)}-${padZ(now.getDate())}`;
        const currentTime      = `${padZ(now.getHours())}:${padZ(now.getMinutes())}`;
        const dayNames         = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const monthNames       = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const currentDay       = dayNames[now.getDay()];
        const currentMonth     = monthNames[now.getMonth()];
        const currentYear      = String(now.getFullYear());

        // Built-in variables always available in any prompt
        const builtInVars = {
            current_timestamp: currentTimestamp,
            current_date:      currentDate,
            current_time:      currentTime,
            current_day:       currentDay,
            current_month:     currentMonth,
            current_year:      currentYear,
            bot_name:          bot.name || 'Assistant',
        };

        // Load custom bot variables from DB if any exist
        const { data: botVars } = await supabase
            .from('bot_variables')
            .select('name, value')
            .eq('bot_id', bot_id);

        const allVars = { ...builtInVars };
        if (botVars) {
            botVars.forEach(v => { allVars[v.name] = v.value; });
        }

        // Replace {{variable_name}} — unknown variables are left as-is so agent can see them
        systemPrompt = systemPrompt.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
            const trimmed = key.trim();
            return allVars.hasOwnProperty(trimmed) ? allVars[trimmed] : match;
        });

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

        // ── Step 6: Call the configured LLM ────────────────────────────────
        const botModel = bot.model || 'gemini-2.5-flash';
        let responseText = '';

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

                // FIX 2: pass systemInstruction so system prompt and KB are actually used
                const model = genAI.getGenerativeModel({
                    model: resolvedModel,
                    systemInstruction: systemPrompt,
                });

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
                        maxOutputTokens: 1024,
                        temperature:     0.5,
                    },
                });

                const result = await chat.sendMessage(message);
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

                log.info('Calling OpenAI', { resolvedModel, isReasoning });

                const response = await client.chat.completions.create({
                    model: resolvedModel,
                    messages,
                    ...(isReasoning
                        ? { max_completion_tokens: 2048 }
                        : { max_tokens: 1024, temperature: 0.5 })
                });

                responseText = response.choices[0].message.content;
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

                const response = await client.messages.create({
                    model:      botModel,
                    max_tokens: 1024,
                    system:     systemPrompt,
                    messages:   [
                        ...conversationHistory,
                        { role: 'user', content: message }
                    ]
                });

                responseText = response.content[0].text;
                log.info('Claude response received', { chars: responseText.length });
            }

        } else {
            log.warn('Unknown model — using fallback', { botModel });
            responseText = `Unknown model "${botModel}". Please select a supported model in your bot configuration.`;
        }

        // ── Step 7: Save bot response and update conversation ───────────────
        if (conversation_id && responseText) {
            const { error: saveBotErr } = await supabase.from('messages').insert({
                conversation_id,
                role:    'bot',
                content: responseText
            });
            if (saveBotErr) {
                log.warn('Failed to save bot response', { error: saveBotErr.message });
            }

            await supabase
                .from('conversations')
                .update({ updated_at: new Date().toISOString() })
                .eq('id', conversation_id);

            log.info('Bot response saved', { conversation_id });
        }

        log.info('Request complete', { bot_id, model: botModel, responseLength: responseText.length });
        return res.status(200).json({ response: responseText });

    } catch (error) {
        log.error('Request failed', {
            bot_id: req.body?.bot_id,
            error:  error.message,
            stack:  error.stack?.split('\n').slice(0, 4).join(' | ')
        });
        return res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
}
