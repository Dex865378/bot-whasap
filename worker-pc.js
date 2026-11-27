'use strict';

require('dotenv').config();
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createClient } = require('@libsql/client');
const WebSocket = require('ws');
const { proto, downloadMediaMessage, getWAUploadToServer } = require('@whiskeysockets/baileys');

const { resolverFfmpeg, procesarStickerCompleto, limpiarTemporalesStickers } = require('./utils/stickerProcessor');
const { deriveWorkerSecret, signAuth, encodeFrame, decodeFrame } = require('./utils/stickerPool');
const { subirYArmarSticker, parchearProtoSonido } = require('./utils/stickerSonido');

const execFileAsync = promisify(execFile);

const DEFAULT_CONCURRENCY = Math.min(8, Math.max(4, os.cpus().length));
const CONCURRENCY = Math.max(1, parseInt(process.env.WORKER_CONCURRENCY || String(DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY);
const WORKER_NAME = process.env.WORKER_NAME || os.hostname();
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20000;

function descargarConTimeout(target, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
    let timer;
    return Promise.race([
        downloadMediaMessage(target, 'buffer', {}),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('download timeout')), timeoutMs);
        })
    ]).finally(() => clearTimeout(timer));
}

async function descubrirRenderUrl() {
    const manual = process.env.WORKER_RENDER_URL || process.env.RENDER_EXTERNAL_URL;
    if (manual) return manual.trim().replace(/\/+$/, '');

    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) return null;

    try {
        const client = createClient({ url, authToken: token });
        const rs = await client.execute({
            sql: "SELECT public_url FROM bot_instancias WHERE public_url IS NOT NULL AND public_url != '' AND last_seen > ? ORDER BY conectado DESC, last_seen DESC LIMIT 1",
            args: [Date.now() - 300000]
        });
        const encontrado = rs.rows?.[0]?.public_url
            || (await client.execute("SELECT public_url FROM bot_instancias WHERE public_url IS NOT NULL AND public_url != '' ORDER BY last_seen DESC LIMIT 1")).rows?.[0]?.public_url;
        if (encontrado) return String(encontrado).trim().replace(/\/+$/, '');
    } catch (e) {
        console.warn('[WORKER-PC] Error consultando Turso:', e.message);
    }
    return null;
}

