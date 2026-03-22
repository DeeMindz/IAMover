// api/kb/crawl.js
// Crawls a URL or sitemap, extracts clean text, chunks and embeds it
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const log = {
    info:  (msg, data = {}) => console.log(JSON.stringify({ level: 'info',  msg, ...data, ts: new Date().toISOString() })),
    warn:  (msg, data = {}) => console.warn(JSON.stringify({ level: 'warn',  msg, ...data, ts: new Date().toISOString() })),
    error: (msg, data = {}) => console.error(JSON.stringify({ level: 'error', msg, ...data, ts: new Date().toISOString() })),
};

// ── Fetch and clean HTML page ─────────────────────────────────────────────────
async function fetchPageText(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'IAMPlatform-KB-Crawler/1.0 (compatible; knowledge base indexer)',
            'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

    const html = await response.text();

    let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<\/?(p|div|h[1-6]|li|br|tr)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').replace(/&[a-z]+;/g, '')
        .replace(/\t/g, ' ').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n')
        .trim();

    return text;
}

// ── Parse sitemap XML ─────────────────────────────────────────────────────────
async function parseSitemap(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Failed to fetch sitemap: HTTP ${response.status}`);
    const xml = await response.text();
    const urls = [];
    const matches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
    for (const match of matches) {
        const loc = match[1].trim();
        if (loc && !loc.endsWith('.xml')) urls.push(loc);
    }
    return urls;
}

// ── Chunker ───────────────────────────────────────────────────────────────────
function chunkText(text, chunkSize = 3200, overlap = 320) {
    const chunks = [];
    let start = 0;
    const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    while (start < clean.length) {
        let end = start + chunkSize;
        if (end < clean.length) {
            const paraBreak = clean.lastIndexOf('\n\n', end);
            if (paraBreak > start + chunkSize * 0.5) end = paraBreak;
            else {
                const sentBreak = clean.lastIndexOf('. ', end);
                if (sentBreak > start + chunkSize * 0.5) end = sentBreak + 1;
            }
        }
        const chunk = clean.slice(start, end).trim();
        if (chunk.length > 50) chunks.push(chunk);
        start = end - overlap;
    }
    return chunks;
}

// ── Embed text ────────────────────────────────────────────────────────────────
// Uses gemini-embedding-001 via v1beta with outputDimensionality:1536
// text-embedding-004 was shut down January 14, 2026
async function embedText(text) {
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
                taskType: 'RETRIEVAL_DOCUMENT',
                outputDimensionality: 1536,
            })
        }
    );

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Embedding API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.embedding.values; // exactly 1536 dimensions — no padding needed
}

// ── Save chunks to DB ─────────────────────────────────────────────────────────
async function saveChunks(chunks, kb_file_id, kb_id, sourceUrl) {
    let saved = 0;
    for (let i = 0; i < chunks.length; i++) {
        try {
            const embedding = await embedText(chunks[i]);
            // embedding is exactly 1536 dimensions — no padding required
            const vectorStr = '[' + embedding.join(',') + ']';

            await supabase.from('kb_chunks').insert({
                kb_file_id,
                kb_id,
                content:              chunks[i],
                embedding:            vectorStr,
                chunk_index:          i,
                token_count:          Math.round(chunks[i].length / 4),
                embedding_model:      'gemini-embedding-001',
                embedding_dimensions: 1536,
                metadata: { source_url: sourceUrl, chunk_of: chunks.length }
            });

            saved++;
            // Small delay to avoid hitting rate limits
            if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 120));
        } catch (e) {
            log.warn('Chunk embed failed', { chunk: i, error: e.message });
        }
    }
    return saved;
}

// ── Main Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { kb_file_id } = req.body;
    if (!kb_file_id) return res.status(400).json({ error: 'kb_file_id is required' });

    const { data: file, error: fileErr } = await supabase
        .from('kb_files')
        .select('*')
        .eq('id', kb_file_id)
        .single();

    if (fileErr || !file) return res.status(404).json({ error: 'KB file not found' });
    if (file.type !== 'url') return res.status(400).json({ error: 'This endpoint is for URL type files only' });

    const targetUrl = file.url || file.name;
    if (!targetUrl) return res.status(400).json({ error: 'No URL found on file record' });

    log.info('Starting URL crawl', { kb_file_id, url: targetUrl });

    await supabase.from('kb_files').update({ status: 'processing' }).eq('id', kb_file_id);

    try {
        let urlsToCrawl = [targetUrl];
        const isSitemap = targetUrl.includes('sitemap') || targetUrl.endsWith('.xml');

        if (isSitemap) {
            log.info('Parsing sitemap', { url: targetUrl });
            urlsToCrawl = await parseSitemap(targetUrl);
            log.info('Sitemap parsed', { urlCount: urlsToCrawl.length });
            // Cap at 20 pages to avoid Vercel timeout (60s Pro / 10s Hobby)
            urlsToCrawl = urlsToCrawl.slice(0, 20);
        }

        // Delete old chunks for this file
        await supabase.from('kb_chunks').delete().eq('kb_file_id', kb_file_id);

        let totalChunks = 0;
        let totalText = '';
        const pagesProcessed = [];
        const pagesFailed = [];

        for (const url of urlsToCrawl) {
            try {
                log.info('Fetching page', { url });
                const text = await fetchPageText(url);

                if (text.length < 100) {
                    log.warn('Page too short, skipping', { url, chars: text.length });
                    pagesFailed.push({ url, reason: 'too short' });
                    continue;
                }

                const chunks = chunkText(text);
                const saved = await saveChunks(chunks, kb_file_id, file.kb_id, url);
                totalChunks += saved;
                totalText += text + '\n\n';
                pagesProcessed.push({ url, chunks: saved });

                log.info('Page processed', { url, chunks: saved });

                if (urlsToCrawl.indexOf(url) < urlsToCrawl.length - 1) {
                    await new Promise(r => setTimeout(r, 500));
                }

            } catch (e) {
                log.warn('Page crawl failed', { url, error: e.message });
                pagesFailed.push({ url, reason: e.message });
            }
        }

        await supabase.from('kb_files')
            .update({
                content:      totalText.slice(0, 100000),
                status:       'processed',
                chunk_count:  totalChunks,
                processed_at: new Date().toISOString(),
            })
            .eq('id', kb_file_id);

        log.info('Crawl complete', { kb_file_id, totalChunks, pagesProcessed: pagesProcessed.length, pagesFailed: pagesFailed.length });

        return res.status(200).json({
            success:         true,
            file_id:         kb_file_id,
            url:             targetUrl,
            pages_processed: pagesProcessed.length,
            pages_failed:    pagesFailed.length,
            chunks_created:  totalChunks,
        });

    } catch (error) {
        log.error('Crawl failed', { kb_file_id, error: error.message });
        await supabase.from('kb_files')
            .update({ status: 'failed', error_message: error.message })
            .eq('id', kb_file_id);
        return res.status(500).json({ error: error.message });
    }
}
