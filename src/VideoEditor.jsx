// ============================================================================
// 智能分镜 · 视频合并 + 在线编辑器
// ----------------------------------------------------------------------------
// name: VideoEditor
// description: >
//   对智能分镜节点生成的所有视频片段进行「一键合并 + 在线编辑」的可视化编辑器。
//   提供时间轴轨道（拖拽排序）、片段裁剪(in/out)、转场、字幕、配乐，编辑结果组织为
//   EDL 指令交由腾讯云 VOD ComposeMedia 云端合成出片（合成逻辑见 src/vodAdapter.js）。
// module: storyboard / video-merge-editor
// props:
//   - open            是否显示
//   - onClose         关闭回调
//   - theme           'dark' | 'light' | 'solarized'
//   - t               i18n 翻译函数
//   - initialClips    [{ id, srcUrl, label }]  片段（顺序=分镜片段顺序）
//   - canvasSize      { width, height }  画布尺寸（由分镜比例推导）
//   - onCompose       (plan, { onStage }) => Promise<{ url, taskId }>  云端合成
// ============================================================================

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
    X, Scissors, Music, Type as TypeIcon, Film, Play, Pause, Download,
    Trash2, GripVertical, Loader2, Wand2, ChevronDown, Subtitles, ToggleLeft, ToggleRight
} from 'lucide-react';
import { VOD_TRANSITION_TYPES, ASR_FULLTEXT_TEMPLATES, runAsrFullTextPipeline } from './vodAdapter';

const ASPECT_PRESETS = [
    { id: '16:9', label: '16:9 横屏', width: 1920, height: 1080 },
    { id: '9:16', label: '9:16 竖屏', width: 1080, height: 1920 },
    { id: '1:1', label: '1:1 方形', width: 1080, height: 1080 },
    { id: '4:3', label: '4:3', width: 1440, height: 1080 },
    { id: '21:9', label: '21:9 宽幅', width: 2560, height: 1080 }
];

const CAPTION_COLORS = ['#FFFFFF', '#FFE600', '#FF5252', '#00E5FF', '#7CFC00', '#000000'];

