// ============================================================================
// 腾讯云 VOD AIGC 适配器 (VodStudio Studio)
// ----------------------------------------------------------------------------
// 对接接口：
//   - ApplyUpload           (VOD)      申请上传凭证
//   - COS PUT Object        (COS)      直传文件
//   - CommitUpload          (VOD)      确认上传获取 FileId
//   - CreateAigcImageTask   (VOD)      创建 AIGC 生图任务
//   - CreateAigcVideoTask   (VOD)      创建 AIGC 生视频任务
//   - DescribeTaskDetail    (VOD)      轮询任务状态
//
// Provider 凭据存储约定（复用 providers['tencent-vod'].key 字段）：
//   SecretId|SecretKey|SubAppId|Region
//   例：AKIDxxxx|SKxxxx|251007502|ap-guangzhou
//
// 浏览器侧签名（无依赖）：
//   - TC3-HMAC-SHA256 (VOD API)  使用 Web Crypto API
//   - COS V5 签名 (HMAC-SHA1)     使用 Web Crypto API
// ============================================================================

export const TENCENT_VOD_PROVIDER_KEY = 'tencent-vod';
export const VOD_IMAGE_MODEL_ID = 'vod-aigc-image';
export const VOD_VIDEO_MODEL_ID = 'vod-aigc-video';
export const VOD_API_VERSION = '2018-07-17';
export const VOD_API_HOST = 'vod.tencentcloudapi.com';
export const VOD_SERVICE = 'vod';
export const VOD_DEFAULT_IMAGE_MODEL_NAME = 'Kling';
export const VOD_DEFAULT_IMAGE_MODEL_VERSION = '3.0';
export const VOD_DEFAULT_VIDEO_MODEL_NAME = 'Kling';
export const VOD_DEFAULT_VIDEO_MODEL_VERSION = '3.0';

// ModelName / ModelVersion 支持矩阵（来自官方文档 2026-05）
export const VOD_IMAGE_MODEL_MATRIX = {
    OG: ['image2_low', 'image2_medium', 'image2_high'],
    GG: ['2.5', '3.0', '3.1'],
    SI: ['4.0', '4.5', '5.0-lite'],
    Qwen: ['0925'],
    Hunyuan: ['3.0'],
    Vidu: ['q2'],
    Kling: ['2.1', '3.0', '3.0-Omni', 'O1']
};
export const VOD_VIDEO_MODEL_MATRIX = {
    Hailuo: ['02', '2.3', '2.3-fast'],
    Kling: ['1.6', '2.0', '2.1', '2.5', '2.6', 'O1', '3.0', '3.0-Omni'],
    Vidu: ['q2', 'q2-pro', 'q2-turbo', 'q3', 'q3-pro', 'q3-turbo'],
    GV: ['3.1', '3.1-fast'],
    OS: ['2.0'],
    Hunyuan: ['1.5'],
    Mingmou: ['1.0'],
    PixVerse: ['v5.6', 'v6', 'c1']
};

// ============================================================================
// 凭据解析
// ============================================================================

/**
 * 解析 providers['tencent-vod'].key 字符串：SecretId|SecretKey|SubAppId|Region
 * @param {Object} provider
 * @returns {{secretId:string, secretKey:string, subAppId:number, region:string}}
 */
export function parseVodCredentials(provider) {
    const raw = String(provider?.key || '').trim();
    if (!raw) {
        throw new Error('[VOD] 未配置腾讯云 VOD 凭据，请在 Provider 设置中填写 SecretId|SecretKey|SubAppId|Region');
    }
    const parts = raw.split('|').map((s) => s.trim());
    const [secretId, secretKey, subAppIdStr, region] = parts;
    if (!secretId || !secretKey || !subAppIdStr) {
        throw new Error('[VOD] 凭据格式错误，应为：SecretId|SecretKey|SubAppId|Region');
    }
    const subAppId = Number(subAppIdStr);
    if (!Number.isFinite(subAppId) || subAppId <= 0) {
        throw new Error('[VOD] SubAppId 必须是正整数');
    }
    return {
        secretId,
        secretKey,
        subAppId,
        region: region || 'ap-guangzhou'
    };
}

// ============================================================================
// Web Crypto 工具
// ============================================================================

const textEncoder = new TextEncoder();

function bufToHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
}

async function sha256Hex(input) {
    const data = typeof input === 'string' ? textEncoder.encode(input) : input;
    const hash = await crypto.subtle.digest('SHA-256', data);
    return bufToHex(hash);
}

async function hmacSha256(keyData, msg) {
    const keyBuf = typeof keyData === 'string' ? textEncoder.encode(keyData) : keyData;
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBuf,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const msgBuf = typeof msg === 'string' ? textEncoder.encode(msg) : msg;
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgBuf);
    return new Uint8Array(sig);
}

async function sha1Hex(input) {
    const data = typeof input === 'string' ? textEncoder.encode(input) : input;
    const hash = await crypto.subtle.digest('SHA-1', data);
    return bufToHex(hash);
}

async function hmacSha1Hex(keyStr, msgStr) {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        textEncoder.encode(keyStr),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(msgStr));
    return bufToHex(sig);
}

// ============================================================================
// TC3-HMAC-SHA256 签名 (VOD API)
// ============================================================================

/**
 * 为一次腾讯云 VOD API 请求生成完整 headers（含 Authorization）。
 * 仅适用于 POST JSON 请求（API 3.0 规范）。
 *
 * @param {Object} opts
 * @param {string} opts.secretId
 * @param {string} opts.secretKey
 * @param {string} opts.action          如 'CreateAigcImageTask'
 * @param {string} opts.version         如 '2018-07-17'
 * @param {string} opts.region          可选，如 'ap-guangzhou'；部分接口不强制
 * @param {string} opts.service         如 'vod'
 * @param {string} opts.host            如 'vod.tencentcloudapi.com'
 * @param {string} opts.payload         已序列化的 JSON 字符串 body
 * @returns {Promise<Object>} headers
 */
