exports.main = async (event, context) => {
    // CloudBase HTTP 云函数入口
    // event 包含 httpMethod, path, headers, body, queryString 等
    const method = (event.httpMethod || 'GET').toUpperCase();
    const rawPath = event.path || '/';
    const headers = event.headers || {};
    const query = event.queryString || {};
    const body = event.body || '';

    // CORS headers
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': '*',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '86400',
    };

    // CORS preflight
    if (method === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders, body: '' };
    }

    // 路由分发
    const pathname = rawPath.split('?')[0];

    try {
        // /ping
        if (pathname === '/ping') {
            return jsonResp(200, corsHeaders, {
                status: 'ok',
                time: new Date().toISOString(),
                source: 'cloud-function',
                env: process.env.ENV_ID || 'unknown'
            });
        }

        // /proxy?url=<target>
        if (pathname === '/proxy') {
            const target = query.url || '';
            if (!target) {
                return jsonResp(400, corsHeaders, { error: 'Missing ?url= parameter' });
            }
            return await handleProxy(target, method, headers, body, corsHeaders);
        }

        // /save-cache
        if (pathname === '/save-cache') {
            if (method !== 'POST') {
                return jsonResp(405, corsHeaders, { error: 'Method not allowed' });
            }
            return await handleSaveCache(body, event, corsHeaders);
        }

        // /file/<path>
        if (pathname.startsWith('/file/')) {
            return await handleFile(pathname, corsHeaders);
        }

        // /list-files
        if (pathname === '/list-files') {
            return await handleListFiles(corsHeaders);
        }

        return jsonResp(404, corsHeaders, { error: 'Not found', path: pathname });
    } catch (err) {
        return jsonResp(500, corsHeaders, { error: 'Internal error', detail: err?.message || String(err) });
    }
};

// --- 工具函数 ---
function jsonResp(statusCode, headers, payload) {
    return {
        statusCode,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    };
}

async function handleProxy(target, method, headers, body, corsHeaders) {
    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch {
        return jsonResp(400, corsHeaders, { error: 'Invalid target URL' });
    }

    const options = {
        method,
        headers: { ...headers },
        // 云函数内使用 http/https 模块转发
    };
    delete options.headers.host;
    delete options.headers['content-length'];

    const httpModule = targetUrl.protocol === 'https:' ? require('https') : require('http');

    return new Promise((resolve) => {
        const proxyReq = httpModule.request(targetUrl, options, (proxyRes) => {
            let data = Buffer.alloc(0);
            proxyRes.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
            proxyRes.on('end', () => {
                resolve({
                    statusCode: proxyRes.statusCode || 502,
                    headers: { ...corsHeaders, ...proxyRes.headers, 'Content-Length': data.length },
                    body: data.toString('base64'),
                    isBase64Encoded: true,
                });
            });
        });
        proxyReq.on('error', (err) => {
            resolve(jsonResp(502, corsHeaders, { error: 'Upstream request failed', detail: err?.message || String(err) }));
        });
        if (body && method !== 'GET' && method !== 'HEAD') {
            proxyReq.write(Buffer.from(body, 'utf8'));
        }
        proxyReq.end();
    });
}

async function handleSaveCache(body, event, corsHeaders) {
    const fs = require('fs').promises;
    const path = require('path');
    const CACHE_ROOT = '/tmp/vodstudio-cache';

    let payload;
    try {
        payload = JSON.parse(body);
    } catch {
        return jsonResp(400, corsHeaders, { success: false, error: 'Invalid JSON body' });
    }

    const category = sanitizeSegment(payload.category || 'history', 'history');
    const id = sanitizeSegment(payload.id || `cache-${Date.now()}`, `cache-${Date.now()}`);
    const ext = sanitizeSegment(String(payload.ext || '').replace(/^\./, ''), payload.type === 'video' ? 'mp4' : 'jpg');
    const relPath = `${category}/${id}.${ext}`;
    const outputPath = path.join(CACHE_ROOT, category, `${id}.${ext}`);

    try {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, decodeCacheContent(payload.content));
    } catch (err) {
        return jsonResp(500, corsHeaders, { success: false, error: 'Write cache failed', detail: err?.message || String(err) });
    }

    // 返回可通过云函数访问的 URL
    const protocol = (event.headers && event.headers['x-forwarded-proto']) || 'http';
    const host = (event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || '';
    const fileUrl = `${protocol}://${host}/file/${relPath}`;

    return jsonResp(200, corsHeaders, {
        success: true,
        url: fileUrl,
        path: outputPath,
        relPath,
    });
}

async function handleFile(pathname, corsHeaders) {
    const fs = require('fs').promises;
    const path = require('path');
    const CACHE_ROOT = '/tmp/vodstudio-cache';

    const encodedRel = pathname.replace(/^\/file\//, '');
    const rel = decodeURIComponent(encodedRel).replace(/\\/g, '/').replace(/^\/+/, '');
    const targetPath = path.resolve(CACHE_ROOT, rel);

    if (!targetPath.startsWith(CACHE_ROOT + path.sep) && targetPath !== CACHE_ROOT) {
        return jsonResp(403, corsHeaders, { error: 'Forbidden' });
    }

    try {
        const data = await fs.readFile(targetPath);
        return {
            statusCode: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/octet-stream', 'Content-Length': data.length },
            body: data.toString('base64'),
            isBase64Encoded: true,
        };
    } catch {
        return jsonResp(404, corsHeaders, { error: 'File not found' });
    }
}

async function handleListFiles(corsHeaders) {
    const fs = require('fs').promises;
    const path = require('path');
    const CACHE_ROOT = '/tmp/vodstudio-cache';

    const files = [];
    try {
        await walkDir(CACHE_ROOT, CACHE_ROOT, files);
    } catch {
        // ignore
    }
    return jsonResp(200, corsHeaders, { files });
}

async function walkDir(dir, root, files) {
    const fs = require('fs').promises;
    const path = require('path');
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkDir(full, root, files);
        } else if (entry.isFile()) {
            const rel = path.relative(root, full);
            files.push(rel.replace(/\\/g, '/'));
        }
    }
}

function sanitizeSegment(value, fallback = 'item') {
    const safe = String(value || '')
        .replace(/[\\/]+/g, '-')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return safe.slice(0, 120) || fallback;
}

function decodeCacheContent(content) {
    const raw = String(content || '');
    const match = raw.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) return Buffer.from(raw);
    const isBase64 = !!match[2];
    const data = match[3] || '';
    return isBase64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data));
}
