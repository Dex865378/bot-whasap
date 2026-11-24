/**
 * 🔊 STICKER CON SONIDO
 *
 * WhatsApp agregó (beta, nov 2026) un audio corto dentro del sticker:
 * `Message.StickerMessage.audioMessage`, campo 26, tipo AudioMessage, y en
 * clientes nuevos los envuelve en `Message.audioStickerMessage` (campo 134,
 * FutureProofMessage). El proto estático de Baileys 7.0.0-rc.9 aún no trae
 * esos campos, así que se inyectan al serializar y se desenvuelven al leer.
 *
 * Además corrige la carrera de `encryptedStream()` de rc.9 (que resuelve antes
 * de vaciar el `WriteStream` a disco) esperando a que el archivo cifrado
 * coincida con `fileEncSha256B64` antes de subirlo, y rechaza OGG sin frames
 * reproducibles para no enviar stickers con "error al reproducir audio".
 */
const crypto = require('crypto');
const { proto, prepareWAMessageMedia, generateWAMessageFromContent, getMediaKeys } = require('@whiskeysockets/baileys');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Reader } = require('protobufjs');
const { esWebpAnimado } = require('./media');

const execFileAsync = promisify(execFile);

const CAMPO_AUDIO = 26;
const TAG_AUDIO = (CAMPO_AUDIO << 3) | 2; // 210 = field 26, wire type 2
const CAMPO_AUDIO_STICKER = 134;
const CHUNK_SIDECAR = 64 * 1024;
const BLOCK_AES = 16;
const RELAY_TIMEOUT_MS = 25000;

let parcheListo = false;

function escanearCampoBytes(buf, desde, hasta, campoObjetivo) {
    const r = Reader.create(buf);
    r.pos = desde;
    r.len = hasta;
    while (r.pos < r.len) {
        const tag = r.uint32();
        const field = tag >>> 3;
        const wire = tag & 7;
        if (wire !== 2) {
            r.skipType(wire);
            continue;
        }
        const len = r.uint32();
        const fin = r.pos + len;
        if (fin > hasta) return null;
        if (field === campoObjetivo) {
            return buf.subarray(r.pos, fin);
        }
        r.pos = fin;
    }
    return null;
}

function parchearProtoSonido() {
    if (parcheListo) return;
    parcheListo = true;

    const StickerMessage = proto?.Message?.StickerMessage;
    if (StickerMessage && typeof StickerMessage.encode === 'function'
        && !Object.prototype.hasOwnProperty.call(StickerMessage.prototype || {}, 'audioMessage')) {
        const encodeOriginal = StickerMessage.encode;
        StickerMessage.encode = function (mensaje, writer) {
            writer = encodeOriginal.call(this, mensaje, writer);
            const audio = mensaje && mensaje.audioMessage;
            if (audio && (audio.url || audio.directPath)) {
                const bytes = proto.Message.AudioMessage.encode(audio).finish();
                writer.uint32(TAG_AUDIO).bytes(bytes);
            }
            return writer;
        };

        const decodeOriginal = StickerMessage.decode;
        StickerMessage.decode = function (reader, end) {
            const buf = reader && reader.buf ? reader.buf : reader;
            const desde = reader && typeof reader.pos === 'number' ? reader.pos : 0;
            // En protobufjs el 2do argumento de decode es la LONGITUD del
            // submensaje, no el offset absoluto final.
            const hasta = typeof end === 'number' ? (desde + end) : (buf ? buf.length : 0);
            const mensaje = decodeOriginal.apply(this, arguments);
            try {
                if (buf && buf.length && hasta > desde && !mensaje.audioMessage) {
                    const sub = escanearCampoBytes(buf, desde, hasta, CAMPO_AUDIO);
                    if (sub) mensaje.audioMessage = proto.Message.AudioMessage.decode(sub);
                }
            } catch (e) { }
            return mensaje;
        };
    }

    const Message = proto?.Message;
    if (Message && typeof Message.decode === 'function'
        && !Object.prototype.hasOwnProperty.call(Message.prototype || {}, 'audioStickerMessage')) {
        const decodeMsgOriginal = Message.decode;
        Message.decode = function (reader, end) {
            const buf = reader && reader.buf ? reader.buf : reader;
            const desde = reader && typeof reader.pos === 'number' ? reader.pos : 0;
            const hasta = typeof end === 'number' ? (desde + end) : (buf ? buf.length : 0);
            const mensaje = decodeMsgOriginal.apply(this, arguments);
            try {
                if (buf && buf.length && hasta > desde && !mensaje.stickerMessage) {
                    const fpBuf = escanearCampoBytes(buf, desde, hasta, CAMPO_AUDIO_STICKER);
                    if (fpBuf) {
                        const fp = proto.Message.FutureProofMessage.decode(fpBuf);
                        if (fp?.message?.stickerMessage) {
                            mensaje.stickerMessage = fp.message.stickerMessage;
                        }
                    }
                }
            } catch (e) { }
            return mensaje;
        };
    }
}

