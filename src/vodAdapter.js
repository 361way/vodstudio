// ============================================================================
// 腾讯云 VOD AIGC 适配器 (Tapnow Studio)
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
export const VOD_DEFAULT_IMAGE_MODEL_NAME = 'GG';
export const VOD_DEFAULT_IMAGE_MODEL_VERSION = '2.5';
export const VOD_DEFAULT_VIDEO_MODEL_NAME = 'GV';
export const VOD_DEFAULT_VIDEO_MODEL_VERSION = '3.1-fast';

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
    return `${base}/proxy?url=${encodeURIComponent(targetUrl)}`;
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
    const finalUrl = wrapProxy(directUrl, { useProxy, localServerUrl });

    let resp;
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
    const url = `https://${host}${encodedKey}`;
    const finalUrl = wrapProxy(url, ctx);

    let resp;
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
        MediaName: `tapnow-${Date.now()}`,
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
        FileInfos: Array.isArray(params.fileIds) && params.fileIds.length
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
        FileInfos: Array.isArray(params.fileIds) && params.fileIds.length
            ? params.fileIds.map((id) => ({ FileId: id }))
            : undefined,
        LastFrameFileId: params.lastFrameFileId || undefined,
        LastFrameUrl: params.lastFrameUrl || undefined,
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
        || taskDetail?.SceneAigcImageTask || taskDetail?.SceneAigcVideoTask;
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
                || detail.SceneAigcImageTask || detail.SceneAigcVideoTask;
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
    const fileIds = [];
    for (let i = 0; i < sourceImages.length; i++) {
        emit('upload_start', { index: i, total: sourceImages.length });
        const { fileId } = await uploadImageToVod(sourceImages[i], ctx);
        fileIds.push(fileId);
        emit('upload_done', { index: i, total: sourceImages.length, fileId });
    }

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
        fileIds,
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
    if (!matrix[modelName]) modelName = defaultModelName;
    const versions = matrix[modelName] || [];
    const modelVersion = pickSelection(['ModelVersion', 'modelVersion'], ['vod-model-version']);
    const fallbackVersion = versions.includes(defaultModelVersion) ? defaultModelVersion : versions[0] || '';
    return {
        modelName,
        modelVersion: modelVersion && versions.includes(modelVersion) ? modelVersion : fallbackVersion
    };
}
