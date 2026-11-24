'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const EMPTY_BUF = Buffer.alloc(0);

function deriveWorkerSecret() {
    if (process.env.WORKER_SECRET) return String(process.env.WORKER_SECRET);
    const base = process.env.TURSO_AUTH_TOKEN || process.env.NUMERO_ADMIN || 'diky-local-dev';
    return crypto.createHmac('sha256', 'diky-sticker-worker-v1').update(String(base)).digest('hex');
}

function signAuth(secret, ts) {
    return crypto.createHmac('sha256', String(secret)).update(String(ts)).digest('hex');
}

function verifyAuth(secret, ts, sig, now = Date.now(), maxSkewMs = 120000) {
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || !sig) return false;
    if (Math.abs(now - tsNum) > maxSkewMs) return false;
    const expected = signAuth(secret, tsNum);
    const a = Buffer.from(String(sig), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function encodeFrame(meta, buffers = []) {
    const clean = buffers.map(b => (Buffer.isBuffer(b) ? b : EMPTY_BUF));
    const header = Buffer.from(JSON.stringify({ ...meta, lengths: clean.map(b => b.length) }), 'utf8');
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(header.length, 0);
    return Buffer.concat([lenBuf, header, ...clean]);
}

function decodeFrame(raw) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (buf.length < 4) throw new Error('Frame demasiado corto');
    const headerLen = buf.readUInt32BE(0);
    if (headerLen <= 0 || 4 + headerLen > buf.length) throw new Error('Header inválido en frame');
    const meta = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8'));
    const lengths = Array.isArray(meta.lengths) ? meta.lengths : [];
    const buffers = [];
    let off = 4 + headerLen;
    for (const l of lengths) {
        const len = Number(l) || 0;
        if (len < 0 || off + len > buf.length) throw new Error('Payload truncado en frame');
        buffers.push(buf.subarray(off, off + len));
        off += len;
    }
    return { meta, buffers };
}

class StickerPool {
    constructor(opts = {}) {
        this.maxLocal = Math.max(1, Number(opts.maxLocal) || 2);
        this.maxQueue = Math.max(10, Number(opts.maxQueue) || 200);
        this.workerJobTimeoutMs = Math.max(5000, Number(opts.workerJobTimeoutMs) || 45000);
        // Mientras haya PC conectada, Render NO procesa FFmpeg pesado (esperar 0.5s
        // a la PC es ~50x más rápido que 48s en Render). Puede desactivarse si se
        // quiere modo mixto estricto pasando pcOnlyWhenConnected: false.
        this.pcOnlyWhenConnected = opts.pcOnlyWhenConnected !== false;
        this.localRunner = opts.localRunner || null;
        this.getSecret = opts.getSecret || deriveWorkerSecret;
        this.logger = opts.logger || console;

        this.workers = new Map();
        this.localActive = 0;
        this.queue = [];
        this.localWaiters = [];

        this.stats = {
            donePcDirect: 0,
            donePc: 0,
            doneLocal: 0,
            fallbacks: 0,
            rejectedQueue: 0
        };

        this._jobSeq = 0;
        this._workerSeq = 0;
        this._wss = null;
        this._pingTimer = null;
        this._upgradeHandler = null;
        this._httpServer = null;
    }

    hasAlivePcWorker() {
        for (const w of this.workers.values()) {
            if (w.ws.readyState === 1) return true;
        }
        return false;
    }

    pickPcWorker() {
        let best = null;
        let bestRatio = Infinity;
        for (const w of this.workers.values()) {
            if (w.ws.readyState !== 1) continue;
            if (w.active >= w.concurrency) continue;
            const ratio = w.active / w.concurrency;
            if (ratio < bestRatio) {
                bestRatio = ratio;
                best = w;
            }
        }
        return best;
    }

    pickFreeTurn() {
        const pc = this.pickPcWorker();
        if (pc) {
            pc.active++;
            return { kind: 'pc', worker: pc, released: false };
        }
        // Si la PC está conectada y llena, esperar turno en PC antes de atascar Render
        if (this.pcOnlyWhenConnected && this.hasAlivePcWorker()) {
            return null;
        }
        if (this.localActive < this.maxLocal) {
            this.localActive++;
            return { kind: 'local', released: false };
        }
        return null;
    }