parchearProtoSonido();

/**
 * Verifica que el buffer sea un stream OGG/Opus completo con cabecera OpusHead
 * y al menos una página de paquetes de audio (RFC 7845: >= 3 páginas OggS).
 */
function validarOggOpus(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 100) return false;
    if (buf.subarray(0, 4).toString('latin1') !== 'OggS') return false;
    if (!buf.includes(Buffer.from('OpusHead'))) return false;

    let pos = 0;
    let paginas = 0;
    let tieneAudio = false;
    while (pos < buf.length) {
        if (pos + 27 > buf.length) return false;
        if (buf.subarray(pos, pos + 4).toString('latin1') !== 'OggS') return false;
        const numSegs = buf[pos + 26];
        const hdrEnd = pos + 27 + numSegs;
        if (hdrEnd > buf.length) return false;
        let bodyLen = 0;
        for (let i = 0; i < numSegs; i++) bodyLen += buf[pos + 27 + i];
        if (hdrEnd + bodyLen > buf.length) return false;
        paginas++;
        if (paginas >= 3 && bodyLen > 0) tieneAudio = true;
        pos = hdrEnd + bodyLen;
    }
    return pos === buf.length && paginas >= 3 && tieneAudio;
}

/**
 * Calcula la forma de onda de 64 bytes (valores 0-100) desde PCM s16le 8 kHz mono.
 * Devuelve null si hay menos de 160 muestras (< 20 ms, sin audio reproducible).
 */
function calcularWaveformDesdePcm(pcm) {
    if (!Buffer.isBuffer(pcm)) return null;
    const muestras = Math.floor(pcm.length / 2);
    if (muestras < 160) return null;

    const N = 64;
    const paso = Math.floor(muestras / N);
    const promedios = [];
    for (let i = 0; i < N; i++) {
        let suma = 0;
        const base = i * paso * 2;
        for (let j = 0; j < paso * 2; j += 2) {
            suma += Math.abs(pcm.readInt16LE(base + j));
        }
        promedios.push(paso ? suma / paso : 0);
    }
    const maxPromedio = Math.max(...promedios);
    const waveform = Buffer.alloc(N);
    for (let i = 0; i < N; i++) {
        waveform[i] = maxPromedio > 0
            ? Math.min(100, Math.max(0, Math.round((promedios[i] / maxPromedio) * 100)))
            : 1;
    }
    return waveform;
}

function dimensionesWebp(buf) {
    const def = { width: 512, height: 512 };
    if (!Buffer.isBuffer(buf) || buf.length < 30) return def;
    if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return def;

    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X' && buf.length >= 30) {
        return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
    }
    if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
    }
    return def;
}

async function calcularStreamingSidecar(mediaKey, encBuf, mediaType = 'audio') {
    if (!mediaKey || !Buffer.isBuffer(encBuf) || !encBuf.length) return null;
    const { iv, macKey } = await getMediaKeys(mediaKey, mediaType);
    const partes = [];
    let prefix = Buffer.from(iv);
    let offset = 0;
    while (offset < encBuf.length) {
        const end = Math.min(encBuf.length, offset + CHUNK_SIDECAR);
        const chunk = encBuf.subarray(offset, end);
        const mac = crypto.createHmac('sha256', macKey).update(prefix).update(chunk).digest().subarray(0, 10);
        partes.push(mac);
        if (end >= encBuf.length) break;
        prefix = encBuf.subarray(end - BLOCK_AES, end);
        offset = end;
    }
    return Buffer.concat(partes);
}

// Baileys 7.0.0-rc.9 resuelve encryptedStream() sin esperar el evento 'finish'
// del WriteStream: para buffers chicos (<64 KB) createReadStream puede leer 0
// bytes o truncado. Se espera hasta que el hash en disco coincida.
async function esperarArchivoCifrado(filePath, expectedSha256B64, maxEsperaMs = 2000) {
    const limite = Date.now() + maxEsperaMs;
    let pausa = 10;
    while (true) {
        try {
            const buf = await fs.promises.readFile(filePath);
            if (buf.length > 0) {
                const hash = crypto.createHash('sha256').update(buf).digest('base64');
                if (hash === expectedSha256B64) return buf;
            }
        } catch (e) { }
        if (Date.now() >= limite) {
            throw new Error('Archivo cifrado incompleto en disco antes de subir');
        }
        await new Promise(r => setTimeout(r, pausa));
        pausa = Math.min(50, pausa * 2);
    }
}

