// api/kb/process.js
// Processes a KB file: extracts text, chunks it, embeds with Gemini, saves to kb_chunks
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

// ── Text Chunker ──────────────────────────────────────────────────────────────
// Splits text into overlapping chunks of ~800 tokens (approx 3200 chars)
function chunkText(text, chunkSize = 3200, overlap = 320) {
    const chunks = [];
    let start = 0;
    const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    while (start < clean.length) {
        let end = start + chunkSize;

        // Try to break at paragraph boundary
        if (end < clean.length) {
            const paraBreak = clean.lastIndexOf('\n\n', end);
            if (paraBreak > start + chunkSize * 0.5) end = paraBreak;
            else {
                // Fall back to sentence boundary
                const sentBreak = clean.lastIndexOf('. ', end);
                if (sentBreak > start + chunkSize * 0.5) end = sentBreak + 1;
            }
        }

        const chunk = clean.slice(start, end).trim();
        if (chunk.length > 50) chunks.push(chunk); // skip tiny fragments
        start = end - overlap;
    }

    return chunks;
}

// ── Gemini Embedding ──────────────────────────────────────────────────────────
// Model-agnostic: just swap the URL/model to use OpenAI or Cohere instead
async function embedText(text) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'models/text-embedding-004',
                content: { parts: [{ text }] },
                taskType: 'RETRIEVAL_DOCUMENT',
            })
        }
    );

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Embedding API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.embedding.values; // array of 768 floats
}

// ── DOCX Text Extraction ──────────────────────────────────────────────────────
async function extractDocxText(fileBuffer) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return result.value;
}

// ── PDF Text Extraction ───────────────────────────────────────────────────────
async function extractPdfText(fileBuffer) {
    try {
        const pdfParse = await import('pdf-parse/lib/pdf-parse.js');
        const data = await pdfParse.default(fileBuffer);
        return data.text;
    } catch (e) {
        log.warn('pdf-parse failed, trying fallback', { error: e.message });
        // Basic fallback: extract readable ASCII text
        const text = fileBuffer.toString('latin1');
        return text.replace(/[^\x20-\x7E\n]/g, ' ').replace(/ {3,}/g, ' ');
    }
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

    log.info('Processing KB file', { kb_file_id });

    // ── Load file record ──────────────────────────────────────────────────────
    const { data: file, error: fileErr } = await supabase
        .from('kb_files')
        .select('*, knowledge_bases(id)')
        .eq('id', kb_file_id)
        .single();

    if (fileErr || !file) {
        return res.status(404).json({ error: 'KB file not found' });
    }

    const kb_id = file.kb_id;

    // Mark as processing
    await supabase.from('kb_files')
        .update({ status: 'processing' })
        .eq('id', kb_file_id);

    try {
        let rawText = '';

        if (file.type === 'txt' || file.type === 'md' || file.type === 'csv') {
            // ── Plain text: already stored in content column ──────────────────
            rawText = file.content || '';
            if (!rawText && file.storage_path) {
                const { data: blob } = await supabase.storage
                    .from('knowledge-files')
                    .download(file.storage_path);
                rawText = await blob.text();
            }

        } else if (file.type === 'docx' || file.type === 'doc') {
            // ── DOCX: download from storage and extract ───────────────────────
            log.info('Downloading DOCX from storage', { path: file.storage_path });
            const { data: blob, error: dlErr } = await supabase.storage
                .from('knowledge-files')
                .download(file.storage_path);

            if (dlErr) throw new Error(`Storage download failed: ${dlErr.message}`);

            const arrayBuf = await blob.arrayBuffer();
            const buffer = Buffer.from(arrayBuf);
            rawText = await extractDocxText(buffer);
            log.info('DOCX text extracted', { chars: rawText.length });

        } else if (file.type === 'pdf') {
            // ── PDF: download from storage and extract ────────────────────────
            log.info('Downloading PDF from storage', { path: file.storage_path });
            const { data: blob, error: dlErr } = await supabase.storage
                .from('knowledge-files')
                .download(file.storage_path);

            if (dlErr) throw new Error(`Storage download failed: ${dlErr.message}`);

            const arrayBuf = await blob.arrayBuffer();
            const buffer = Buffer.from(arrayBuf);
            rawText = await extractPdfText(buffer);
            log.info('PDF text extracted', { chars: rawText.length });

        } else {
            // Unsupported type
            await supabase.from('kb_files')
                .update({ status: 'unsupported', error_message: `File type '${file.type}' not supported for processing` })
                .eq('id', kb_file_id);
            return res.status(200).json({ message: 'File type not supported for text extraction', type: file.type });
        }

        if (!rawText || rawText.trim().length < 20) {
            await supabase.from('kb_files')
                .update({ status: 'empty', error_message: 'No readable text could be extracted' })
                .eq('id', kb_file_id);
            return res.status(200).json({ message: 'No text content found in file' });
        }

        // Save extracted text to content column
        await supabase.from('kb_files')
            .update({ content: rawText })
            .eq('id', kb_file_id);

        // ── Chunk the text ────────────────────────────────────────────────────
        const chunks = chunkText(rawText);
        log.info('Text chunked', { chunks: chunks.length, avgChunkSize: Math.round(rawText.length / chunks.length) });

        // ── Delete old chunks for this file (re-processing) ──────────────────
        await supabase.from('kb_chunks').delete().eq('kb_file_id', kb_file_id);

        // ── Embed and save each chunk ─────────────────────────────────────────
        let savedCount = 0;
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            try {
                const embedding = await embedText(chunk);

                // Format as pgvector string: [0.1,0.2,...] padded to 1536 dims
                // Gemini text-embedding-004 returns 768 dims — pad to 1536 for schema
                const padded = [...embedding, ...new Array(1536 - embedding.length).fill(0)];
                const vectorStr = '[' + padded.join(',') + ']';

                await supabase.from('kb_chunks').insert({
                    kb_file_id,
                    kb_id,
                    content:              chunk,
                    embedding:            vectorStr,
                    chunk_index:          i,
                    token_count:          Math.round(chunk.length / 4),
                    embedding_model:      'text-embedding-004',
                    embedding_dimensions: 768,
                    metadata: {
                        file_name:  file.name,
                        file_type:  file.type,
                        chunk_of:   chunks.length,
                    }
                });

                savedCount++;
                log.info('Chunk embedded and saved', { chunk: i + 1, of: chunks.length });

                // Small delay to avoid rate limiting
                if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 100));

            } catch (embErr) {
                log.warn('Chunk embedding failed', { chunk: i, error: embErr.message });
            }
        }

        // ── Mark file as processed ────────────────────────────────────────────
        await supabase.from('kb_files')
            .update({
                status:       'processed',
                chunk_count:  savedCount,
                processed_at: new Date().toISOString(),
            })
            .eq('id', kb_file_id);

        log.info('File processing complete', { kb_file_id, chunks: savedCount });
        return res.status(200).json({
            success: true,
            file_id: kb_file_id,
            chunks_created: savedCount,
            chars_extracted: rawText.length,
        });

    } catch (error) {
        log.error('Processing failed', { kb_file_id, error: error.message });

        await supabase.from('kb_files')
            .update({
                status:        'failed',
                error_message: error.message,
            })
            .eq('id', kb_file_id);

        return res.status(500).json({ error: error.message });
    }
}
