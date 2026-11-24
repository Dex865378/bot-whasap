/**
 * 🔊 STICKER CON SONIDO
 *
 * WhatsApp agregó (beta, nov 2026) un audio corto dentro del sticker:
 * `Message.StickerMessage.audioMessage`, campo 26, tipo AudioMessage.
 * El proto oficial de Baileys 7.0.0-rc.9 todavía no trae ese campo, así que
 * se inyecta al serializar. El audio viaja por el pipeline normal de media
 * (se sube cifrado como una nota de voz) y queda anidado en el sticker.
 *
 * Es experimental: el servidor acepta el mensaje, pero el cliente que lo
 * recibe necesita soportar stickers con sonido para reproducirlo. Si algo
 * falla, el caller manda el sticker normal (nunca se pierde el sticker).
 */
const { proto, prepareWAMessageMedia, generateWAMessageFromContent } = require('@whiskeysockets/baileys');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);

const CAMPO_AUDIO = 26;
const TAG_AUDIO = (CAMPO_AUDIO << 3) | 2; // 210 = field 26, wire type 2

let parcheListo = false;

function parchearProtoSonido() {
    if (parcheListo) return;
    parcheListo = true;
    const StickerMessage = proto?.Message?.StickerMessage;
    if (!StickerMessage || typeof StickerMessage.encode !== 'function') return;

    // Si una versión futura de Baileys ya trae el campo, no se toca nada.
    if (Object.prototype.hasOwnProperty.call(StickerMessage.prototype || {}, 'audioMessage')) return;

    const encodeOriginal = StickerMessage.encode;
    StickerMessage.encode = function (mensaje, writer) {
        writer = encodeOriginal.call(this, mensaje, writer);
        const audio = mensaje && mensaje.audioMessage;
        // `url`/`directPath` son la prueba de que prepareWAMessageMedia subió el
        // audio. Un objeto vacío no se manda.
        if (audio && (audio.url || audio.directPath)) {
            const bytes = proto.Message.AudioMessage.encode(audio).finish();
            writer.uint32(TAG_AUDIO).bytes(bytes);
        }
        return writer;
    };

    // DECODE: el proto estático de rc.9 desconoce el campo 26, así que al
    // RECIBIR un sticker con sonido de verdad el audio se descarta. Este
    // wrapper decodifica normal y luego escanea los bytes crudos buscando el
    // campo 26; si está, reatacha el AudioMessage al objeto decodificado.
    // Con esto el bot puede ver y comparar el formato exacto que WhatsApp
    // manda en sus stickers con sonido reales.
    const decodeOriginal = StickerMessage.decode;
    StickerMessage.decode = function (reader, end) {
        // La posición y el límite hay que capturarlos ANTES de decodificar:
        // decodeOriginal consume el Reader hasta el final, y si se leen
        // después el escaneo arranca en el byte final y nunca ve el campo 26.
        const buf = reader && reader.buf ? reader.buf : reader;
        const desde = reader && typeof reader.pos === 'number' ? reader.pos : 0;
        const hasta = typeof end === 'number' ? end : (buf ? buf.length : 0);
        const mensaje = decodeOriginal.apply(this, arguments);
        try {
            if (buf && buf.length && hasta > desde && !mensaje.audioMessage) {
                const audio = extraerAudioAnidado(buf, desde, hasta);
                if (audio) mensaje.audioMessage = audio;
            }
        } catch (e) { }
        return mensaje;
    };
}

// Escanea los bytes de un StickerMessage buscando el campo 26 (AudioMessage)
// y lo devuelve decodificado, o null.
function extraerAudioAnidado(buf, desde, hasta) {
    const Reader = require('protobufjs').Reader;
    const r = Reader.create(buf);
    r.pos = desde;
    r.len = hasta;
    while (r.pos < r.len) {
        const tag = r.uint32();
        const field = tag >>> 3, wire = tag & 7;
        if (field === CAMPO_AUDIO && wire === 2) {
            const len = r.uint32();
            const sub = buf.subarray(r.pos, r.pos + len);
            r.pos += len;
            return proto.Message.AudioMessage.decode(sub);
        }
        if (wire !== 2) { r.skipType(wire); continue; }
        // OJO: hay que leer el largo PRIMERO y sumarlo a la posición que ya
        // quedó después del varint. `r.pos += r.uint32()` suma el largo a la
        // posición ANTERIOR y queda 1 byte corrido (nunca encontraba el 26).
        const len = r.uint32();
        r.pos += len;
    }
    return null;
}

parchearProtoSonido();