export async function signVodRequest({ secretId, secretKey, action, version, region, service, host, payload }) {
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // UTC YYYY-MM-DD
    const algorithm = 'TC3-HMAC-SHA256';
    const contentType = 'application/json; charset=utf-8';
    const body = payload || '';

    // 1) CanonicalRequest
    const hashedPayload = await sha256Hex(body);
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = [
        'POST',
        '/',
        '',
        canonicalHeaders,
        signedHeaders,
        hashedPayload
    ].join('\n');

    // 2) StringToSign
    const credentialScope = `${date}/${service}/tc3_request`;
    const hashedCanonical = await sha256Hex(canonicalRequest);
    const stringToSign = [algorithm, String(timestamp), credentialScope, hashedCanonical].join('\n');

    // 3) SecretSigning (chained HMAC; inputs are bytes)
    const secretDate = await hmacSha256('TC3' + secretKey, date);
    const secretService = await hmacSha256(secretDate, service);
    const secretSigning = await hmacSha256(secretService, 'tc3_request');

    // 4) Signature
    const sigBytes = await hmacSha256(secretSigning, stringToSign);
    const signature = bufToHex(sigBytes);

    const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers = {
        Authorization: authorization,
        'Content-Type': contentType,
        Host: host,
        'X-TC-Action': action,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': version
    };
    if (region) headers['X-TC-Region'] = region;
    return headers;
}

// ============================================================================
// 代理 URL 包装（绕过 CORS）
// ============================================================================

/**
 * @param {string} targetUrl
 * @param {Object} opts
 * @param {boolean} opts.useProxy
 * @param {string}  opts.localServerUrl   如 'http://127.0.0.1:9527'
 */
