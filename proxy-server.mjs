import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';

const PORT = 9527;
const CACHE_ROOT = path.resolve(process.env.VODSTUDIO_CACHE_DIR || path.join(process.cwd(), 'vodstudio-cache'));
const configState = {
    save_path: CACHE_ROOT,
    image_save_path: path.join(CACHE_ROOT, 'history'),
    video_save_path: path.join(CACHE_ROOT, 'history'),
    convert_png_to_jpg: false,
    jpg_quality: 95,
    pil_available: false,
};

/** CORS 响应头 */
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '86400',
};

/** 读取请求 body */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify(payload));
}

function sanitizeSegment(value, fallback = 'item') {
    const safe = String(value || '')
        .replace(/[\\/]+/g, '-')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
    return safe || fallback;
}

function encodeRelPath(relPath) {
    return relPath.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

async function listCacheFiles(dir = CACHE_ROOT, prefix = '') {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const files = [];
    for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listCacheFiles(full, rel));
        } else if (entry.isFile()) {
            files.push(rel.replace(/\\/g, '/'));
        }
    }
    return files;
}

function decodeCacheContent(content) {
    const raw = String(content || '');
    const match = raw.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) return Buffer.from(raw);
    const isBase64 = !!match[2];
    const data = match[3] || '';
    return isBase64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data));
}

async function saveCache(req, res) {
    try {
        const body = await readBody(req);
        const payload = JSON.parse(body.toString('utf8') || '{}');
        const category = sanitizeSegment(payload.category || 'history', 'history');
        const id = sanitizeSegment(payload.id || `cache-${Date.now()}`, `cache-${Date.now()}`);
        const ext = sanitizeSegment(String(payload.ext || '').replace(/^\./, '') || (payload.type === 'video' ? 'mp4' : 'jpg'), 'jpg');
        const relPath = `${category}/${id}.${ext}`;
        const outputPath = path.join(CACHE_ROOT, category, `${id}.${ext}`);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, decodeCacheContent(payload.content));
        sendJson(res, 200, {
            success: true,
            url: `http://127.0.0.1:${PORT}/file/${encodeRelPath(relPath)}`,
            path: outputPath,
            relPath,
        });
    } catch (err) {
        sendJson(res, 400, { success: false, error: 'Save cache failed', detail: err?.message || String(err) });
    }
}

async function serveCacheFile(reqUrl, res) {
    try {
        const encodedRel = reqUrl.pathname.replace(/^\/file\//, '');
        const rel = decodeURIComponent(encodedRel).replace(/\\/g, '/').replace(/^\/+/, '');
        const targetPath = path.resolve(CACHE_ROOT, rel);
        if (!targetPath.startsWith(CACHE_ROOT + path.sep) && targetPath !== CACHE_ROOT) {
            return sendJson(res, 403, { error: 'Forbidden' });
        }
        const data = await fs.readFile(targetPath);
        res.writeHead(200, { ...corsHeaders });
        res.end(data);
    } catch {
        sendJson(res, 404, { error: 'File not found' });
    }
}

const server = http.createServer(async (req, res) => {
    // --- CORS preflight ---
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        return res.end();
    }

    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

    // --- /ping ---
    if (reqUrl.pathname === '/ping') {
        return sendJson(res, 200, { status: 'ok', time: new Date().toISOString(), ...configState });
    }

    // --- /config ---
    if (reqUrl.pathname === '/config') {
        if (req.method === 'POST') {
            try {
                const body = await readBody(req);
                const patch = JSON.parse(body.toString('utf8') || '{}');
                Object.assign(configState, patch || {});
            } catch (err) {
                return sendJson(res, 400, { success: false, error: 'Invalid config payload', detail: err?.message || String(err) });
            }
        }
        return sendJson(res, 200, { success: true, config: configState });
    }

    // --- /list-files ---
    if (reqUrl.pathname === '/list-files') {
        const files = await listCacheFiles();
        return sendJson(res, 200, { files });
    }

    // --- /save-cache ---
    if (reqUrl.pathname === '/save-cache') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        return saveCache(req, res);
    }

    // --- /file/<path> ---
    if (reqUrl.pathname.startsWith('/file/')) {
        return serveCacheFile(reqUrl, res);
    }

    // --- /proxy ---
    if (reqUrl.pathname === '/proxy') {
        const target = reqUrl.searchParams.get('url');
        if (!target) {
            return sendJson(res, 400, { error: 'Missing ?url= parameter' });
        }

        let parsed;
        try {
            parsed = new URL(target);
        } catch {
            return sendJson(res, 400, { error: 'Invalid target URL' });
        }

        const body = await readBody(req);

        // 构建上游请求头（透传，去掉 host / origin / referer）
        const fwdHeaders = { ...req.headers };
        delete fwdHeaders['host'];
        delete fwdHeaders['origin'];
        delete fwdHeaders['referer'];
        delete fwdHeaders['connection'];
        fwdHeaders['host'] = parsed.host;

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: req.method,
            headers: fwdHeaders,
        };

        const transport = parsed.protocol === 'https:' ? https : http;

        const proxyReq = transport.request(options, (proxyRes) => {
            // 将上游响应头透传回来，附加 CORS
            const respHeaders = { ...proxyRes.headers, ...corsHeaders };
            delete respHeaders['transfer-encoding']; // 避免 chunked 干扰
            res.writeHead(proxyRes.statusCode, respHeaders);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error('[proxy] upstream error:', err.message);
            if (!res.headersSent) {
                return sendJson(res, 502, { error: 'Upstream request failed', detail: err.message });
            }
            res.end(JSON.stringify({ error: 'Upstream request failed', detail: err.message }));
        });

        if (body.length > 0) {
            proxyReq.end(body);
        } else {
            proxyReq.end();
        }
        return;
    }

    // --- 404 fallback ---
    sendJson(res, 404, { error: 'Not found', path: reqUrl.pathname });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[proxy-server] 本地代理服务已启动: http://127.0.0.1:${PORT}`);
    console.log(`[proxy-server] 支持路由: /ping, /proxy?url=<target>`);
});