function toWsUrl(httpUrl, ts, sig) {
    const u = new URL(httpUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws/worker';
    u.search = '';
    u.searchParams.set('ts', String(ts));
    u.searchParams.set('sig', sig);
    u.searchParams.set('name', WORKER_NAME);
    u.searchParams.set('concurrency', String(CONCURRENCY));
    return u.toString();
}

async function procesarJobRemoto(meta, buffers, ffmpegPath) {
    parchearProtoSonido();
    const mediaMsg = proto.Message.decode(Buffer.from(buffers[0]));
    const downloadMedia = descargarConTimeout({ key: {}, message: mediaMsg });
    const downloadAudio = (meta.hasAudioProto && buffers[1] && buffers[1].length)
        ? descargarConTimeout({ key: {}, message: proto.Message.decode(Buffer.from(buffers[1])) }).catch(() => null)
        : Promise.resolve(null);

    let buffer, audioBuf;
    try {
        [buffer, audioBuf] = await Promise.all([downloadMedia, downloadAudio]);
    } catch (e) {
        const msg = String(e?.message || '');
        if (msg.includes('404') || msg.includes('410')) {
            return encodeFrame({ type: 'result', id: meta.id, ok: false, fatalReason: 'downloadError', error: msg }, []);
        }
        return encodeFrame({ type: 'result', id: meta.id, ok: false, error: msg }, []);
    }

    if (!buffer || !buffer.length) {
        return encodeFrame({ type: 'result', id: meta.id, ok: false, fatalReason: 'empty', error: 'Media vacia' }, []);
    }
    if (buffer.length > MAX_MEDIA_BYTES) {
        return encodeFrame({ type: 'result', id: meta.id, ok: false, fatalReason: 'tooLarge', error: 'Mayor a 15MB' }, []);
    }

    const audioFinal = (audioBuf && audioBuf.length && audioBuf.length <= MAX_MEDIA_BYTES) ? audioBuf : null;
    const res = await procesarStickerCompleto({
        buffer,
        esVideo: !!meta.esVideo,
        necesitaAudio: !!meta.necesitaAudio,
        audioBuffer: audioFinal,
        ffmpegPath,
        parallelAudio: true,
        videoThreads: 2,
        imgThreads: 2,
        calidad: process.env.STICKER_CALIDAD || null,
        segundos: Number(meta.segundos) || 0
    });

    if (!res || !res.stiker || !res.stiker.length) {
        return encodeFrame({ type: 'result', id: meta.id, ok: false, error: 'Conversion vacia' }, []);
    }

    // Si Render entregó mediaConn, cifrar y subir directo desde la PC a mmg.whatsapp.net
    let needRefreshConn = false;
    if (meta.mediaConn?.auth && Array.isArray(meta.mediaConn.hosts) && meta.mediaConn.hosts.length) {
        try {
            const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} };
            const uploadFn = getWAUploadToServer(
                { customUploadHosts: [], logger: noopLogger, options: {} },
                () => Promise.resolve(meta.mediaConn)
            );
            const stickerMsg = await subirYArmarSticker({
                sticker: res.stiker,
                audio: res.audio,
                upload: uploadFn,
                logger: noopLogger,
                mediaUploadTimeoutMs: 25000,
                parallelUpload: true
            });
            if (stickerMsg) {
                const encoded = Buffer.from(proto.Message.StickerMessage.encode(stickerMsg).finish());
                return encodeFrame(
                    { type: 'result', id: meta.id, ok: true, preuploaded: true },
                    [encoded]
                );
            }
        } catch (eUp) {
            needRefreshConn = true;
            console.warn(`⚠️ [WORKER-PC] Subida directa falló (${eUp.message}); devolviendo buffers a Render.`);
        }
    }

    const audioSegundos = res.audio ? Number(res.audio.segundos) || 0 : 0;
    const waveformBuf = res.audio?.waveform || Buffer.alloc(0);
    const audioOggBuf = res.audio?.buffer || Buffer.alloc(0);
    return encodeFrame(
        { type: 'result', id: meta.id, ok: true, preuploaded: false, needRefreshConn, audioSegundos },
        [res.stiker, waveformBuf, audioOggBuf]
    );
}