function wrapProxy(targetUrl, { useProxy, localServerUrl }) {
    if (!useProxy) return targetUrl;
    const base = String(localServerUrl || '').trim().replace(/\/+$/, '');
    if (!base) return targetUrl;
    const target = String(targetUrl || '');
    if (target.startsWith(`${base}/file/`) || target.startsWith(`${base}/proxy?`)) return target;
    return `${base}/proxy?url=${encodeURIComponent(target)}`;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

function base64ToBlob(base64, mime = 'application/octet-stream') {
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}

// ============================================================================
// 调用 VOD API
// ============================================================================

/**
 * 调用一次 VOD API
 * @param {string} action
 * @param {Object} body
 * @param {Object} ctx  { credentials, useProxy, localServerUrl }
 * @returns {Promise<Object>} 解析后的 Response 对象
 */
async function callVodApi(action, body, ctx) {
    const { credentials, useProxy, localServerUrl } = ctx;
    const { secretId, secretKey, region } = credentials;
    const payload = JSON.stringify(body || {});

    const headers = await signVodRequest({
        secretId,
        secretKey,
        action,
        version: VOD_API_VERSION,
        region,
        service: VOD_SERVICE,
        host: VOD_API_HOST,
        payload
    });

    // 浏览器侧 fetch 不允许自设 Host 头，去掉
    const fetchHeaders = { ...headers };
    delete fetchHeaders.Host;

    const directUrl = `https://${VOD_API_HOST}`;
    let resp;

    // 通过 fetch 调用（本地代理或直接）
    const finalUrl = wrapProxy(directUrl, { useProxy, localServerUrl });
    try {
        resp = await fetch(finalUrl, {
            method: 'POST',
            headers: fetchHeaders,
            body: payload
        });
    } catch (err) {
        if (!useProxy && localServerUrl) {
            const proxyUrl = wrapProxy(directUrl, { useProxy: true, localServerUrl });
            resp = await fetch(proxyUrl, {
                method: 'POST',
                headers: fetchHeaders,
                body: payload
            });
        } else {
            throw new Error(`[VOD/${action}] 网络请求失败，可能是浏览器 CORS 限制。请确认 CORS 转发服务可用: ${err?.message || err}`);
        }
    }

    const text = await resp.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw new Error(`[VOD/${action}] 响应解析失败 (status=${resp.status}): ${text.slice(0, 300)}`);
    }
    const response = json?.Response || json;
    if (response?.Error) {
        const err = response.Error;
        throw new Error(`[VOD/${action}] ${err.Code || 'Error'}: ${err.Message || 'Unknown error'}`);
    }
    if (!resp.ok) {
        throw new Error(`[VOD/${action}] HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    return response;
}

// ============================================================================
// 文件上传：ApplyUpload → COS PUT → CommitUpload
// ============================================================================

/**
 * 从 Blob/File/URL/DataURL 解析得到 {blob, ext, mime}
 */
async function resolveBlob(input, ctx = {}) {
    if (input instanceof Blob) {
        const mime = input.type || 'image/png';
        const ext = mimeToExt(mime);
        return { blob: input, mime, ext };
    }
    if (typeof input === 'string') {
        // data: URL 或普通 URL
        const isHttpUrl = /^https?:\/\//i.test(input);
        const targetUrl = isHttpUrl ? wrapProxy(input, ctx) : input;
        const resp = await fetch(targetUrl);
        if (!resp.ok) throw new Error(`[VOD Upload] 获取图片失败: ${resp.status}`);
        const blob = await resp.blob();
        const mime = blob.type || 'image/png';
        const ext = mimeToExt(mime);
        return { blob, mime, ext };
    }
    throw new Error('[VOD Upload] 不支持的输入类型');
}

function mimeToExt(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('bmp')) return 'bmp';
    if (m.includes('mp4')) return 'mp4';
    if (m.includes('quicktime') || m.includes('mov')) return 'mov';
    if (m.includes('webm')) return 'webm';
    if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
    if (m.includes('aac')) return 'aac';
    if (m.includes('wav')) return 'wav';
    if (m.includes('ogg')) return 'ogg';
    if (m.includes('m4a')) return 'm4a';
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    return 'jpg';
}

/**
 * 使用 VOD 返回的 TempCertificate，对 COS PUT Object 做简单上传签名。
 * 只签 host 头，最简方案。Token 通过 x-cos-security-token 头单独发送。
 */
async function putObjectToCos({ tempCred, bucket, region, key, blob }, ctx = {}) {
    const host = `${bucket}.cos.${region}.myqcloud.com`;
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 3600;
    const keyTime = `${now};${exp}`;
    const uriPathname = key.startsWith('/') ? key : `/${key}`;

    // 1) SignKey = HMAC-SHA1(TempSecretKey, KeyTime)
    const signKey = await hmacSha1Hex(tempCred.SecretKey, keyTime);
    // 2) HttpString
    const headerList = 'host';
    const httpHeaders = `host=${encodeURIComponent(host)}`;
    const httpString = `put\n${uriPathname}\n\n${httpHeaders}\n`;
    // 3) StringToSign
    const stringToSign = `sha1\n${keyTime}\n${await sha1Hex(httpString)}\n`;
    // 4) Signature
    const signature = await hmacSha1Hex(signKey, stringToSign);

    const authorization = [
        'q-sign-algorithm=sha1',
        `q-ak=${tempCred.SecretId}`,
        `q-sign-time=${keyTime}`,
        `q-key-time=${keyTime}`,
        `q-header-list=${headerList}`,
        'q-url-param-list=',
        `q-signature=${signature}`
    ].join('&');

    // URL 里的 key 需要按路径片段 encode（保留 /）
    const encodedKey = uriPathname.split('/').map((seg) => seg ? encodeURIComponent(seg) : '').join('/');
    let resp;
    
    const url = `https://${host}${encodedKey}`;

    // 通过 fetch 上传（本地代理或直接）
    const finalUrl = wrapProxy(url, ctx);
    try {
        resp = await fetch(finalUrl, {
            method: 'PUT',
            headers: {
                Authorization: authorization,
                'x-cos-security-token': tempCred.Token
                // 注意：不设 Host / Content-Length，浏览器会自动处理；代理会转发目标 Host
            },
            body: blob
        });
    } catch (err) {
        if (!ctx.useProxy && ctx.localServerUrl) {
            const proxyUrl = wrapProxy(url, { ...ctx, useProxy: true });
            resp = await fetch(proxyUrl, {
                method: 'PUT',
                headers: {
                    Authorization: authorization,
                    'x-cos-security-token': tempCred.Token
                },
                body: blob
            });
        } else {
            throw new Error(`[VOD Upload/COS PUT] 网络请求失败，可能是浏览器 CORS 限制。请确认 CORS 转发服务可用: ${err?.message || err}`);
        }
    }
    
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`[VOD Upload/COS PUT] HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
}

/**
 * 完整上传一张图片（或其他媒体）到 VOD 并返回 FileId。
 * @param {Blob|string} imageInput  Blob 或 URL/dataURL
 * @param {Object} ctx
 * @returns {Promise<{fileId:string, mediaUrl:string}>}
 */
export async function uploadImageToVod(imageInput, ctx) {
    const { credentials } = ctx;
    const { blob, ext } = await resolveBlob(imageInput, ctx);

    // 1) ApplyUpload
    const applyResp = await callVodApi('ApplyUpload', {
        MediaType: ext,
        MediaName: `vodstudio-${Date.now()}`,
        SubAppId: credentials.subAppId
    }, ctx);

    const tempCred = applyResp.TempCertificate;
    if (!tempCred?.SecretId || !tempCred?.SecretKey || !tempCred?.Token) {
        throw new Error('[VOD Upload] ApplyUpload 未返回有效临时凭证');
    }

    // 2) COS PUT
    await putObjectToCos({
        tempCred,
        bucket: applyResp.StorageBucket,
        region: applyResp.StorageRegion,
        key: applyResp.MediaStoragePath,
        blob
    }, ctx);

    // 3) CommitUpload
    const commitResp = await callVodApi('CommitUpload', {
        VodSessionKey: applyResp.VodSessionKey,
        SubAppId: credentials.subAppId
    }, ctx);

    if (!commitResp.FileId) {
        throw new Error('[VOD Upload] CommitUpload 未返回 FileId');
    }
    return { fileId: commitResp.FileId, mediaUrl: commitResp.MediaUrl };
}

// ============================================================================
// AIGC 任务创建 & 轮询
// ============================================================================

/**
 * 创建 AIGC 生图任务
 * @returns {Promise<{taskId:string, requestId:string}>}
 */
export async function createAigcImageTask(params, ctx) {
    const body = {
        SubAppId: ctx.credentials.subAppId,
        ModelName: params.modelName,
        ModelVersion: params.modelVersion,
        Prompt: params.prompt || undefined,
        NegativePrompt: params.negativePrompt || undefined,
        EnhancePrompt: params.enhancePrompt || undefined,
        FileInfos: Array.isArray(params.fileInfos) && params.fileInfos.length
            ? params.fileInfos
            : Array.isArray(params.fileIds) && params.fileIds.length
                ? params.fileIds.map((id) => ({ FileId: id }))
                : undefined,
        OutputConfig: params.outputConfig || undefined,
        InputRegion: params.inputRegion || undefined,
        Seed: Number.isFinite(params.seed) ? params.seed : undefined,
        SessionId: params.sessionId || undefined,
        SessionContext: params.sessionContext || undefined,
        TasksPriority: Number.isFinite(params.tasksPriority) ? params.tasksPriority : undefined,
        ExtInfo: params.extInfo || undefined
    };
    // 清理 undefined 字段
    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
    const resp = await callVodApi('CreateAigcImageTask', body, ctx);
    return { taskId: resp.TaskId, requestId: resp.RequestId };
}

/**
 * 创建 AIGC 生视频任务
 * @returns {Promise<{taskId:string, requestId:string}>}
 */
export async function createAigcVideoTask(params, ctx) {
    const body = {
        SubAppId: ctx.credentials.subAppId,
        ModelName: params.modelName,
        ModelVersion: params.modelVersion,
        Prompt: params.prompt || undefined,
        NegativePrompt: params.negativePrompt || undefined,
        EnhancePrompt: params.enhancePrompt || undefined,
        FileInfos: Array.isArray(params.fileInfos) && params.fileInfos.length
            ? params.fileInfos
            : Array.isArray(params.fileIds) && params.fileIds.length
                ? params.fileIds.map((id) => ({ FileId: id }))
                : undefined,
        LastFrameFileId: params.lastFrameFileId || undefined,
        LastFrameUrl: params.lastFrameUrl || undefined,
        SubjectInfos: Array.isArray(params.subjectInfos) && params.subjectInfos.length ? params.subjectInfos : undefined,
        OutputConfig: params.outputConfig || undefined,
        InputRegion: params.inputRegion || undefined,
        SceneType: params.sceneType || undefined,
        Seed: Number.isFinite(params.seed) ? params.seed : undefined,
        SessionId: params.sessionId || undefined,
        SessionContext: params.sessionContext || undefined,
        TasksPriority: Number.isFinite(params.tasksPriority) ? params.tasksPriority : undefined,
        ExtInfo: params.extInfo || undefined
    };
    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
    const resp = await callVodApi('CreateAigcVideoTask', body, ctx);
    return { taskId: resp.TaskId, requestId: resp.RequestId };
}

/**
 * 查询任务详情（单次）
 */
export async function describeTaskDetail(taskId, ctx) {
    return await callVodApi('DescribeTaskDetail', {
        TaskId: taskId,
        SubAppId: ctx.credentials.subAppId
    }, ctx);
}

/**
 * 从 DescribeTaskDetail 的 Response 中抽取结果 URL 列表（不论图/视频）。
 * 文档没有给出 AigcImageTask / AigcVideoTask 内部字段，按常规 VOD 响应约定探查
 * 常见字段：Output.FileUrl / Output.ImageFileUrls / Output.VideoFileUrl / Url 等。
 */
export function extractVodResultUrls(taskDetail) {
    const urls = [];
    const fileIds = [];
    const taskType = taskDetail?.TaskType || '';
    const taskNode = taskDetail?.AigcImageTask || taskDetail?.AigcVideoTask
        || taskDetail?.SceneAigcImageTask || taskDetail?.SceneAigcVideoTask
        || taskDetail?.ComposeMediaTask;
    if (!taskNode) return { urls, fileIds };

    const output = taskNode.Output || taskNode.output || {};
    const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
            obj.forEach(walk);
            return;
        }
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string') {
                const keyLower = k.toLowerCase();
                if (/^https?:\/\//i.test(v) && (keyLower.includes('url') || keyLower.includes('media'))) {
                    if (!urls.includes(v)) urls.push(v);
                } else if (keyLower === 'fileid' || keyLower.endsWith('fileid')) {
                    if (v && !fileIds.includes(v)) fileIds.push(v);
                }
            } else if (typeof v === 'object') {
                walk(v);
            }
        }
    };
    walk(output);
    // 顶层 FileUrls / FileIds 兜底
    if (Array.isArray(taskNode.FileUrls)) {
        taskNode.FileUrls.forEach((u) => { if (u && !urls.includes(u)) urls.push(u); });
    }
    if (Array.isArray(taskNode.FileInfos)) {
        taskNode.FileInfos.forEach((f) => {
            if (f?.FileId && !fileIds.includes(f.FileId)) fileIds.push(f.FileId);
            if (f?.Url && !urls.includes(f.Url)) urls.push(f.Url);
        });
    }
    return { urls, fileIds, taskType };
}

/**
 * 轮询直到任务结束；返回最终的 taskDetail。
 * @param {string} taskId
 * @param {Object} ctx
 * @param {Object} opts { pollIntervalMs, maxAttempts, onProgress(attempt,status) }
 */
export async function pollVodTask(taskId, ctx, opts = {}) {
    const pollInterval = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : 5000;
    const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : 240;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const detail = await describeTaskDetail(taskId, ctx);
        const status = String(detail?.Status || '').toUpperCase();
        if (typeof opts.onProgress === 'function') {
            try { opts.onProgress(attempt, status, detail); } catch (_) {}
        }
        if (status === 'FINISH') {
            // 检查子任务错误码
            const taskNode = detail.AigcImageTask || detail.AigcVideoTask
                || detail.SceneAigcImageTask || detail.SceneAigcVideoTask
                || detail.ComposeMediaTask;
            if (taskNode) {
                const errCode = taskNode.ErrCodeExt || taskNode.ErrCode;
                const hasError = errCode && errCode !== '0' && errCode !== 0 && errCode !== '';
                if (hasError) {
                    const msg = taskNode.Message || 'AIGC 任务失败';
                    throw new Error(`[VOD Task Failed] ${errCode}: ${msg}`);
                }
            }
            return detail;
        }
        if (status === 'ABORTED') {
            throw new Error('[VOD Task] 任务已终止');
        }
        // WAITING / PROCESSING: 继续轮询
        await new Promise((r) => setTimeout(r, pollInterval));
    }
    throw new Error('[VOD Task] 轮询超时');
}

// ============================================================================
// 高层编排：一键"画布上的 VOD 生成任务"
// ============================================================================

/**
 * 端到端执行一个 VOD AIGC 任务。
 * 步骤：
 *   1. 对每张参考图跑 ApplyUpload → COS PUT → CommitUpload，得到 FileIds
 *   2. 调 CreateAigcImageTask / CreateAigcVideoTask
 *   3. 轮询 DescribeTaskDetail 直到 FINISH
 *   4. 从 taskDetail 中抽取结果 URL
 *
 * @param {Object} params
 * @param {'image'|'video'} params.type
 * @param {string}   params.prompt
 * @param {string}   params.negativePrompt
 * @param {string}   params.modelName      如 'GG'
 * @param {string}   params.modelVersion   如 '3.1'
 * @param {Array<Blob|string>} params.sourceImages  参考图（画布上游）
 * @param {Array<Object|null>} params.sourceFileInfos  每个上传文件对应的 FileInfos 附加字段；null 表示不放入 FileInfos
 * @param {number}   params.lastFrameSourceIndex  sourceImages 中作为 LastFrameFileId 的索引
 * @param {string}   params.aspectRatio   如 '16:9'
 * @param {Object}   params.extraConfig   合并到 OutputConfig
 * @param {Object}   params.extraTaskParams  其它任务级别参数
 *
 * @param {Object} ctx  { credentials, useProxy, localServerUrl, onStage(stage,info) }
 * @returns {Promise<{urls:string[], taskId:string, taskDetail:Object}>}
 */
export async function runVodAigcPipeline(params, ctx) {
    const emit = (stage, info = {}) => {
        if (typeof ctx.onStage === 'function') {
            try { ctx.onStage(stage, info); } catch (_) {}
        }
    };

    // 1) 上传参考图（如有）
    const sourceImages = Array.isArray(params.sourceImages)
        ? params.sourceImages.filter(Boolean)
        : [];
    const sourceFileInfos = Array.isArray(params.sourceFileInfos) ? params.sourceFileInfos : null;
    const uploadResults = [];
    const isInnerIpUrl = (url) => {
        if (typeof url !== 'string') return false;
        // 内网 IP / 本地地址：127.x.x.x、192.168.x.x、10.x.x.x、172.16-31.x.x、localhost、0.0.0.0
        return /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?(\/|$)/i.test(url);
    };
    for (let i = 0; i < sourceImages.length; i++) {
        const source = sourceImages[i];
        const canReferenceUrlDirectly = !!sourceFileInfos && typeof source === 'string' && /^https?:\/\//i.test(source) && !isInnerIpUrl(source);
        emit('upload_start', { index: i, total: sourceImages.length, directUrl: canReferenceUrlDirectly });
        if (canReferenceUrlDirectly) {
            uploadResults.push({ url: source });
            emit('upload_done', { index: i, total: sourceImages.length, url: source, directUrl: true });
            continue;
        }
        const uploadResult = await uploadImageToVod(source, ctx);
        uploadResults.push(uploadResult);
        emit('upload_done', { index: i, total: sourceImages.length, fileId: uploadResult.fileId });
    }
    const fileIds = uploadResults.map((item) => item.fileId).filter(Boolean);
    const fileInfos = sourceFileInfos
        ? uploadResults
            .map((item, index) => {
                const meta = sourceFileInfos[index];
                if (!meta) return null;
                if (item.fileId) return { FileId: item.fileId, ...meta };
                if (item.url) return { ...meta, Type: meta.Type || 'Url', Url: item.url };
                return null;
            })
            .filter(Boolean)
        : null;
    const lastFrameSourceIndex = Number.isInteger(params.lastFrameSourceIndex) ? params.lastFrameSourceIndex : -1;
    const lastFrameSource = lastFrameSourceIndex >= 0 ? uploadResults[lastFrameSourceIndex] : null;
    const lastFrameFileId = lastFrameSource?.fileId;
    const lastFrameUrl = lastFrameSource?.url;

    // 2) 创建任务
    const outputConfig = {
        StorageMode: 'Temporary',
        ...(params.aspectRatio ? { AspectRatio: params.aspectRatio } : {}),
        ...(params.extraConfig || {})
    };
    const createParams = {
        modelName: params.modelName,
        modelVersion: params.modelVersion,
        prompt: params.prompt,
        negativePrompt: params.negativePrompt,
        enhancePrompt: params.enhancePrompt,
        fileIds: fileInfos ? [] : fileIds,
        fileInfos: fileInfos || undefined,
        lastFrameFileId,
        lastFrameUrl,
        outputConfig,
        ...(params.extraTaskParams || {})
    };
    emit('create_task', createParams);
    const { taskId } = params.type === 'video'
        ? await createAigcVideoTask(createParams, ctx)
        : await createAigcImageTask(createParams, ctx);
    emit('task_created', { taskId });

    // 3) 轮询
    const taskDetail = await pollVodTask(taskId, ctx, {
        pollIntervalMs: 5000,
        maxAttempts: 240,
        onProgress: (attempt, status) => emit('polling', { attempt, status, taskId })
    });

    // 4) 抽取结果
    const { urls, fileIds: outputFileIds } = extractVodResultUrls(taskDetail);
    emit('task_finish', { taskId, urls });

    if (!urls.length) {
        throw new Error('[VOD Task] 任务完成但未返回可用的输出 URL');
    }
    return { urls, taskId, taskDetail, outputFileIds };
}

// ============================================================================
// 与 App.jsx 集成的便捷常量
// ============================================================================

export const VOD_IMAGE_RATIOS = ['Auto', '1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '3:2', '2:3'];
export const VOD_VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
export const VOD_VIDEO_DURATIONS = ['5s', '10s'];

/**
 * 判断一个 modelId 是否是 VOD AIGC 模型
 */
export function isVodModel(modelId) {
    return modelId === VOD_IMAGE_MODEL_ID || modelId === VOD_VIDEO_MODEL_ID;
}

/**
 * 从节点 customParam 选择结果里解析出 VOD 需要的 ModelName / ModelVersion。
 * 约定：customParams 里会有两个参数 "ModelName" 和 "ModelVersion"
 */
export function resolveVodSubModel(type, customParamSelections, customParams = []) {
    const sel = customParamSelections || {};
    const matrix = type === 'video' ? VOD_VIDEO_MODEL_MATRIX : VOD_IMAGE_MODEL_MATRIX;
    const defaultModelName = type === 'video' ? VOD_DEFAULT_VIDEO_MODEL_NAME : VOD_DEFAULT_IMAGE_MODEL_NAME;
    const defaultModelVersion = type === 'video' ? VOD_DEFAULT_VIDEO_MODEL_VERSION : VOD_DEFAULT_IMAGE_MODEL_VERSION;

    const pickSelection = (names, ids = []) => {
        for (const key of [...ids, ...names]) {
            const value = sel[key];
            if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
        }
        for (const param of customParams || []) {
            const paramName = String(param?.name || '').trim();
            const paramId = String(param?.id || '').trim();
            if (!names.includes(paramName) && !ids.includes(paramId)) continue;
            const value = sel[paramId] ?? sel[paramName] ?? param.defaultValue;
            if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
        }
        return '';
    };

    let modelName = pickSelection(['ModelName', 'modelName'], ['vod-model-name']) || defaultModelName;
    // 过滤自定义模式占位标记
    if (modelName === '__custom__') modelName = '';
    const isCustom = modelName && !matrix[modelName];
    if (!isCustom) {
        // 预设模型：版本必须在矩阵范围内
        const versions = matrix[modelName] || [];
        const modelVersion = pickSelection(['ModelVersion', 'modelVersion'], ['vod-model-version']);
        const fallbackVersion = versions.includes(defaultModelVersion) ? defaultModelVersion : versions[0] || '';
        return {
            modelName,
            modelVersion: modelVersion && versions.includes(modelVersion) ? modelVersion : fallbackVersion
        };
    }
    // 自定义模型：直接透传用户输入的 modelName 和 modelVersion
    const modelVersion = pickSelection(['ModelVersion', 'modelVersion'], ['vod-model-version']) || '';
    return { modelName, modelVersion };
}

// ============================================================================
// 视频合成（ComposeMedia）：把多个视频片段按 EDL 编辑指令合成一条成片
// ----------------------------------------------------------------------------
// 复用现有 上传(uploadImageToVod) / 签名(callVodApi) / 轮询(pollVodTask) 基建。
// 支持：片段排序、裁剪(in/out)、转场(transition)、字幕(caption，渲染为透明 PNG 贴纸)、
//      配乐(bgm，音频轨)。
//
// ComposeMedia 轨道结构（来自官方请求示例）：
//   Tracks: [ { Type:'Video'|'Audio'|'Sticker', TrackItems:[ {Type, VideoItem|AudioItem|StickerItem|TransitionItem|EmptyItem} ] } ]
//   VideoItem:      { SourceMedia(FileId), SourceMediaStartTime, Duration, ... }
//   AudioItem:      { SourceMedia(FileId), SourceMediaStartTime, Duration, AudioOperations }
//   StickerItem:    { SourceMedia(FileId), StartTime, Duration, CoordinateOrigin, XPos, YPos, Width, Height }
//   TransitionItem: { Duration, MediaTransitions:[{Type:'ImageFadeInFadeOut'|...}] }
//   EmptyItem:      { Duration }
//   Output:         { Container:'mp4', FileName }
//   Canvas:         { Width, Height, Color }
// ============================================================================

// 转场类型枚举（图像类转场，作用于视频轨）
export const VOD_TRANSITION_TYPES = [
    { id: 'none', label: '无', type: null },
    { id: 'fade', label: '淡入淡出', type: 'ImageFadeInFadeOut' },
    { id: 'fadeBlack', label: '淡出后淡入', type: 'ImageFadeOutThenFadeIn' },
    { id: 'slideUp', label: '上滑', type: 'ImageSlideUp' },
    { id: 'slideDown', label: '下滑', type: 'ImageSlideDown' },
    { id: 'slideLeft', label: '左滑', type: 'ImageSlideLeft' },
    { id: 'slideRight', label: '右滑', type: 'ImageSlideRight' }
];

function resolveTransitionType(id) {
    const found = VOD_TRANSITION_TYPES.find((t) => t.id === id);
    return found ? found.type : (id && id !== 'none' ? id : null);
}

/**
 * 上传任意媒体（视频/音频/图片）到 VOD 并返回 FileId。
 * 是 uploadImageToVod 的语义化别名（其底层已支持 mp4/音频扩展名）。
 */
export async function uploadMediaToVod(input, ctx) {
    return uploadImageToVod(input, ctx);
}

/**
 * 把字幕文字渲染成「透明背景 PNG」Blob（浏览器侧 canvas）。
 * 作为 ComposeMedia 的 Sticker 贴纸叠加到视频轨，兼容性最好。
 * @param {string} text
 * @param {Object} opts { canvasWidth, canvasHeight, fontSize, color, strokeColor, bgColor, fontFamily }
 * @returns {Promise<Blob>}
 */
export async function renderCaptionToPngBlob(text, opts = {}) {
    if (typeof document === 'undefined') {
        throw new Error('[VOD Compose] 字幕渲染需要浏览器环境');
    }
    const canvasWidth = Math.max(2, Math.round(opts.canvasWidth || 1280));
    const fontSize = Math.max(8, Math.round(opts.fontSize || Math.round(canvasWidth / 28)));
    const lineHeight = Math.round(fontSize * 1.35);
    const paddingY = Math.round(fontSize * 0.5);
    const fontFamily = opts.fontFamily || '"PingFang SC","Microsoft YaHei",sans-serif';
    const color = opts.color || '#FFFFFF';
    const strokeColor = opts.strokeColor || 'rgba(0,0,0,0.85)';
    const bgColor = opts.bgColor || 'transparent';

    // 简易自动换行（按字符宽度估算）
    const measureCanvas = document.createElement('canvas');
    const mctx = measureCanvas.getContext('2d');
    mctx.font = `bold ${fontSize}px ${fontFamily}`;
    const maxTextWidth = canvasWidth * 0.92;
    const lines = [];
    let current = '';
    for (const ch of String(text || '')) {
        if (ch === '\n') { lines.push(current); current = ''; continue; }
        const test = current + ch;
        if (mctx.measureText(test).width > maxTextWidth && current) {
            lines.push(current);
            current = ch;
        } else {
            current = test;
        }
    }
    if (current) lines.push(current);
    if (!lines.length) lines.push('');

    const canvasHeight = lineHeight * lines.length + paddingY * 2;
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');
    if (bgColor && bgColor !== 'transparent') {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    }
    ctx.font = `bold ${fontSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, Math.round(fontSize / 8));
    lines.forEach((line, i) => {
        const y = paddingY + lineHeight * i + lineHeight / 2;
        ctx.strokeStyle = strokeColor;
        ctx.strokeText(line, canvasWidth / 2, y);
        ctx.fillStyle = color;
        ctx.fillText(line, canvasWidth / 2, y);
    });

    return await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('[VOD Compose] 字幕 PNG 生成失败'));
        }, 'image/png');
    });
}