async function prepararAudioParaSticker(buffer, ffmpegPath = 'ffmpeg', maxSegundos = 10) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const tope = Math.max(1, Math.min(10, Number.isFinite(Number(maxSegundos)) ? Number(maxSegundos) : 10));
    const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpIn = path.join(os.tmpdir(), `stk_info_in_${uid}.bin`);
    const tmpOgg = path.join(os.tmpdir(), `stk_info_out_${uid}.ogg`);
    const tmpPcm = path.join(os.tmpdir(), `stk_info_out_${uid}.pcm`);
    await fs.promises.writeFile(tmpIn, buffer);
    let ogg = null;
    try {
        await execFileAsync(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
            '-fflags', '+genpts', '-err_detect', 'ignore_err',
            '-i', tmpIn,
            '-vn', '-sn', '-dn', '-map', '0:a:0?', '-map_metadata', '-1',
            '-af', 'asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0',
            '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'audio',
            '-avoid_negative_ts', 'make_zero', '-t', String(tope), '-f', 'ogg', '-y', tmpOgg,
            '-vn', '-sn', '-dn', '-map', '0:a:0?',
            '-af', 'asetpts=PTS-STARTPTS,aresample=8000:async=1:first_pts=0',
            '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '8000',
            '-t', String(tope), '-y', tmpPcm
        ], { timeout: 25000, windowsHide: true, maxBuffer: 1024 * 1024 });

        const [oggRead, pcm] = await Promise.all([
            fs.promises.readFile(tmpOgg),
            fs.promises.readFile(tmpPcm)
        ]);
        ogg = oggRead;
        const waveform = calcularWaveformDesdePcm(pcm);
        if (!validarOggOpus(ogg) || !waveform) {
            if (ogg && ogg.length) console.warn(`[STICKER-SONIDO] Pista de audio sin frames reproducibles (${ogg.length}B ogg, ${pcm.length}B pcm); se envía sticker normal.`);
            return null;
        }
        return {
            buffer: ogg,
            segundos: Math.floor(pcm.length / 2) / 8000,
            waveform
        };
    } catch (e) {
        if (ogg && ogg.length) console.warn('[STICKER-SONIDO] prepararAudioParaSticker falló:', e.message);
        return null;
    } finally {
        await Promise.all([
            fs.promises.unlink(tmpIn).catch(() => { }),
            fs.promises.unlink(tmpOgg).catch(() => { }),
            fs.promises.unlink(tmpPcm).catch(() => { })
        ]);
    }
}

async function subirYArmarSticker({
    sticker,
    audio = null,
    upload,
    logger,
    mediaUploadTimeoutMs = 30000,
    parallelUpload = false
}) {
    if (!sticker || !upload) return null;
    const audioInfo = audio
        ? (Buffer.isBuffer(audio) ? { buffer: audio, segundos: 0, waveform: null } : audio)
        : null;
    const conAudio = !!(audioInfo && audioInfo.buffer && audioInfo.buffer.length);

    const encCapturado = new Map();
    const opciones = {
        upload: async (filePath, meta) => {
            if (meta?.fileEncSha256B64) {
                const encBuf = await esperarArchivoCifrado(filePath, meta.fileEncSha256B64);
                if (meta.mediaType) encCapturado.set(meta.mediaType, encBuf);
            }
            return upload(filePath, meta);
        },
        logger,
        mediaUploadTimeoutMs
    };

    const seg = conAudio ? Math.max(1, Math.min(10, Math.round(Number(audioInfo.segundos) || 3))) : 0;

    let stickerMedia, audioMedia;
    if (conAudio && parallelUpload) {
        [stickerMedia, audioMedia] = await Promise.all([
            prepareWAMessageMedia({ sticker }, opciones),
            prepareWAMessageMedia({
                audio: audioInfo.buffer,
                ptt: true,
                mimetype: 'audio/ogg; codecs=opus',
                seconds: seg
            }, opciones)
        ]);
    } else {
        // Secuencial cuando depende de refreshMediaConn inicial en Render.
        stickerMedia = await prepareWAMessageMedia({ sticker }, opciones);
        if (conAudio) {
            audioMedia = await prepareWAMessageMedia({
                audio: audioInfo.buffer,
                ptt: true,
                mimetype: 'audio/ogg; codecs=opus',
                seconds: seg
            }, opciones);
        }
    }

    if (!stickerMedia?.stickerMessage) return null;
    const stickerMsg = stickerMedia.stickerMessage;
    const dims = dimensionesWebp(sticker);
    stickerMsg.width = stickerMsg.width || dims.width;
    stickerMsg.height = stickerMsg.height || dims.height;
    if (typeof stickerMsg.isAnimated !== 'boolean') stickerMsg.isAnimated = esWebpAnimado(sticker);
    stickerMsg.stickerSentTs = stickerMsg.stickerSentTs || Date.now();

    if (conAudio) {
        if (!audioMedia?.audioMessage) return null;
        if (!audioMedia.audioMessage.url && !audioMedia.audioMessage.directPath) return null;
        const audioMsg = audioMedia.audioMessage;
        audioMsg.seconds = seg;
        if (audioInfo.waveform && audioInfo.waveform.length) {
            audioMsg.waveform = audioInfo.waveform;
        }
        const encAudio = encCapturado.get('audio');
        if (audioMsg.mediaKey && encAudio) {
            const sidecar = await calcularStreamingSidecar(audioMsg.mediaKey, encAudio, 'audio');
            if (sidecar && sidecar.length) audioMsg.streamingSidecar = sidecar;
        }
        stickerMsg.audioMessage = audioMsg;
    }

    return stickerMsg;
}

