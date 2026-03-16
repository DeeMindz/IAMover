// Vercel API route for bot response
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Structured logger for Vercel function logs
const log = {
    info: (msg, data) => console.log(JSON.stringify({ level: 'info', message: msg, ...data })),
    warn: (msg, data) => console.warn(JSON.stringify({ level: 'warn', message: msg, ...data })),
    error: (msg, data) => console.error(JSON.stringify({ level: 'error', message: msg, ...data }))
};

// Model maps for consistent model IDs
const GEMINI_MODEL_MAP = {
    // Gemini 2.5
    'gemini-2.5-pro': 'gemini-2.5-pro-preview-05-20',
    'gemini-2.5-flash': 'gemini-2.5-flash-preview-05-20',
    // Gemini 2.0
    'gemini-2.0-flash': 'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite': 'gemini-2.0-flash-lite-001',
    'gemini-2.0-flash-thinking': 'gemini-2.0-flash-thinking-exp-01-21',
    'gemini-2.0-pro': 'gemini-2.0-pro-002',
    // Gemini 1.5
    'gemini-1.5-pro': 'gemini-1.5-pro-002',
    'gemini-1.5-flash': 'gemini-1.5-flash-002',
    'gemini-1.5-flash-8b': 'gemini-1.5-flash-8b-001',
    // Gemini 1.0
    'gemini-1.0-pro': 'gemini-pro',
};

const OPENAI_MODEL_MAP = {
    // GPT-4o series
    'gpt-4o': 'gpt-4o',
    'gpt-4o-mini': 'gpt-4o-mini',
    'gpt-4o-audio-preview': 'gpt-4o-audio-preview',
    'gpt-4o-realtime-preview': 'gpt-4o-realtime-preview',

    // o1 series (reasoning)
    'o1': 'o1',
    'o1-mini': 'o1-mini',
    'o1-preview': 'o1-preview',

    // o3 series (reasoning)
    'o3': 'o3',
    'o3-mini': 'o3-mini',

    // o4 series (reasoning)
    'o4-mini': 'o4-mini',

    // GPT-4 Turbo
    'gpt-4-turbo': 'gpt-4-turbo',
    'gpt-4-turbo-preview': 'gpt-4-turbo-preview',
    'gpt-4': 'gpt-4',

    // GPT-3.5
    'gpt-3.5-turbo': 'gpt-3.5-turbo',
    'gpt-3.5-turbo-16k': 'gpt-3.5-turbo-16k',
};

export default async function handler(req, res) {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        log.warn('Invalid method', { method: req.method });
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { message, bot_id, system_vars, conversation_history = [] } = req.body;

        log.info('Incoming request', { bot_id, messageLength: message?.length });

        if (!message || !bot_id) {
            log.warn('Missing required fields', { message: !!message, bot_id: !!bot_id });
            return res.status(400).json({ error: 'Missing message or bot_id' });
        }

        // Get bot configuration
        const { data: bot, error: botError } = await supabase
            .from('bots')
            .select('*, bot_variables(*), knowledge_bases(*), kb_files(*)')
            .eq('id', bot_id)
            .single();

        if (botError || !bot) {
            log.error('Bot not found', { bot_id, error: botError?.message });
            return res.status(404).json({ error: 'Bot not found' });
        }

        log.info('Bot found', { bot_id, model: bot.model, hasKB: !!bot.knowledge_bases?.length });

        // Build system prompt from bot config
        let systemPrompt = bot.system_prompt || 'You are a helpful AI assistant.';

        // Add bot variables to context
        if (bot.bot_variables && bot.bot_variables.length > 0) {
            const varContext = bot.bot_variables
                .map(v => `${v.name}=${v.value}`)
                .join('\n');
            if (varContext) {
                systemPrompt += `\n\nContext variables:\n${varContext}`;
            }
        }

        // Add knowledge base context if available
        if (bot.knowledge_bases && bot.knowledge_bases.length > 0) {
            const kbContext = bot.knowledge_bases
                .map(kb => kb.content)
                .filter(c => c)
                .join('\n\n');
            if (kbContext) {
                systemPrompt += `\n\nKnowledge base context:\n${kbContext}`;
            }
        }

        const botModel = bot.model;
        let responseText = '';

        // Determine provider and call appropriate API
        if (botModel.startsWith('gemini')) {
            // Google Gemini
            if (!process.env.GEMINI_API_KEY) {
                responseText = 'Gemini API key not configured. Please add GEMINI_API_KEY to your environment variables.';
            } else {
                const { GoogleGenerativeAI } = await import('@google/generative-ai');
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

                const resolvedModel = GEMINI_MODEL_MAP[botModel] || botModel;
                const model = genAI.getGenerativeModel({ model: resolvedModel });

                const chat = model.startChat({
                    history: conversationHistory.map(msg => ({
                        role: msg.role === 'user' ? 'user' : 'model',
                        parts: [{ text: msg.content }]
                    })),
                    generationConfig: {
                        maxOutputTokens: 1024,
                        temperature: 0.5,
                    },
                });

                const result = await chat.sendMessage(message);
                responseText = result.response.text();
            }
        } else if (
            botModel.startsWith('gpt') ||
            botModel.startsWith('o1') ||
            botModel.startsWith('o3') ||
            botModel.startsWith('o4')
        ) {
            // OpenAI
            if (!process.env.OPENAI_API_KEY) {
                responseText = 'OpenAI API key not configured. Please add OPENAI_API_KEY to your environment variables or use a Gemini model.';
            } else {
                const { default: OpenAI } = await import('openai');
                const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

                // Resolve model ID
                const resolvedModel = OPENAI_MODEL_MAP[botModel] || botModel;

                // o1, o3, o4 reasoning models use max_completion_tokens instead of max_tokens
                // and do not support system role — inject system prompt as first user message
                const isReasoningModel =
                    botModel.startsWith('o1') ||
                    botModel.startsWith('o3') ||
                    botModel.startsWith('o4');

                const messages = isReasoningModel
                    ? [
                        { role: 'user', content: `[Instructions]\n${systemPrompt}\n\n[User message]\n${message}` },
                        ...conversationHistory.slice(1), // skip injected system in history
                    ]
                    : [
                        { role: 'system', content: systemPrompt },
                        ...conversationHistory,
                        { role: 'user', content: message }
                    ];

                const completionParams = {
                    model: resolvedModel,
                    messages,
                    ...(isReasoningModel
                        ? { max_completion_tokens: 2048 }
                        : { max_tokens: 1024, temperature: 0.5 })
                };

                const response = await client.chat.completions.create(completionParams);
                responseText = response.choices[0].message.content;
            }
        } else if (botModel.startsWith('claude')) {
            // Anthropic Claude
            if (!process.env.ANTHROPIC_API_KEY) {
                responseText = 'Anthropic API key not configured. Please add ANTHROPIC_API_KEY to your environment variables.';
            } else {
                const Anthropic = await import('@anthropic-ai/sdk');
                const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

                const response = await client.messages.create({
                    model: botModel,
                    max_tokens: 1024,
                    system: systemPrompt,
                    messages: [
                        ...conversationHistory,
                        { role: 'user', content: message }
                    ]
                });

                responseText = response.content[0].text;
            }
        } else {
            responseText = `Unknown model: ${botModel}. Please select a supported model.`;
        }

        log.info('Sending response', { bot_id, model: botModel, responseLength: responseText.length });
        return res.status(200).json({ response: responseText });
    } catch (error) {
        log.error('Request failed', { bot_id: req.body?.bot_id, error: error.message, stack: error.stack });
        return res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
}