const VOD_FILE_ID_RE = /^\d{10,}$/;

/**
 * 端到端执行一次视频合成。
 *
 * @param {Object} plan  编辑指令(EDL)
 *   plan.canvas    {width,height,color}            画布，可选
 *   plan.clips     [{ src, isFileId, in, out, transition, transitionDuration, caption }]
 *                  - src: 片段视频的 FileId 或 URL/Blob/dataURL
 *                  - in/out: 裁剪起止秒（out 缺省=整段）
 *                  - transition: 与「上一个」片段之间的转场 id（首个片段忽略）
 *                  - transitionDuration: 转场时长秒（默认 0.5）
 *                  - caption: { text, fontSize, color, bottomPercent } | null
 *   plan.bgm       { src, isFileId, volume(0~2), in } | null  配乐
 *   plan.output    { fileName, container }
 *
 * @param {Object} ctx  { credentials, useProxy, localServerUrl, onStage(stage,info) }
 * @returns {Promise<{urls:string[], taskId:string, taskDetail:Object, outputFileIds:string[]}>}
 */
export async function runVodComposePipeline(plan, ctx) {
    const emit = (stage, info = {}) => {
        if (typeof ctx.onStage === 'function') {
            try { ctx.onStage(stage, info); } catch (_) {}
        }
    };
    const clips = Array.isArray(plan?.clips) ? plan.clips.filter(Boolean) : [];
    if (!clips.length) throw new Error('[VOD Compose] 没有可合成的视频片段');

    const canvas = plan.canvas || {};
    const canvasWidth = Math.round(canvas.width || 0) || 0;

    // 待上传的媒体收集（去重）：clip 视频、字幕 PNG、bgm
    const fileIdCache = new Map(); // key(src 字符串引用) -> fileId

    const resolveToFileId = async (src, isFileId, label) => {
        if (src == null) return null;
        if (isFileId && typeof src === 'string' && src.trim()) return src.trim();
        if (typeof src === 'string' && VOD_FILE_ID_RE.test(src.trim())) return src.trim();
        const cacheKey = typeof src === 'string' ? src : src; // Blob 用引用
        if (fileIdCache.has(cacheKey)) return fileIdCache.get(cacheKey);
        const { fileId } = await uploadMediaToVod(src, ctx);
        if (!fileId) throw new Error(`[VOD Compose] ${label || '媒体'}上传未返回 FileId`);
        fileIdCache.set(cacheKey, fileId);
        return fileId;
    };

    // 1) 上传所有片段视频
    const total = clips.length + (plan.bgm ? 1 : 0);
    let uploaded = 0;
    const clipFileIds = [];
    for (let i = 0; i < clips.length; i++) {
        emit('upload_start', { index: uploaded, total, label: `片段${i + 1}` });
        const fid = await resolveToFileId(clips[i].src, clips[i].isFileId, `片段${i + 1}`);
        clipFileIds.push(fid);
        uploaded += 1;
        emit('upload_done', { index: uploaded - 1, total, fileId: fid });
    }

    // 2) 上传配乐
    let bgmFileId = null;
    if (plan.bgm && plan.bgm.src) {
        emit('upload_start', { index: uploaded, total, label: '配乐' });
        bgmFileId = await resolveToFileId(plan.bgm.src, plan.bgm.isFileId, '配乐');
        uploaded += 1;
        emit('upload_done', { index: uploaded - 1, total, fileId: bgmFileId });
    }

    // 3) 渲染并上传字幕 PNG（含输出时间轴起点计算）
    emit('compose_build', {});
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const videoTrackItems = [];
    const stickerItems = [];
    let timelineStart = 0; // 当前片段在成片时间轴上的起点（秒）
    let totalTimeline = 0;

    for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const inSec = Math.max(0, num(clip.in, 0));
        const outSec = num(clip.out, NaN);
        const hasDuration = Number.isFinite(outSec) && outSec > inSec;
        const duration = hasDuration ? (outSec - inSec) : num(clip.duration, 0);

        // 片段间转场（从第二个片段起）
        let transitionDur = 0;
        if (i > 0) {
            const tType = resolveTransitionType(clip.transition);
            if (tType) {
                transitionDur = Math.max(0.1, num(clip.transitionDuration, 0.5));
                videoTrackItems.push({
                    Type: 'Transition',
                    TransitionItem: {
                        Duration: transitionDur,
                        MediaTransitions: [{ Type: tType }]
                    }
                });
                // 转场会让相邻片段重叠 transitionDur，时间轴回退
                timelineStart = Math.max(0, timelineStart - transitionDur);
            }
        }

        const videoItem = { SourceMedia: clipFileIds[i] };
        if (inSec > 0) videoItem.SourceMediaStartTime = inSec;
        if (duration > 0) videoItem.Duration = duration;
        // 片段自身静音（由配乐控制时）
        if (clip.mute) videoItem.AudioOperations = [{ Type: 'Volume', VolumeParam: { Mute: 1 } }];
        videoTrackItems.push({ Type: 'Video', VideoItem: videoItem });

        // 字幕贴纸（覆盖该片段时段）
        if (clip.caption && String(clip.caption.text || '').trim() && canvasWidth > 0) {
            const cap = clip.caption;
            const pngBlob = await renderCaptionToPngBlob(cap.text, {
                canvasWidth,
                fontSize: cap.fontSize || Math.round(canvasWidth / 28),
                color: cap.color || '#FFFFFF'
            });
            emit('upload_start', { index: uploaded, total: total, label: `字幕${i + 1}` });
            const capFid = await uploadMediaToVod(pngBlob, ctx);
            uploaded += 1;
            emit('upload_done', { index: uploaded - 1, total, fileId: capFid?.fileId });
            const bottomPercent = num(cap.bottomPercent, 12);
            stickerItems.push({
                Type: 'Sticker',
                StickerItem: {
                    SourceMedia: capFid.fileId,
                    CoordinateOrigin: 'Center',
                    XPos: '50%',
                    YPos: `${Math.round(100 - bottomPercent)}%`,
                    Width: '92%',
                    StartTime: timelineStart,
                    Duration: duration > 0 ? duration : undefined
                }
            });
        }

        timelineStart += (duration > 0 ? duration : 0);
        totalTimeline = Math.max(totalTimeline, timelineStart);
    }

    // 4) 组装 Tracks
    const tracks = [{ Type: 'Video', TrackItems: videoTrackItems }];
    if (stickerItems.length) {
        tracks.push({ Type: 'Sticker', TrackItems: stickerItems });
    }
    if (bgmFileId) {
        const audioItem = { SourceMedia: bgmFileId };
        const bgmIn = num(plan.bgm.in, 0);
        if (bgmIn > 0) audioItem.SourceMediaStartTime = bgmIn;
        if (totalTimeline > 0) audioItem.Duration = totalTimeline;
        const vol = num(plan.bgm.volume, 1);
        if (vol !== 1) {
            audioItem.AudioOperations = [{ Type: 'Volume', VolumeParam: { Gain: vol } }];
        }
        tracks.push({ Type: 'Audio', TrackItems: [{ Type: 'Audio', AudioItem: audioItem }] });
    }

    // 5) 构建请求体
    const body = {
        SubAppId: ctx.credentials.subAppId,
        Tracks: tracks,
        Output: {
            Container: (plan.output && plan.output.container) || 'mp4',
            FileName: (plan.output && plan.output.fileName) || `vodstudio-compose-${Date.now()}`
        }
    };
    if (canvasWidth > 0 && canvas.height > 0) {
        body.Canvas = {
            Width: Math.round(canvasWidth),
            Height: Math.round(canvas.height)
        };
        // Canvas.Color 是可选字段；部分 VOD 环境会拒绝默认黑色值 0x000000，未显式设置时不传。
        if (canvas.color && String(canvas.color).trim()) {
            body.Canvas.Color = String(canvas.color).trim();
        }
    }

    emit('create_task', { tracks: tracks.length });
    const resp = await callVodApi('ComposeMedia', body, ctx);
    const taskId = resp.TaskId;
    if (!taskId) throw new Error('[VOD Compose] ComposeMedia 未返回 TaskId');
    emit('task_created', { taskId });

    // 6) 轮询
    const taskDetail = await pollVodTask(taskId, ctx, {
        pollIntervalMs: 5000,
        maxAttempts: 360,
        onProgress: (attempt, status) => emit('polling', { attempt, status, taskId })
    });

    // 7) 抽取成片 URL
    let urls = [];
    let outputFileIds = [];
    const composeNode = taskDetail?.ComposeMediaTask;
    const output = composeNode?.Output || {};
    if (output.MediaUrl) urls.push(output.MediaUrl);
    if (output.FileId) outputFileIds.push(output.FileId);
    if (!urls.length) {
        const ext = extractVodResultUrls(taskDetail);
        urls = ext.urls;
        outputFileIds = ext.fileIds;
    }
    emit('task_finish', { taskId, urls });

    if (!urls.length && !outputFileIds.length) {
        throw new Error('[VOD Compose] 合成完成但未返回可用的成片 URL/FileId');
    }
    return { urls, taskId, taskDetail, outputFileIds };
}