async function enviarStickerPreSubido(sock, jid, stickerMsgOrBytes, quoted) {
    if (!sock || !stickerMsgOrBytes) return null;
    parchearProtoSonido();
    const stickerMsg = Buffer.isBuffer(stickerMsgOrBytes)
        ? proto.Message.StickerMessage.decode(stickerMsgOrBytes)
        : stickerMsgOrBytes;
    if (!stickerMsg || (!stickerMsg.url && !stickerMsg.directPath)) return null;

    const savedAudio = stickerMsg.audioMessage || null;
    const waMsg = generateWAMessageFromContent(jid, {
        stickerMessage: {
            ...stickerMsg,
            ...(savedAudio ? { audioMessage: savedAudio } : {})
        }
    }, {
        userJid: sock.user?.id,
        quoted: quoted || undefined
    });

    if (!waMsg?.message?.stickerMessage) return null;
    if (savedAudio) waMsg.message.stickerMessage.audioMessage = savedAudio;

    const enviarOnce = () => {
        let timer;
        return Promise.race([
            sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id }),
            new Promise((_, rej) => {
                timer = setTimeout(() => rej(new Error('relayMessage timeout')), RELAY_TIMEOUT_MS);
            })
        ]).finally(() => clearTimeout(timer));
    };

    try {
        await enviarOnce();
    } catch (e) {
        if (e?.data === 429 || String(e?.message || '').includes('rate-overlimit')) {
            await new Promise(r => setTimeout(r, 1000));
            await enviarOnce();
        } else {
            throw e;
        }
    }
    return waMsg;
}

/**
 * Sube el sticker y el audio, arma el mensaje y lo manda por relayMessage.
 * Devuelve el WAMessage enviado, o null si no se pudo (para que el caller
 * caiga al sticker sin sonido).
 */
async function enviarStickerConSonido(sock, jid, sticker, audio, quoted, ffmpegPath = 'ffmpeg') {
    if (process.env.STICKER_SONIDO === '0') return null;
    if (!sock || !sticker || !audio) return null;
    const audioInfo = Buffer.isBuffer(audio) ? { buffer: audio, segundos: 0, waveform: null } : audio;
    if (!audioInfo.buffer || !audioInfo.buffer.length) return null;
    try {
        const stickerMsg = await subirYArmarSticker({
            sticker,
            audio: audioInfo,
            upload: (filePath, meta) => sock.waUploadToServer(filePath, meta),
            logger: sock.logger
        });
        if (!stickerMsg) return null;
        return await enviarStickerPreSubido(sock, jid, stickerMsg, quoted);
    } catch (e) {
        console.warn('[STICKER-SONIDO] No se pudo mandar con audio:', e.message);
        return null;
    }
}

module.exports = {
    enviarStickerConSonido,
    subirYArmarSticker,
    enviarStickerPreSubido,
    esperarArchivoCifrado,
    prepararAudioParaSticker,
    parchearProtoSonido,
    validarOggOpus,
    calcularWaveformDesdePcm,
    calcularStreamingSidecar,
    dimensionesWebp,
    TAG_AUDIO,
    CAMPO_AUDIO,
    CAMPO_AUDIO_STICKER
};