function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec - Math.floor(sec)) * 10);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`;
}

function uid() {
    return `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function VideoEditor({
    open,
    onClose,
    theme = 'dark',
    t = (s) => s,
    initialClips = [],
    canvasSize = null,
    onCompose,
    vodCtx = null   // { credentials, useProxy, localServerUrl } 用于调用 VOD API（字幕识别等）
}) {
    const isDark = theme === 'dark';
    const isSolarized = theme === 'solarized';

    // 主题色辅助
    const ui = useMemo(() => {
        if (isDark) return {
            overlay: 'bg-black/70',
            panel: 'bg-[#18181b] border-zinc-800 text-zinc-200',
            sub: 'bg-[#0f0f12] border-zinc-800',
            card: 'bg-zinc-900 border-zinc-700',
            cardActive: 'border-blue-500 ring-1 ring-blue-500/40',
            input: 'bg-zinc-900 border-zinc-700 text-zinc-200',
            mutedText: 'text-zinc-400',
            btn: 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200',
        };
        if (isSolarized) return {
            overlay: 'bg-[#002b36]/60',
            panel: 'bg-[#eee8d5] border-[#d7cfb2] text-[#073642]',
            sub: 'bg-[#fdf6e3] border-[#d7cfb2]',
            card: 'bg-[#fdf6e3] border-[#d7cfb2]',
            cardActive: 'border-blue-600 ring-1 ring-blue-500/40',
            input: 'bg-[#fdf6e3] border-[#d7cfb2] text-[#073642]',
            mutedText: 'text-[#586e75]',
            btn: 'bg-[#e6dfc4] hover:bg-[#ddd5b6] text-[#073642]',
        };
        return {
            overlay: 'bg-black/50',
            panel: 'bg-white border-zinc-200 text-zinc-800',
            sub: 'bg-zinc-50 border-zinc-200',
            card: 'bg-white border-zinc-200',
            cardActive: 'border-blue-500 ring-1 ring-blue-500/40',
            input: 'bg-white border-zinc-300 text-zinc-800',
            mutedText: 'text-zinc-500',
            btn: 'bg-zinc-200 hover:bg-zinc-300 text-zinc-700',
        };
    }, [isDark, isSolarized]);

    // ---- 编辑状态 ----
    const [clips, setClips] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [aspect, setAspect] = useState('16:9');
    const [bgm, setBgm] = useState(null); // { name, url, volume }
    const [outputName, setOutputName] = useState('merged-video');

    // 合成进度/结果
    const [composing, setComposing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [stageText, setStageText] = useState('');
    const [resultUrl, setResultUrl] = useState('');
    const [errorText, setErrorText] = useState('');

    // ---- 字幕（ASR 语音全文识别）----
    const [subtitleEnabled, setSubtitleEnabled] = useState(false);        // 字幕开关
    const [subtitleLang, setSubtitleLang] = useState(111);                // 模板 ID: 111中文 112英文 113日文
    const [subtitleLoading, setSubtitleLoading] = useState(false);        // 识别中
    const [subtitleUrl, setSubtitleUrl] = useState('');                   // VTT 字幕文件 URL
    const [subtitleError, setSubtitleError] = useState('');               // 错误信息
    const [subtitleProgress, setSubtitleProgress] = useState('');         // 识别进度文字

    // 预览播放器
    const previewRef = useRef(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [previewTime, setPreviewTime] = useState(0);

    const dragIndexRef = useRef(null);
    const [dragOverIndex, setDragOverIndex] = useState(null);
    const bgmInputRef = useRef(null);

    // 初始化：把分镜片段转为可编辑 clip（首次打开或片段变化）
    useEffect(() => {
        if (!open) return;
        const next = (initialClips || []).map((c) => ({
            id: c.id || uid(),
            srcUrl: c.srcUrl,
            label: c.label || '',
            duration: 0,        // 元数据加载后填充
            in: 0,
            out: 0,             // 0 表示整段
            transition: 'none', // 与上一个片段之间的转场
            transitionDuration: 0.5,
            caption: { text: c.caption || '', fontSize: 0, color: '#FFFFFF', bottomPercent: 12 },
            mute: false
        }));
        setClips(next);
        setSelectedId(next[0]?.id || null);
        setResultUrl('');
        setErrorText('');
        setProgress(0);
        // 根据画布尺寸推导初始比例
        if (canvasSize?.width && canvasSize?.height) {
            const r = canvasSize.width / canvasSize.height;
            let best = ASPECT_PRESETS[0];
            let bestDiff = Infinity;
            for (const p of ASPECT_PRESETS) {
                const diff = Math.abs((p.width / p.height) - r);
                if (diff < bestDiff) { bestDiff = diff; best = p; }
            }
            setAspect(best.id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const selectedClip = clips.find((c) => c.id === selectedId) || null;
    const aspectPreset = ASPECT_PRESETS.find((p) => p.id === aspect) || ASPECT_PRESETS[0];

    const updateClip = useCallback((id, patch) => {
        setClips((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    }, []);

    const updateClipCaption = useCallback((id, patch) => {
        setClips((prev) => prev.map((c) => (c.id === id ? { ...c, caption: { ...c.caption, ...patch } } : c)));
    }, []);

    // 加载每个片段的时长元数据
    const onMetaLoaded = useCallback((id, duration) => {
        setClips((prev) => prev.map((c) => {
            if (c.id !== id) return c;
            const out = c.out > 0 ? c.out : duration;
            return { ...c, duration, out: Math.min(out, duration) || duration };
        }));
    }, []);

    // ---- 拖拽排序 ----
    const handleDragStart = (index) => { dragIndexRef.current = index; };
    const handleDragOver = (e, index) => { e.preventDefault(); setDragOverIndex(index); };
    const handleDrop = (index) => {
        const from = dragIndexRef.current;
        dragIndexRef.current = null;
        setDragOverIndex(null);
        if (from == null || from === index) return;
        setClips((prev) => {
            const arr = [...prev];
            const [moved] = arr.splice(from, 1);
            arr.splice(index, 0, moved);
            return arr;
        });
    };

    const removeClip = (id) => {
        setClips((prev) => prev.filter((c) => c.id !== id));
        if (selectedId === id) setSelectedId((prev) => {
            const remain = clips.filter((c) => c.id !== id);
            return remain[0]?.id || null;
        });
    };

    // ---- 预览：选中片段裁剪区间内播放 ----
    useEffect(() => {
        const v = previewRef.current;
        if (!v || !selectedClip) return;
        const onTime = () => {
            setPreviewTime(v.currentTime);
            const out = selectedClip.out > 0 ? selectedClip.out : (selectedClip.duration || Infinity);
            if (v.currentTime >= out) {
                v.currentTime = selectedClip.in || 0;
                if (!v.paused) v.play().catch(() => {});
            }
        };
        v.addEventListener('timeupdate', onTime);
        return () => v.removeEventListener('timeupdate', onTime);
    }, [selectedClip]);

    useEffect(() => {
        const v = previewRef.current;
        if (!v || !selectedClip) return;
        // 切换片段时定位到 in 点
        try { v.currentTime = selectedClip.in || 0; } catch (_) {}
        setIsPlaying(false);
        v.pause();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId]);

    const togglePlay = () => {
        const v = previewRef.current;
        if (!v) return;
        if (v.paused) {
            if (selectedClip && (v.currentTime < selectedClip.in || v.currentTime >= (selectedClip.out || selectedClip.duration || Infinity))) {
                v.currentTime = selectedClip.in || 0;
            }
            v.play().then(() => setIsPlaying(true)).catch(() => {});
        } else {
            v.pause();
            setIsPlaying(false);
        }
    };

    // ---- 字幕 track 自动激活 ----
    useEffect(() => {
        const v = previewRef.current;
        if (!v) return;
        // 延迟确保 track 元素已挂载
        const timer = setTimeout(() => {
            const tracks = v.textTracks;
            if (tracks && tracks.length > 0) {
                for (let i = 0; i < tracks.length; i++) {
                    tracks[i].mode = (subtitleEnabled && subtitleUrl) ? 'showing' : 'hidden';
                }
            }
        }, 200);
        return () => clearTimeout(timer);
    }, [subtitleEnabled, subtitleUrl, selectedId]);

    // ---- 字幕识别调用 ----
    const handleSubtitleRecognize = useCallback(async () => {
        if (!selectedClip) return;
        if (!vodCtx?.credentials) {
            setSubtitleError('未配置 VOD 凭据，无法进行语音识别');
            return;
        }
        // 需要 FileId —— 从 clip 的 srcUrl 或 fileId 字段获取
        const fileId = selectedClip.fileId || selectedClip.vodFileId;
        if (!fileId) {
            setSubtitleError('当前片段无 FileId，请先将视频上传至 VOD');
            return;
        }
        setSubtitleLoading(true);
        setSubtitleError('');
        setSubtitleUrl('');
        setSubtitleProgress('提交识别任务…');
        try {
            const result = await runAsrFullTextPipeline(fileId, subtitleLang, vodCtx, {
                onProgress: (attempt, status) => {
                    setSubtitleProgress(`识别中… (${status || '轮询'} #${attempt + 1})`);
                }
            });
            setSubtitleUrl(result.subtitleUrl);
            setSubtitleProgress('识别完成');
        } catch (err) {
            setSubtitleError(err?.message || String(err));
            setSubtitleProgress('');
        } finally {
            setSubtitleLoading(false);
        }
    }, [selectedClip, vodCtx, subtitleLang]);

    // 把当前预览时间设为 in / out
    const setInFromPreview = () => {
        if (!selectedClip) return;
        const v = previewRef.current;
        const tt = v ? v.currentTime : previewTime;
        const out = selectedClip.out > 0 ? selectedClip.out : selectedClip.duration;
        updateClip(selectedClip.id, { in: Math.min(tt, Math.max(0, out - 0.1)) });
    };
    const setOutFromPreview = () => {
        if (!selectedClip) return;
        const v = previewRef.current;
        const tt = v ? v.currentTime : previewTime;
        updateClip(selectedClip.id, { out: Math.max(tt, (selectedClip.in || 0) + 0.1) });
    };

    // ---- 估算成片总时长 ----
    const totalDuration = useMemo(() => {
        let total = 0;
        clips.forEach((c, i) => {
            const out = c.out > 0 ? c.out : (c.duration || 0);
            const dur = Math.max(0, out - (c.in || 0));
            total += dur;
            if (i > 0 && c.transition && c.transition !== 'none') {
                total -= Math.max(0, c.transitionDuration || 0.5);
            }
        });
        return total;
    }, [clips]);

    // ---- 上传配乐 ----
    const handleBgmFile = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        setBgm({ name: file.name, url, file, volume: 1 });
    };

    // ---- 触发云端合成 ----
    const handleCompose = async () => {
        setErrorText('');
        if (!clips.length) { setErrorText('没有可合成的片段'); return; }
        if (typeof onCompose !== 'function') { setErrorText('未提供合成入口'); return; }
        setComposing(true);
        setProgress(0);
        setStageText('准备中…');
        setResultUrl('');

        const plan = {
            // Canvas.Color 在部分 VOD 环境会拒绝默认黑色值；仅传尺寸，背景使用服务端默认值。
            canvas: { width: aspectPreset.width, height: aspectPreset.height },
            clips: clips.map((c) => ({
                src: c.srcUrl,
                in: c.in || 0,
                out: c.out > 0 ? c.out : (c.duration || 0),
                duration: c.duration || 0,
                transition: c.transition,
                transitionDuration: c.transitionDuration,
                caption: (c.caption && c.caption.text.trim())
                    ? { text: c.caption.text, fontSize: c.caption.fontSize || 0, color: c.caption.color, bottomPercent: c.caption.bottomPercent }
                    : null,
                mute: !!bgm ? false : c.mute
            })),
            bgm: bgm ? { src: bgm.file || bgm.url, volume: bgm.volume } : null,
            output: { fileName: outputName || 'merged-video', container: 'mp4' }
        };

        const onStage = (stage, info = {}) => {
            const map = {
                upload_start: ['上传素材', 15, info],
                upload_done: ['上传素材', 30, info],
                compose_build: ['构建编辑指令', 35, info],
                create_task: ['提交合成任务', 40, info],
                task_created: ['合成中', 45, info],
                polling: ['云端渲染中', Math.min(92, 45 + (info.attempt || 0) * 2), info],
                task_finish: ['合成完成', 100, info]
            };
            const m = map[stage];
            if (m) {
                let label = m[0];
                if (stage.startsWith('upload') && info.total) {
                    label = `上传素材 ${Math.min((info.index || 0) + 1, info.total)}/${info.total}`;
                    const ratio = ((info.index || 0) + 1) / info.total;
                    setProgress(15 + Math.round(ratio * 18));
                } else {
                    setProgress(m[1]);
                }
                setStageText(label);
            }
        };

        try {
            const res = await onCompose(plan, { onStage });
            const url = res?.url || (Array.isArray(res?.urls) ? res.urls[0] : '');
            if (!url) throw new Error('未返回成片地址');
            setProgress(100);
            setStageText('合成完成');
            setResultUrl(url);
        } catch (err) {
            setErrorText(err?.message || String(err));
        } finally {
            setComposing(false);
        }
    };

    if (!open) return null;

    const transitionOptions = VOD_TRANSITION_TYPES;

    return createPortal(
        <div className={`fixed inset-0 z-[10000] flex items-center justify-center ${ui.overlay}`} onMouseDown={onClose}>
            <div
                className={`relative flex flex-col w-[94vw] h-[92vh] max-w-[1400px] rounded-xl shadow-2xl border overflow-hidden ${ui.panel}`}
                onMouseDown={(e) => e.stopPropagation()}
            >
                {/* 顶栏 */}
                <div className={`flex items-center justify-between px-4 py-2.5 border-b ${ui.sub}`}>
                    <div className="flex items-center gap-2">
                        <Film size={16} className="text-blue-500" />
                        <span className="text-sm font-semibold">{t('视频合并 · 在线编辑')}</span>
                        <span className={`text-[11px] ${ui.mutedText}`}>
                            {clips.length} {t('个片段')} · {t('预计时长')} {fmtTime(totalDuration)}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        {/* 画布比例 */}
                        <div className="relative">
                            <select
                                value={aspect}
                                onChange={(e) => setAspect(e.target.value)}
                                className={`text-xs rounded border px-2 py-1 outline-none appearance-none pr-6 ${ui.input}`}
                            >
                                {ASPECT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                            </select>
                            <ChevronDown size={12} className={`absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none ${ui.mutedText}`} />
                        </div>
                        <button onClick={onClose} className={`p-1.5 rounded ${ui.btn}`} title={t('关闭')}>
                            <X size={16} />
                        </button>
                    </div>
                </div>

                {/* 主体：预览 + 属性 */}
                <div className="flex flex-1 min-h-0">
                    {/* 预览区 */}
                    <div className="flex-1 min-w-0 flex flex-col">
                        <div className="flex-1 min-h-0 flex items-center justify-center bg-black/90 p-4">
                            {resultUrl ? (
                                <video src={resultUrl} controls className="max-w-full max-h-full rounded" />
                            ) : selectedClip ? (
                                <video
                                    ref={previewRef}
                                    src={selectedClip.srcUrl}
                                    className="max-w-full max-h-full rounded"
                                    playsInline
                                    crossOrigin="anonymous"
                                    onLoadedMetadata={(e) => onMetaLoaded(selectedClip.id, e.currentTarget.duration)}
                                    onPlay={() => setIsPlaying(true)}
                                    onPause={() => setIsPlaying(false)}
                                >
                                    {/* 智能字幕 VTT track */}
                                    {subtitleEnabled && subtitleUrl && (
                                        <track
                                            kind="subtitles"
                                            src={subtitleUrl}
                                            srcLang={ASR_FULLTEXT_TEMPLATES.find(t => t.id === subtitleLang)?.lang || 'zh'}
                                            label={ASR_FULLTEXT_TEMPLATES.find(t => t.id === subtitleLang)?.label || '中文'}
                                            default
                                        />
                                    )}
                                </video>
                            ) : (
                                <div className="text-zinc-500 text-sm">{t('没有片段可预览')}</div>
                            )}
                        </div>
                        {/* 预览控制条 */}
                        {!resultUrl && selectedClip && (
                            <div className={`flex items-center gap-3 px-4 py-2 border-t ${ui.sub}`}>
                                <button onClick={togglePlay} className={`p-1.5 rounded ${ui.btn}`}>
                                    {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                                </button>
                                <span className={`text-[11px] tabular-nums ${ui.mutedText}`}>
                                    {fmtTime(previewTime)} / {fmtTime(selectedClip.duration)}
                                </span>
                                <input
                                    type="range"
                                    min={0}
                                    max={selectedClip.duration || 0}
                                    step={0.05}
                                    value={previewTime}
                                    onChange={(e) => {
                                        const v = previewRef.current;
                                        if (v) v.currentTime = Number(e.target.value);
                                        setPreviewTime(Number(e.target.value));
                                    }}
                                    className="flex-1 accent-blue-500"
                                />
                                <button onClick={setInFromPreview} className={`text-[11px] px-2 py-1 rounded ${ui.btn}`} title={t('设为入点')}>
                                    {t('设入点')}
                                </button>
                                <button onClick={setOutFromPreview} className={`text-[11px] px-2 py-1 rounded ${ui.btn}`} title={t('设为出点')}>
                                    {t('设出点')}
                                </button>
                            </div>
                        )}
                    </div>

                    {/* 右侧属性面板 */}
                    <div className={`w-72 shrink-0 border-l overflow-y-auto ${ui.sub}`}>
                        {selectedClip && !resultUrl ? (
                            <div className="p-3 space-y-4">
                                <div className="text-xs font-semibold flex items-center gap-1.5">
                                    <Scissors size={13} /> {t('裁剪')}
                                </div>
                                <div className="space-y-2">
                                    <label className={`text-[11px] ${ui.mutedText}`}>{t('入点')} (s)</label>
                                    <input
                                        type="number" min={0} max={selectedClip.duration} step={0.1}
                                        value={Number((selectedClip.in || 0).toFixed(2))}
                                        onChange={(e) => updateClip(selectedClip.id, { in: Math.max(0, Number(e.target.value)) })}
                                        className={`w-full text-xs rounded border px-2 py-1 outline-none ${ui.input}`}
                                    />
                                    <label className={`text-[11px] ${ui.mutedText}`}>{t('出点')} (s)</label>
                                    <input
                                        type="number" min={0} max={selectedClip.duration} step={0.1}
                                        value={Number(((selectedClip.out > 0 ? selectedClip.out : selectedClip.duration) || 0).toFixed(2))}
                                        onChange={(e) => updateClip(selectedClip.id, { out: Number(e.target.value) })}
                                        className={`w-full text-xs rounded border px-2 py-1 outline-none ${ui.input}`}
                                    />
                                </div>

                                {/* 转场（与上一片段之间） */}
                                {clips.findIndex((c) => c.id === selectedClip.id) > 0 && (
                                    <div className="space-y-2">
                                        <div className="text-xs font-semibold flex items-center gap-1.5">
                                            <Wand2 size={13} /> {t('转场')}（{t('与上一片段')}）
                                        </div>
                                        <select
                                            value={selectedClip.transition}
                                            onChange={(e) => updateClip(selectedClip.id, { transition: e.target.value })}
                                            className={`w-full text-xs rounded border px-2 py-1 outline-none ${ui.input}`}
                                        >
                                            {transitionOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                                        </select>
                                        {selectedClip.transition !== 'none' && (
                                            <>
                                                <label className={`text-[11px] ${ui.mutedText}`}>{t('转场时长')} (s)</label>
                                                <input
                                                    type="number" min={0.1} max={3} step={0.1}
                                                    value={selectedClip.transitionDuration}
                                                    onChange={(e) => updateClip(selectedClip.id, { transitionDuration: Number(e.target.value) })}
                                                    className={`w-full text-xs rounded border px-2 py-1 outline-none ${ui.input}`}
                                                />
                                            </>
                                        )}
                                    </div>
                                )}

                                {/* 字幕 */}
                                <div className="space-y-2">
                                    <div className="text-xs font-semibold flex items-center gap-1.5">
                                        <TypeIcon size={13} /> {t('字幕')}
                                    </div>
                                    <textarea
                                        rows={2}
                                        value={selectedClip.caption?.text || ''}
                                        onChange={(e) => updateClipCaption(selectedClip.id, { text: e.target.value })}
                                        placeholder={t('该片段的字幕文字')}
                                        className={`w-full text-xs rounded border px-2 py-1 outline-none resize-none ${ui.input}`}
                                    />
                                    <div className="flex items-center gap-1.5">
                                        {CAPTION_COLORS.map((c) => (
                                            <button
                                                key={c}
                                                onClick={() => updateClipCaption(selectedClip.id, { color: c })}
                                                className={`w-5 h-5 rounded-full border ${selectedClip.caption?.color === c ? 'ring-2 ring-blue-500' : 'border-zinc-400'}`}
                                                style={{ backgroundColor: c }}
                                                title={c}
                                            />
                                        ))}
                                    </div>
                                </div>

                                {/* 智能字幕（语音全文识别）*/}
                                <div className="space-y-2">
                                    <div className="text-xs font-semibold flex items-center gap-1.5">
                                        <Subtitles size={13} /> {t('智能字幕')}
                                    </div>
                                    {/* 启用/关闭开关 */}
                                    <div className="flex items-center justify-between">
                                        <span className={`text-[11px] ${ui.mutedText}`}>{t('语音全文识别')}</span>
                                        <button
                                            onClick={() => {
                                                setSubtitleEnabled(!subtitleEnabled);
                                                if (subtitleEnabled) {
                                                    setSubtitleUrl('');
                                                    setSubtitleError('');
                                                    setSubtitleProgress('');
                                                }
                                            }}
                                            className="flex items-center"
                                            title={subtitleEnabled ? t('关闭字幕') : t('启用字幕')}
                                        >
                                            {subtitleEnabled
                                                ? <ToggleRight size={22} className="text-blue-500" />
                                                : <ToggleLeft size={22} className={ui.mutedText} />
                                            }
                                        </button>
                                    </div>

                                    {subtitleEnabled && (
                                        <>
                                            {/* 语言选择 */}
                                            <div className="flex items-center gap-2">
                                                <span className={`text-[11px] shrink-0 ${ui.mutedText}`}>{t('识别语言')}</span>
                                                <select
                                                    value={subtitleLang}
                                                    onChange={(e) => setSubtitleLang(Number(e.target.value))}
                                                    className={`flex-1 text-xs rounded border px-2 py-1 outline-none ${ui.input}`}
                                                >
                                                    {ASR_FULLTEXT_TEMPLATES.map((tpl) => (
                                                        <option key={tpl.id} value={tpl.id}>{tpl.label}</option>
                                                    ))}
                                                </select>
                                            </div>

                                            {/* 发起识别按钮 */}
                                            <button
                                                onClick={handleSubtitleRecognize}
                                                disabled={subtitleLoading}
                                                className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium"
                                            >
                                                {subtitleLoading
                                                    ? <><Loader2 size={12} className="animate-spin" /> {t('识别中…')}</>
                                                    : <><Subtitles size={12} /> {t('开始识别字幕')}</>
                                                }
                                            </button>

                                            {/* 进度/状态 */}
                                            {subtitleProgress && (
                                                <div className={`text-[11px] ${ui.mutedText}`}>{subtitleProgress}</div>
                                            )}
                                            {subtitleError && (
                                                <div className="text-[11px] text-red-500">{subtitleError}</div>
                                            )}
                                            {subtitleUrl && (
                                                <div className="text-[11px] text-green-500 break-all">
                                                    ✅ {t('字幕已加载')}
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className={`p-4 text-xs ${ui.mutedText}`}>
                                {resultUrl ? t('成片已生成，可在左侧预览并下载') : t('选择一个片段进行编辑')}
                            </div>
                        )}
                    </div>
                </div>

                {/* 时间轴轨道 */}
                <div className={`border-t ${ui.sub} px-3 py-2`}>
                    <div className="flex items-center gap-2 overflow-x-auto pb-1">
                        {clips.map((c, i) => {
                            const isSel = c.id === selectedId;
                            const out = c.out > 0 ? c.out : c.duration;
                            const clipDur = Math.max(0, (out || 0) - (c.in || 0));
                            return (
                                <React.Fragment key={c.id}>
                                    {i > 0 && c.transition !== 'none' && (
                                        <div className="shrink-0 flex flex-col items-center justify-center text-[9px] text-blue-400 px-0.5" title={t('转场')}>
                                            <Wand2 size={12} />
                                        </div>
                                    )}
                                    <div
                                        draggable
                                        onDragStart={() => handleDragStart(i)}
                                        onDragOver={(e) => handleDragOver(e, i)}
                                        onDrop={() => handleDrop(i)}
                                        onClick={() => setSelectedId(c.id)}
                                        className={`group relative shrink-0 w-28 rounded-lg border cursor-pointer overflow-hidden transition-all ${ui.card} ${isSel ? ui.cardActive : ''} ${dragOverIndex === i ? 'opacity-60' : ''}`}
                                    >
                                        <div className="relative h-16 bg-black/80 flex items-center justify-center">
                                            <video
                                                src={c.srcUrl}
                                                muted
                                                preload="metadata"
                                                className="w-full h-full object-cover"
                                                onLoadedMetadata={(e) => {
                                                    onMetaLoaded(c.id, e.currentTarget.duration);
                                                    try { e.currentTarget.currentTime = Math.min(c.in || 0.1, e.currentTarget.duration - 0.05); } catch (_) {}
                                                }}
                                            />
                                            <div className="absolute top-0.5 left-0.5 text-[9px] bg-black/60 text-white px-1 rounded flex items-center gap-0.5">
                                                <GripVertical size={9} /> {i + 1}
                                            </div>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); removeClip(c.id); }}
                                                className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                                                title={t('删除片段')}
                                            >
                                                <Trash2 size={10} />
                                            </button>
                                            {c.caption?.text?.trim() && (
                                                <div className="absolute bottom-0.5 left-0.5 right-0.5 text-[8px] text-white text-center truncate px-0.5">
                                                    {c.caption.text}
                                                </div>
                                            )}
                                        </div>
                                        <div className={`px-1.5 py-1 text-[9px] tabular-nums ${ui.mutedText}`}>
                                            {fmtTime(clipDur)}
                                        </div>
                                    </div>
                                </React.Fragment>
                            );
                        })}
                        {!clips.length && (
                            <div className={`text-xs py-6 px-2 ${ui.mutedText}`}>{t('暂无片段')}</div>
                        )}
                    </div>
                </div>

                {/* 底栏：配乐 + 输出 + 合成 */}
                <div className={`flex items-center gap-3 px-4 py-2.5 border-t ${ui.sub}`}>
                    {/* 配乐 */}
                    <div className="flex items-center gap-1.5">
                        <button
                            onClick={() => bgmInputRef.current?.click()}
                            className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded ${ui.btn}`}
                        >
                            <Music size={13} /> {bgm ? t('更换配乐') : t('添加配乐')}
                        </button>
                        <input ref={bgmInputRef} type="file" accept="audio/*" className="hidden" onChange={handleBgmFile} />
                        {bgm && (
                            <>
                                <span className={`text-[11px] max-w-[120px] truncate ${ui.mutedText}`} title={bgm.name}>{bgm.name}</span>
                                <input
                                    type="range" min={0} max={2} step={0.1} value={bgm.volume}
                                    onChange={(e) => setBgm((b) => ({ ...b, volume: Number(e.target.value) }))}
                                    className="w-16 accent-blue-500"
                                    title={`${t('音量')} ${Math.round(bgm.volume * 100)}%`}
                                />
                                <button onClick={() => setBgm(null)} className={`p-1 rounded ${ui.btn}`} title={t('移除配乐')}>
                                    <Trash2 size={12} />
                                </button>
                            </>
                        )}
                    </div>

                    <div className="flex-1" />

                    {/* 进度 / 错误 */}
                    {composing && (
                        <div className="flex items-center gap-2 min-w-[200px]">
                            <div className={`flex-1 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
                                <div className="h-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
                            </div>
                            <span className={`text-[11px] whitespace-nowrap ${ui.mutedText}`}>{stageText} {progress}%</span>
                        </div>
                    )}
                    {errorText && !composing && (
                        <span className="text-[11px] text-red-500 max-w-[280px] truncate" title={errorText}>{errorText}</span>
                    )}

                    {/* 输出文件名 */}
                    {!resultUrl && (
                        <input
                            type="text"
                            value={outputName}
                            onChange={(e) => setOutputName(e.target.value)}
                            placeholder={t('输出文件名')}
                            className={`text-xs rounded border px-2 py-1.5 w-36 outline-none ${ui.input}`}
                        />
                    )}

                    {resultUrl ? (
                        <a
                            href={resultUrl}
                            download={`${outputName || 'merged-video'}.mp4`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-green-600 hover:bg-green-700 text-white font-medium"
                        >
                            <Download size={14} /> {t('下载成片')}
                        </a>
                    ) : (
                        <button
                            onClick={handleCompose}
                            disabled={composing || !clips.length}
                            className="flex items-center gap-1.5 text-xs px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium"
                        >
                            {composing ? <Loader2 size={14} className="animate-spin" /> : <Film size={14} />}
                            {composing ? t('合成中…') : t('一键合成成片')}
                        </button>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}
