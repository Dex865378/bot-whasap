'use strict';

require('dotenv').config();
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createClient } = require('@libsql/client');
const WebSocket = require('ws');

const { resolverFfmpeg, procesarStickerCompleto } = require('./utils/stickerProcessor');
const { deriveWorkerSecret, signAuth, encodeFrame, decodeFrame } = require('./utils/stickerPool');

const execFileAsync = promisify(execFile);

const DEFAULT_CONCURRENCY = Math.min(6, Math.max(2, os.cpus().length - 2));
const CONCURRENCY = Math.max(1, parseInt(process.env.WORKER_CONCURRENCY || String(DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY);
const WORKER_NAME = process.env.WORKER_NAME || os.hostname();

async function descubrirRenderUrl() {
    const manual = process.env.WORKER_RENDER_URL || process.env.RENDER_EXTERNAL_URL;
    if (manual) return manual.trim().replace(/\/+$/, '');

    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) return null;

    try {
        // Consulta directa sin DDL/migraciones para conectar en <1s
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

async function main() {
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

    async function conectar() {
        const renderHttp = await descubrirRenderUrl();
        if (!renderHttp) {
            console.log(`⏳ [WORKER-PC] Esperando que Render publique su URL en Turso (reintento en ${Math.round(backoffMs / 1000)}s)...`);
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

        let vivoTimer = null;

        ws.on('open', () => {
            backoffMs = 1000;
            console.log(`✅ [WORKER-PC] Conectado a Render (${renderHttp}). Listo para acelerar !s.`);
            ws.send(JSON.stringify({ type: 'hello', name: WORKER_NAME, concurrency: CONCURRENCY }));
            // Ping cliente cada 25s por si algún proxy intermedio corta idle
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
            if (meta.type !== 'job' || !meta.id) return;

            const inicio = Date.now();
            activos++;
            try {
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
                    imgThreads: 2
                });

                if (!res || !res.stiker || !res.stiker.length) {
                    const fail = encodeFrame({ type: 'result', id: meta.id, ok: false, error: 'Conversion vacia' }, []);
                    if (ws.readyState === 1) ws.send(fail, { binary: true });
                    return;
                }

                const audioSegundos = res.audio ? Number(res.audio.segundos) || 0 : 0;
                const waveformBuf = res.audio?.waveform || Buffer.alloc(0);
                const audioOggBuf = res.audio?.buffer || Buffer.alloc(0);
                const resp = encodeFrame(
                    { type: 'result', id: meta.id, ok: true, audioSegundos },
                    [res.stiker, waveformBuf, audioOggBuf]
                );
                if (ws.readyState === 1) ws.send(resp, { binary: true });
                console.log(`⚡ [WORKER-PC] Sticker ${meta.id} (${meta.esVideo ? 'video' : 'img'}${audioOggBuf.length ? '+audio' : ''}) listo en ${Date.now() - inicio}ms (activos=${activos})`);
            } catch (e) {
                const fail = encodeFrame({ type: 'result', id: meta.id, ok: false, error: e.message }, []);
                if (ws.readyState === 1) ws.send(fail, { binary: true });
                console.warn(`⚠️ [WORKER-PC] Error en job ${meta.id}:`, e.message);
            } finally {
                activos = Math.max(0, activos - 1);
            }
        });

        const reconectar = (motivo) => {
            if (vivoTimer) { clearInterval(vivoTimer); vivoTimer = null; }
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

module.exports = { descubrirRenderUrl, toWsUrl };
