// api/kb/crawl.js
// Crawls a URL or sitemap, extracts clean text, chunks and embeds it.
// Uses r.jina.ai as a reader proxy to handle JS-rendered pages.
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

// ── Fetch page text via Jina Reader API ───────────────────────────────────────
// r.jina.ai renders JS, extracts main content, returns clean markdown.
// No API key needed for basic usage. Handles SPAs, React, etc.
async function fetchPageText(url) {
    // Try Jina Reader first (handles JS-rendered pages)
    const jinaUrl = `https://r.jina.ai/${url}`;
    try {
        const response = await fetch(jinaUrl, {
            headers: {
                'Accept': 'text/plain',
                'X-Return-Format': 'markdown',
                'User-Agent': 'IAMPlatform-KB-Crawler/1.0',
            },
            signal: AbortSignal.timeout(20000),
        });

        if (response.ok) {
            const text = await response.text();
            // Jina returns the page title + content in markdown
            // Strip the header lines Jina adds
            const cleaned = text
                .replace(/^Title:.*\n/m, '')
                .replace(/^URL Source:.*\n/m, '')
                .replace(/^Markdown Content:\n/m, '')
                .replace(/^Published Time:.*\n/m, '')
                .replace(/!\[.*?\]\(.*?\)/g, '') // remove images
                .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → just text
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            if (cleaned.length > 100) {
                log.info('Jina fetch succeeded', { url, chars: cleaned.length });
                return cleaned;
            }
        }
        log.warn('Jina returned short content, falling back to direct fetch', { url });
    } catch (e) {
        log.warn('Jina fetch failed, falling back to direct fetch', { url, error: e.message });
    }

    // Fallback: direct HTML fetch (works for static sites)
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
        .replace(/<\/?(p|div|h[1-6]|li|br|tr|td|th)[^>]*>/gi, '\n')
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

// ── Embed text via gemini-embedding-001 ──────────────────────────────────────
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
    return data.embedding.values; // exactly 1536 dimensions
}

// ── Save chunks to DB ─────────────────────────────────────────────────────────
async function saveChunks(chunks, kb_file_id, kb_id, sourceUrl) {
    let saved = 0;
    for (let i = 0; i < chunks.length; i++) {
        try {
            const embedding = await embedText(chunks[i]);
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
            // Cap configurable: default 50, max 200. Pass max_pages in request body to override.
            const cap = Math.min(parseInt(req.body.max_pages) || 50, 200);
            urlsToCrawl = urlsToCrawl.slice(0, cap);
            log.info('Crawling pages', { count: urlsToCrawl.length, cap });
        }

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
                    log.warn('Page too short after extraction, skipping', { url, chars: text.length });
                    pagesFailed.push({ url, reason: `too short (${text.length} chars after extraction)` });
                    continue;
                }

                const chunks = chunkText(text);
                log.info('Chunked page', { url, chunks: chunks.length, chars: text.length });

                const saved = await saveChunks(chunks, kb_file_id, file.kb_id, url);
                totalChunks += saved;
                totalText += text + '\n\n';
                pagesProcessed.push({ url, chunks: saved });

                if (urlsToCrawl.indexOf(url) < urlsToCrawl.length - 1) {
                    await new Promise(r => setTimeout(r, 500));
                }
            } catch (e) {
                log.warn('Page crawl failed', { url, error: e.message });
                pagesFailed.push({ url, reason: e.message });
            }
        }

        // Mark as 'empty' if nothing was extracted, not 'processed'
        const finalStatus = totalChunks > 0 ? 'processed' : 'failed';
        const errorMsg = totalChunks === 0
            ? `No content extracted. Pages tried: ${urlsToCrawl.length}. ${pagesFailed.map(p => p.reason).join('; ')}`
            : null;

        await supabase.from('kb_files')
            .update({
                content:       totalText.slice(0, 100000),
                status:        finalStatus,
                chunk_count:   totalChunks,
                processed_at:  new Date().toISOString(),
                error_message: errorMsg,
            })
            .eq('id', kb_file_id);

        log.info('Crawl complete', { kb_file_id, totalChunks, pagesProcessed: pagesProcessed.length, pagesFailed: pagesFailed.length });

        return res.status(200).json({
            success:         totalChunks > 0,
            file_id:         kb_file_id,
            url:             targetUrl,
            pages_processed: pagesProcessed.length,
            pages_failed:    pagesFailed.length,
            chunks_created:  totalChunks,
            status:          finalStatus,
            failed_reasons:  pagesFailed,
        });

    } catch (error) {
        log.error('Crawl failed', { kb_file_id, error: error.message });
        await supabase.from('kb_files')
            .update({ status: 'failed', error_message: error.message })
            .eq('id', kb_file_id);
        return res.status(500).json({ error: error.message });
    }
}
