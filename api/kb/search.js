// api/kb/search.js
// Semantic search over kb_chunks using pgvector cosine similarity
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Embed the query using same model as the chunks
async function embedQuery(text) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'models/gemini-embedding-001',
                content: { parts: [{ text }] },
                taskType: 'RETRIEVAL_QUERY',
                outputDimensionality: 1536,
            })
        }
    );

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Embedding API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.embedding.values;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { query, kb_ids, top_k = 5 } = req.body;
    if (!query || !kb_ids?.length) {
        return res.status(400).json({ error: 'query and kb_ids are required' });
    }

    try {
        // Embed the user query
        const queryEmbedding = await embedQuery(query);

        // Pad to 1536 dimensions (outputDimensionality truncates gemini-embedding-001)
        const padded = [...queryEmbedding, ...new Array(1536 - queryEmbedding.length).fill(0)];
        const vectorStr = '[' + padded.join(',') + ']';

        // Semantic search using pgvector cosine similarity
        // This calls the match_kb_chunks SQL function we create below
        const { data: chunks, error } = await supabase.rpc('match_kb_chunks', {
            query_embedding: vectorStr,
            kb_ids_filter:   kb_ids,
            match_count:     top_k,
            similarity_threshold: 0.5,
        });

        if (error) throw error;

        return res.status(200).json({
            chunks: chunks || [],
            query,
            kb_ids,
        });

    } catch (error) {
        console.error('Semantic search error:', error);
        return res.status(500).json({ error: error.message });
    }
}