// ============================================================================
// 智能识别 · 语音全文识别（ASR Full Text Recognition）
// ----------------------------------------------------------------------------
// 使用 ProcessMedia 接口发起识别任务，预置模板 ID：
//   - 111: 中文识别，生成 vtt 字幕
//   - 112: 英文识别，生成 vtt 字幕
//   - 113: 日文识别，生成 vtt 字幕
// 识别完成后从 DescribeTaskDetail 的 AiRecognitionResultSet 中提取字幕 URL。
// ============================================================================

/** 语音全文识别预置模板 */
export const ASR_FULLTEXT_TEMPLATES = [
    { id: 111, label: '中文', lang: 'zh' },
    { id: 112, label: 'English', lang: 'en' },
    { id: 113, label: '日本語', lang: 'ja' }
];

/**
 * 对已上传到 VOD 的 FileId 发起语音全文识别任务
 * @param {string} fileId  VOD 媒体文件 ID
 * @param {number} definition  智能识别模板 ID (111=中文, 112=英文, 113=日文)
 * @param {Object} ctx  { credentials, useProxy, localServerUrl }
 * @returns {Promise<{taskId: string}>}
 */
export async function processMediaAsrFullText(fileId, definition, ctx) {
    const body = {
        FileId: fileId,
        SubAppId: ctx.credentials.subAppId,
        AiRecognitionTask: {
            Definition: definition
        }
    };
    const resp = await callVodApi('ProcessMedia', body, ctx);
    const taskId = resp.TaskId;
    if (!taskId) throw new Error('[VOD ASR] ProcessMedia 未返回 TaskId');
    return { taskId };
}