async function main() {
    process.on('uncaughtException', (err) => {
        console.error('❌ [WORKER-PC] uncaughtException:', err?.message || err);
    });
    process.on('unhandledRejection', (err) => {
        console.error('❌ [WORKER-PC] unhandledRejection:', err?.message || err);
    });

    const ffmpegPath = resolverFfmpeg();
    try {
        const { stdout } = await execFileAsync(ffmpegPath, ['-version'], { timeout: 5000, windowsHide: true });
        const primeraLinea = (stdout || '').split('\n')[0].trim();
        console.log(`🎬 [WORKER-PC] FFmpeg listo: ${ffmpegPath} (${primeraLinea})`);
    } catch (e) {
        console.error(`❌ [WORKER-PC] No se encontró ffmpeg ejecutable (${ffmpegPath}):`, e.message);
        process.exit(1);
    }

    const secret = deriveWorkerSecret();
    console.log(`🖥️ [WORKER-PC] Nodo "${WORKER_NAME}" | ${os.cpus().length} hilos | Concurrencia stickers=${CONCURRENCY}`);

    let backoffMs = 1000;
    let activos = 0;
    let currentWs = null;
    let shuttingDown = false;

    const shutdown = (sig) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`🛑 [WORKER-PC] Apagando (${sig}), Render retomará los stickers al instante.`);
        if (currentWs && currentWs.readyState === 1) {
            try { currentWs.close(1000, 'worker-shutdown'); } catch (_) { }
        }
        setTimeout(() => process.exit(0), 250);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    async function conectar() {
        if (shuttingDown) return;
        const renderHttp = await descubrirRenderUrl();
        if (!renderHttp) {
            console.log(`⏳ [WORKER-PC] Esperando URL de Render en Turso (reintento en ${Math.round(backoffMs / 1000)}s)...`);
            setTimeout(conectar, backoffMs);
            backoffMs = Math.min(15000, backoffMs * 2);
            return;
        }

        const ts = Date.now();
        const sig = signAuth(secret, ts);
        const wsUrl = toWsUrl(renderHttp, ts, sig);
        console.log(`🔌 [WORKER-PC] Conectando a ${renderHttp}/ws/worker ...`);

        const ws = new WebSocket(wsUrl, {
            maxPayload: 35 * 1024 * 1024,
            handshakeTimeout: 15000
        });
        currentWs = ws;

        let vivoTimer = null;
        let reconectado = false;

        ws.on('open', () => {
            backoffMs = 1000;
            console.log(`✅ [WORKER-PC] Conectado a Render (${renderHttp}). PC procesará descargas, conversión y subida de !s.`);
            ws.send(JSON.stringify({ type: 'hello', name: WORKER_NAME, concurrency: CONCURRENCY }));
            vivoTimer = setInterval(() => {
                if (ws.readyState === 1) {
                    try { ws.ping(); } catch (_) { }
                }
            }, 25000);
        });

        ws.on('message', async (data, isBinary) => {
            if (!isBinary) return;
            let meta, buffers;
            try {
                ({ meta, buffers } = decodeFrame(data));
            } catch (e) {
                console.warn('[WORKER-PC] Frame inválido:', e.message);
                return;
            }
            if (!meta.id || (meta.type !== 'job' && meta.type !== 'job_remote')) return;

            const inicio = Date.now();
            activos++;
            try {
                let resp;
                if (meta.type === 'job_remote') {
                    resp = await procesarJobRemoto(meta, buffers, ffmpegPath);
                } else {
                    const mediaBuf = Buffer.from(buffers[0] || []);
                    const audioBuf = buffers[1] && buffers[1].length ? Buffer.from(buffers[1]) : null;
                    const res = await procesarStickerCompleto({
                        buffer: mediaBuf,
                        esVideo: !!meta.esVideo,
                        necesitaAudio: !!meta.necesitaAudio,
                        audioBuffer: audioBuf,
                        ffmpegPath,
                        parallelAudio: true,
                        videoThreads: 2,
                        imgThreads: 2,
                        calidad: process.env.STICKER_CALIDAD || null,
                        segundos: Number(meta.segundos) || 0
                    });
                    if (!res || !res.stiker || !res.stiker.length) {
                        resp = encodeFrame({ type: 'result', id: meta.id, ok: false, error: 'Conversion vacia' }, []);
                    } else {
                        const audioSegundos = res.audio ? Number(res.audio.segundos) || 0 : 0;
                        resp = encodeFrame(
                            { type: 'result', id: meta.id, ok: true, preuploaded: false, audioSegundos },
                            [res.stiker, res.audio?.waveform || Buffer.alloc(0), res.audio?.buffer || Buffer.alloc(0)]
                        );
                    }
                }
                if (ws.readyState === 1) ws.send(resp, { binary: true });
                const decMeta = decodeFrame(resp).meta;
                const modo = decMeta.preuploaded ? 'full-PC' : 'conv-PC';
                if (decMeta.ok) {
                    console.log(`⚡ [WORKER-PC] Sticker ${meta.id} (${meta.esVideo ? 'video' : 'img'}, ${modo}) listo en ${Date.now() - inicio}ms (activos=${activos})`);
                }
            } catch (e) {
                const fail = encodeFrame({ type: 'result', id: meta.id, ok: false, error: e.message }, []);
                if (ws.readyState === 1) ws.send(fail, { binary: true });
                console.warn(`⚠️ [WORKER-PC] Error en job ${meta.id}:`, e.message);
            } finally {
                activos = Math.max(0, activos - 1);
                limpiarTemporalesStickers(120000).catch(() => { });
            }
        });

        const reconectar = (motivo) => {
            if (reconectado) return;
            reconectado = true;
            if (currentWs === ws) currentWs = null;
            if (vivoTimer) { clearInterval(vivoTimer); vivoTimer = null; }
            if (shuttingDown) return;
            console.log(`🔄 [WORKER-PC] Desconectado (${motivo}). Reintentando en ${Math.round(backoffMs / 1000)}s...`);
            setTimeout(conectar, backoffMs);
            backoffMs = Math.min(15000, backoffMs * 2);
        };

        ws.on('close', (code) => reconectar(`code=${code}`));
        ws.on('error', (err) => {
            console.warn('[WORKER-PC] Error socket:', err.message);
            try { ws.terminate(); } catch (_) { }
        });
    }

    conectar();
}

if (require.main === module) {
    main();
}

module.exports = { descubrirRenderUrl, toWsUrl, procesarJobRemoto };
