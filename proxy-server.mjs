import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const PORT = 9527;

/** CORS 响应头 */
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
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

const server = http.createServer(async (req, res) => {
    // --- CORS preflight ---
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        return res.end();
    }

    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

    // --- /ping ---
    if (reqUrl.pathname === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        return res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    }

    // --- /list-files (本地缓存索引，返回空列表) ---
    if (reqUrl.pathname === '/list-files') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        return res.end(JSON.stringify({ files: [] }));
    }

    // --- /proxy ---
    if (reqUrl.pathname === '/proxy') {
        const target = reqUrl.searchParams.get('url');
        if (!target) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
            return res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
        }

        let parsed;
        try {
            parsed = new URL(target);
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
            return res.end(JSON.stringify({ error: 'Invalid target URL' }));
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
                res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders });
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
    res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: 'Not found', path: reqUrl.pathname }));
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[proxy-server] 本地代理服务已启动: http://127.0.0.1:${PORT}`);
    console.log(`[proxy-server] 支持路由: /ping, /proxy?url=<target>`);
});