/**
 * 从 DescribeTaskDetail 的响应中提取语音全文识别结果的字幕文件 URL
 * @param {Object} taskDetail  DescribeTaskDetail 返回的完整响应
 * @returns {string|null} VTT 字幕文件 URL，未找到则返回 null
 */
export function extractAsrSubtitleUrl(taskDetail) {
    // ProcessMedia 的结果在 AiRecognitionResultSet 中
    const resultSet = taskDetail?.AiRecognitionResultSet
        || taskDetail?.AiRecognitionTask?.ResultSet
        || [];
    for (const item of resultSet) {
        if (item.Type === 'AsrFullTextRecognition') {
            // OutputStorage 中有字幕文件
            const outputSet = item.SegmentResultSet || item.Output?.SubtitleSet || [];
            // 尝试从 SubtitlePath / SubtitleUrl 获取
            if (item.Output?.SubtitleUrl) return item.Output.SubtitleUrl;
            if (item.OutputStorage?.Path) return item.OutputStorage.Path;
            // 遍历 SegmentSet / SubtitleSet
            for (const seg of outputSet) {
                if (seg.SubtitleUrl) return seg.SubtitleUrl;
                if (seg.Url) return seg.Url;
            }
        }
    }
    // 备用：遍历整个 taskDetail 寻找 .vtt URL
    const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return null;
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const r = walk(item);
                if (r) return r;
            }
            return null;
        }
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string' && /\.vtt/i.test(v) && /^https?:\/\//i.test(v)) {
                return v;
            }
            if (typeof v === 'object') {
                const r = walk(v);
                if (r) return r;
            }
        }
        return null;
    };
    return walk(taskDetail);
}

/**
 * 完整流程：发起语音全文识别 → 轮询 → 提取字幕 URL
 * @param {string} fileId  VOD 媒体文件 ID
 * @param {number} definition  模板 ID (111/112/113)
 * @param {Object} ctx
 * @param {Object} opts  { onProgress(attempt, status) }
 * @returns {Promise<{subtitleUrl: string, taskId: string, taskDetail: Object}>}
 */
export async function runAsrFullTextPipeline(fileId, definition, ctx, opts = {}) {
    const { taskId } = await processMediaAsrFullText(fileId, definition, ctx);

    const taskDetail = await pollVodTask(taskId, ctx, {
        pollIntervalMs: 3000,
        maxAttempts: 200,
        onProgress: opts.onProgress
    });

    const subtitleUrl = extractAsrSubtitleUrl(taskDetail);
    if (!subtitleUrl) {
        throw new Error('[VOD ASR] 语音全文识别完成但未找到字幕文件 URL');
    }
    return { subtitleUrl, taskId, taskDetail };
}