// --- Forma de onda y duración reales (lo que WhatsApp le falta al audio) ---
// Baileys calcula el waveform con `audio-decode`, una peerDependency opcional
// que NO está instalada: se la salta en silencio (requiresWaveformProcessing →
// catch → sin waveform) y el cliente recibe una nota de voz sin forma de
// onda. Toda nota de voz real de WhatsApp lleva waveform (63 muestras de 5
// bits, empaquetadas LSB-first) y eso es lo que genera el reproductor.
// Un solo pase de ffmpeg decodifica el OGG a PCM y de ahí salen duración y
// picos. Sin dependencias nuevas.
async function prepararAudioParaSticker(buffer, ffmpegPath = 'ffmpeg', maxSegundos = 10) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const tope = Math.max(1, Math.min(10, Number.isFinite(Number(maxSegundos)) ? Number(maxSegundos) : 10));
    const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpIn = path.join(os.tmpdir(), `stk_info_in_${uid}.bin`);
    const tmpOgg = path.join(os.tmpdir(), `stk_info_out_${uid}.ogg`);
    const tmpPcm = path.join(os.tmpdir(), `stk_info_out_${uid}.pcm`);
    fs.writeFileSync(tmpIn, buffer);
    let ogg = null;
    try {
        // UN solo pase con DOS salidas: OGG/Opus (para subir) y PCM 8 kHz mono
        // (para duración y waveform). Antes eran dos pases encadenados; el
        // segundo sumaba ~0,1 s locales = ~2-3 s en Render (0.1 vCPU).
        // Si el video no tiene audio, el muxer falla y se devuelve null:
        // el caller manda el sticker normal.
        await execFileAsync(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
            '-i', tmpIn,
            '-vn', '-map', '0:a:0?', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'audio', '-t', String(tope), '-f', 'ogg', '-y', tmpOgg,
            '-vn', '-map', '0:a:0?', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '8000', '-t', String(tope), '-y', tmpPcm
        ], { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 });
        ogg = fs.readFileSync(tmpOgg);
        if (!ogg.length) return null;
        const pcm = fs.readFileSync(tmpPcm);
        const muestras = Math.floor(pcm.length / 2);
        if (muestras < 100) return { buffer: ogg, segundos: 0, waveform: null };
        // Formato REAL de WhatsApp (el mismo que usa Baileys para las notas de
        // voz): 64 bytes, cada uno una muestra de amplitud entre 0 y 100.
        // NO va empaquetado a 5 bits: el cliente lee 64 bytes directos y un
        // buffer de 40 bytes le rompe la reproducción ("no se pudo reproducir").
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
            // Audio mudo o demasiado bajo: una waveform de puros ceros deja el
            // sticker sin forma de onda visible. Se usa 1 como mínimo.
            waveform[i] = maxPromedio > 0
                ? Math.min(100, Math.max(0, Math.round((promedios[i] / maxPromedio) * 100)))
                : 1;
        }
        return {
            buffer: ogg,
            segundos: muestras / 8000,
            waveform
        };
    } catch (e) {
        // Si el pase de PCM falla, al menos devolvemos el audio; el caller
        // pone un seconds razonable y el sticker viaja sin waveform.
        // Sin pista de audio (video mudo) es normal: no se avisa. Si el OGG
        // sí salió pero falló el PCM, se conserva el audio y se avisa.
        if (ogg) console.warn('[STICKER-SONIDO] prepararAudioParaSticker falló:', e.message);
        return ogg ? { buffer: ogg, segundos: 0, waveform: null } : null;
    } finally {
        try { fs.unlinkSync(tmpIn); } catch (e) { }
        try { fs.unlinkSync(tmpOgg); } catch (e) { }
        try { fs.unlinkSync(tmpPcm); } catch (e) { }
    }
}

/**
 * Sube el sticker y el audio, arma el mensaje y lo manda por relayMessage.
 * Devuelve el WAMessage enviado, o null si no se pudo (para que el caller
 * caiga al sticker sin sonido).
 */
async function enviarStickerConSonido(sock, jid, sticker, audio, quoted, ffmpegPath = 'ffmpeg') {
    // Interruptor de emergencia sin redeploy: STICKER_SONIDO=0 en Render y el
    // comando vuelve al sticker normal.
    if (process.env.STICKER_SONIDO === '0') return null;
    if (!sock || !sticker || !audio) return null;
    // Compat: acepta Buffer pelado (tests viejos) o { buffer, segundos, waveform }.
    const audioInfo = Buffer.isBuffer(audio) ? { buffer: audio, segundos: 0, waveform: null } : audio;
    if (!audioInfo.buffer || !audioInfo.buffer.length) return null;
    try {
        const opciones = { upload: sock.waUploadToServer, logger: sock.logger, mediaUploadTimeoutMs: 30000 };

        // Secuencial a propósito: dos subidas simultáneas pueden competir por
        // el refresh de mediaConn en Render. El sticker es chico y el audio
        // también, así que la demora extra es mínima.
        const stickerMedia = await prepareWAMessageMedia({ sticker }, opciones);
        const audioMedia = await prepareWAMessageMedia({
            audio: audioInfo.buffer,
            ptt: true,
            mimetype: 'audio/ogg; codecs=opus'
        }, opciones);

        if (!stickerMedia?.stickerMessage || !audioMedia?.audioMessage) return null;
        if (!audioMedia.audioMessage.url && !audioMedia.audioMessage.directPath) return null;

        // Lo que WhatsApp espera en toda nota de voz: duración real y forma
        // de onda. Baileys pone seconds (si music-metadata anda) pero NUNCA
        // waveform (audio-decode no está instalado). Sin seconds>0 el cliente
        // tira "error al reproducir" al tocar el sticker.
        const audioMsg = audioMedia.audioMessage;
        const seg = Math.max(1, Math.round(audioInfo.segundos || Number(audioMsg.seconds) || 3));
        audioMsg.seconds = seg;
        if (audioInfo.waveform && audioInfo.waveform.length) {
            audioMsg.waveform = audioInfo.waveform;
        }

        const waMsg = generateWAMessageFromContent(jid, {
            stickerMessage: {
                ...stickerMedia.stickerMessage,
                audioMessage: audioMedia.audioMessage
            }
        }, {
            userJid: sock.user?.id,
            quoted: quoted || undefined
        });

        if (!waMsg?.message?.stickerMessage) return null;

        // generateWAMessageFromContent puede pasar el mensaje por fromObject y
        // perder campos que el proto no conoce; se vuelve a pegar antes de
        // serializar. El parche de encode lo convierte en el campo 26.
        waMsg.message.stickerMessage.audioMessage = audioMedia.audioMessage;

        await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id });
        return waMsg;
    } catch (e) {
        console.warn('[STICKER-SONIDO] No se pudo mandar con audio:', e.message);
        return null;
    }
}

module.exports = { enviarStickerConSonido, prepararAudioParaSticker, parchearProtoSonido, TAG_AUDIO, CAMPO_AUDIO };