    acquireTurn() {
        const inmediato = this.pickFreeTurn();
        if (inmediato) return Promise.resolve(inmediato);
        if (this.queue.length >= this.maxQueue) {
            this.stats.rejectedQueue++;
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            this.queue.push(resolve);
        });
    }

    acquireLocalTurn() {
        if (this.localActive < this.maxLocal) {
            this.localActive++;
            return Promise.resolve({ kind: 'local', released: false });
        }
        return new Promise((resolve) => {
            this.localWaiters.push(resolve);
        });
    }

    releaseTurn(turn) {
        if (!turn || turn.released) return;
        turn.released = true;
        if (turn.kind === 'pc' && turn.worker) {
            turn.worker.active = Math.max(0, turn.worker.active - 1);
        } else if (turn.kind === 'local') {
            this.localActive = Math.max(0, this.localActive - 1);
            if (this.localWaiters.length > 0 && this.localActive < this.maxLocal) {
                this.localActive++;
                const nextLocal = this.localWaiters.shift();
                nextLocal({ kind: 'local', released: false });
                return;
            }
        }
        this.drainQueue();
    }

    drainQueue() {
        while (this.queue.length > 0) {
            const turn = this.pickFreeTurn();
            if (!turn) break;
            const waiter = this.queue.shift();
            waiter(turn);
        }
    }

    _dispatchPcFrame(worker, meta, buffers) {
        return new Promise((resolve, reject) => {
            if (!worker || worker.ws.readyState !== 1) {
                return reject(new Error('Worker PC desconectado'));
            }
            const id = `j_${++this._jobSeq}`;
            const payload = encodeFrame({ ...meta, id }, buffers);

            const timer = setTimeout(() => {
                worker.inflight.delete(id);
                reject(new Error(`Timeout worker PC (${this.workerJobTimeoutMs}ms)`));
            }, this.workerJobTimeoutMs);

            worker.inflight.set(id, {
                resolve: (res) => { clearTimeout(timer); resolve(res); },
                reject: (err) => { clearTimeout(timer); reject(err); }
            });

            worker.ws.send(payload, { binary: true }, (err) => {
                if (err && worker.inflight.has(id)) {
                    worker.inflight.delete(id);
                    clearTimeout(timer);
                    reject(err);
                }
            });
        });
    }

    async _runLocal({ buffer, esVideo, necesitaAudio, audioBuffer, fallbackConvertir, fallbackAudio }) {
        if (this.localRunner) {
            return await this.localRunner({ buffer, esVideo, necesitaAudio, audioBuffer });
        }
        const stiker = await fallbackConvertir(buffer, esVideo);
        if (!stiker) return { stiker: null, audio: null };
        let audio = null;
        if (necesitaAudio) {
            try {
                if (audioBuffer && audioBuffer.length && fallbackAudio) {
                    audio = await fallbackAudio(audioBuffer, 10);
                } else if (esVideo && fallbackAudio) {
                    audio = await fallbackAudio(buffer, 6);
                }
            } catch (_) { audio = null; }
        }
        return { stiker, audio };
    }

    async _descargarParaLocal({ descargarMedia, descargarAudioCitado, esVideo, necesitaAudio, maxBytes }) {
        let buffer;
        try {
            buffer = await descargarMedia();
        } catch (e) {
            return { downloadError: e };
        }
        if (!buffer || buffer.length === 0) return { empty: true };
        if (buffer.length > maxBytes) return { tooLarge: true };

        let audioBuffer = null;
        if (necesitaAudio && !esVideo && descargarAudioCitado) {
            try {
                const ab = await descargarAudioCitado();
                if (ab && ab.length && ab.length <= maxBytes) audioBuffer = ab;
            } catch (_) { }
        }
        return { buffer, audioBuffer };
    }

    async procesarSticker({
        descargarMedia,
        descargarAudioCitado = null,
        mediaProtoBytes = null,
        audioProtoBytes = null,
        getMediaConn = null,
        esVideo = false,
        necesitaAudio = false,
        fallbackConvertir,
        fallbackAudio,
        maxBytes = 15 * 1024 * 1024
    }) {
        let turn = await this.acquireTurn();
        if (!turn) return { overloaded: true, stiker: null, audio: null };

        let cachedLocalMedia = null;
        try {
            if (turn.kind === 'pc') {
                const canRemote = Buffer.isBuffer(mediaProtoBytes) && mediaProtoBytes.length > 0;
                if (canRemote && turn.worker && turn.worker.ws.readyState === 1) {
                    let mediaConn = null;
                    if (getMediaConn) {
                        try {
                            const mc = await getMediaConn(false);
                            if (mc?.auth && Array.isArray(mc.hosts) && mc.hosts.length) {
                                mediaConn = { auth: mc.auth, hosts: mc.hosts };
                            }
                        } catch (_) { }
                    }
                    try {
                        const res = await this._dispatchPcFrame(
                            turn.worker,
                            {
                                type: 'job_remote',
                                esVideo: !!esVideo,
                                necesitaAudio: !!necesitaAudio,
                                hasAudioProto: Buffer.isBuffer(audioProtoBytes) && audioProtoBytes.length > 0,
                                mediaConn
                            },
                            [mediaProtoBytes, audioProtoBytes || EMPTY_BUF]
                        );
                        if (res?.needRefreshConn && getMediaConn) {
                            getMediaConn(true).catch(() => { });
                        }
                        if (res?.fatalReason === 'tooLarge') return { tooLarge: true, stiker: null, audio: null };
                        if (res?.fatalReason === 'empty') return { empty: true, stiker: null, audio: null };
                        if (res?.fatalReason === 'downloadError') {
                            return { downloadError: new Error(res.fatalMessage || 'download failed'), stiker: null, audio: null };
                        }
                        if (res?.preuploadedStickerMsg) {
                            this.stats.donePcDirect++;
                            return { preuploadedStickerMsg: res.preuploadedStickerMsg, via: 'pc_direct' };
                        }
                        if (res?.stiker && res.stiker.length) {
                            this.stats.donePc++;
                            return { stiker: res.stiker, audio: res.audio || null, via: 'pc' };
                        }
                    } catch (e) {
                        this.logger.warn?.(`[STICKER-POOL] Fallo en job_remote PC (${turn.worker.name}): ${e.message}.`);
                    }
                } else {
                    // Modo compatibilidad: si no hay protoBytes (p. ej. test mock), bajar y enviar buffer crudo
                    const bajado = await this._descargarParaLocal({
                        descargarMedia, descargarAudioCitado, esVideo, necesitaAudio, maxBytes
                    });
                    if (bajado.downloadError || bajado.empty || bajado.tooLarge) return { ...bajado, stiker: null, audio: null };
                    cachedLocalMedia = bajado;
                    if (turn.worker && turn.worker.ws.readyState === 1) {
                        try {
                            const res = await this._dispatchPcFrame(
                                turn.worker,
                                { type: 'job', esVideo: !!esVideo, necesitaAudio: !!necesitaAudio },
                                [bajado.buffer, bajado.audioBuffer || EMPTY_BUF]
                            );
                            if (res?.stiker && res.stiker.length) {
                                this.stats.donePc++;
                                return { ...res, via: 'pc' };
                            }
                        } catch (e) {
                            this.logger.warn?.(`[STICKER-POOL] Fallo en worker PC (${turn.worker.name}): ${e.message}. Reintentando en Render.`);
                        }
                    }
                }

                // Auto-fallback a Render si la PC cayó o falló
                this.stats.fallbacks++;
                this.releaseTurn(turn);
                turn = await this.acquireLocalTurn();
            }

            if (!cachedLocalMedia) {
                cachedLocalMedia = await this._descargarParaLocal({
                    descargarMedia, descargarAudioCitado, esVideo, necesitaAudio, maxBytes
                });
                if (cachedLocalMedia.downloadError || cachedLocalMedia.empty || cachedLocalMedia.tooLarge) {
                    return { ...cachedLocalMedia, stiker: null, audio: null };
                }
            }

            const resLocal = await this._runLocal({
                buffer: cachedLocalMedia.buffer,
                esVideo,
                necesitaAudio,
                audioBuffer: cachedLocalMedia.audioBuffer,
                fallbackConvertir,
                fallbackAudio
            });
            if (resLocal && resLocal.stiker) this.stats.doneLocal++;
            return { ...resLocal, via: 'render' };
        } finally {
            this.releaseTurn(turn);
        }
    }

    registerWorkerSocket(ws, hello = {}) {
        const id = `pc_${++this._workerSeq}`;
        const concurrency = Math.max(1, Math.min(12, Number(hello.concurrency) || 6));
        const name = String(hello.name || 'pc').slice(0, 40);
        const worker = {
            id,
            ws,
            name,
            concurrency,
            active: 0,
            inflight: new Map(),
            lastPong: Date.now()
        };
        this.workers.set(id, worker);
        this.logger.log?.(`🖥️ [WORKER-POOL] PC conectada: ${name} (${id}, slots=${concurrency})`);

        ws.on('pong', () => {
            worker.lastPong = Date.now();
        });

        ws.on('message', (data, isBinary) => {
            if (!isBinary) {
                try {
                    const msg = JSON.parse(String(data));
                    if (msg.type === 'hello') {
                        worker.concurrency = Math.max(1, Math.min(12, Number(msg.concurrency) || worker.concurrency));
                        worker.name = String(msg.name || worker.name).slice(0, 40);
                        this.drainQueue();
                    }
                } catch (_) { }
                return;
            }
            try {
                const { meta, buffers } = decodeFrame(data);
                const pending = worker.inflight.get(meta.id);
                if (!pending) return;
                worker.inflight.delete(meta.id);

                if (!meta.ok) {
                    if (meta.fatalReason) {
                        return pending.resolve({ fatalReason: meta.fatalReason, fatalMessage: meta.error || '' });
                    }
                    return pending.reject(new Error(meta.error || 'Worker devolvió error'));
                }

                if (meta.preuploaded && buffers[0] && buffers[0].length) {
                    return pending.resolve({
                        preuploadedStickerMsg: Buffer.from(buffers[0]),
                        needRefreshConn: !!meta.needRefreshConn
                    });
                }

                if (!buffers[0] || !buffers[0].length) {
                    return pending.reject(new Error(meta.error || 'Worker devolvió resultado vacío'));
                }
                const stiker = Buffer.from(buffers[0]);
                const waveform = buffers[1] && buffers[1].length ? Buffer.from(buffers[1]) : null;
                const audioOgg = buffers[2] && buffers[2].length ? Buffer.from(buffers[2]) : null;
                const audio = (audioOgg && waveform)
                    ? { buffer: audioOgg, segundos: Number(meta.audioSegundos) || 3, waveform }
                    : null;
                pending.resolve({ stiker, audio, needRefreshConn: !!meta.needRefreshConn });
            } catch (e) {
                this.logger.warn?.('[WORKER-POOL] Frame inválido de worker:', e.message);
            }
        });

        const cleanup = () => {
            if (!this.workers.has(id)) return;
            this.workers.delete(id);
            for (const p of worker.inflight.values()) {
                p.reject(new Error('Worker PC desconectado durante el trabajo'));
            }
            worker.inflight.clear();
            this.logger.warn?.(`🔌 [WORKER-POOL] PC desconectada: ${worker.name} (${id})`);
            this.drainQueue();
        };

        ws.on('close', cleanup);
        ws.on('error', cleanup);
        this.drainQueue();
        return worker;
    }

    attachServer(httpServer, { wsPath = '/ws/worker' } = {}) {
        if (this._wss) return this._wss;
        const wss = new WebSocketServer({
            noServer: true,
            maxPayload: 35 * 1024 * 1024
        });

        this._upgradeHandler = (req, socket, head) => {
            try {
                const url = new URL(req.url || '/', 'http://localhost');
                if (url.pathname !== wsPath) return;

                const ts = req.headers['x-worker-ts'] || url.searchParams.get('ts');
                const sig = req.headers['x-worker-sig'] || url.searchParams.get('sig');
                if (!verifyAuth(this.getSecret(), ts, sig)) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                    socket.destroy();
                    return;
                }

                wss.handleUpgrade(req, socket, head, (ws) => {
                    const name = req.headers['x-worker-name'] || url.searchParams.get('name') || 'pc';
                    const concurrency = req.headers['x-worker-concurrency'] || url.searchParams.get('concurrency') || 6;
                    this.registerWorkerSocket(ws, { name, concurrency });
                });
            } catch (_) {
                try { socket.destroy(); } catch (__) { }
            }
        };

        httpServer.on('upgrade', this._upgradeHandler);
        this._httpServer = httpServer;
        this._wss = wss;

        this._pingTimer = setInterval(() => {
            const ahora = Date.now();
            for (const w of this.workers.values()) {
                if (ahora - w.lastPong > 55000) {
                    try { w.ws.terminate(); } catch (_) { }
                    continue;
                }
                if (w.ws.readyState === 1) {
                    try { w.ws.ping(); } catch (_) { }
                }
            }
        }, 20000);
        if (this._pingTimer.unref) this._pingTimer.unref();
        return wss;
    }

    close() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        if (this._httpServer && this._upgradeHandler) {
            this._httpServer.removeListener('upgrade', this._upgradeHandler);
        }
        for (const w of this.workers.values()) {
            try { w.ws.close(); } catch (_) { }
        }
        this.workers.clear();
        if (this._wss) {
            try { this._wss.close(); } catch (_) { }
            this._wss = null;
        }
    }

    getStats() {
        let pcSlotsTotal = 0;
        let pcSlotsBusy = 0;
        const pcWorkers = [];
        for (const w of this.workers.values()) {
            if (w.ws.readyState !== 1) continue;
            pcSlotsTotal += w.concurrency;
            pcSlotsBusy += w.active;
            pcWorkers.push({ id: w.id, name: w.name, active: w.active, concurrency: w.concurrency });
        }
        return {
            pcConnected: pcWorkers.length,
            pcSlotsTotal,
            pcSlotsBusy,
            localActive: this.localActive,
            localMax: this.maxLocal,
            queueLength: this.queue.length + this.localWaiters.length,
            ...this.stats,
            pcWorkers
        };
    }
}

module.exports = {
    StickerPool,
    deriveWorkerSecret,
    signAuth,
    verifyAuth,
    encodeFrame,
    decodeFrame
};
