/**
 * 🧠 CACHE DE STICKERS YA SUBIDOS
 *
 * Guarda el "recibo" de subida de un sticker (y su audio) para reenviarlo
 * sin volver a descargar, convertir con FFmpeg ni subir el archivo. Es el
 * mismo truco que usa WhatsApp al reenviar una media: reutiliza url,
 * directPath, mediaKey y los hashes del archivo original.
 *
 * La clave se arma con el hash de contenido del mensaje de WhatsApp
 * (fileSha256) antes de descargar nada. Si el mismo archivo se manda con
 * otro audio citado, la clave cambia y se procesa de nuevo.
 */
'use strict';
const { BufferJSON } = require('@whiskeysockets/baileys');

const VERSION_CACHE = 'v1';
const MAX_ENTRADAS = 500;
const mem = new Map(); // clave -> { json, ultimo }
const stats = {
    hits: 0,
    misses: 0,
    dbHits: 0,
    saved: 0,
    invalid: 0,
    errors: 0
};

function numero(v) {
    if (v && typeof v.toNumber === 'function') return v.toNumber();
    // Los Long que sobreviven a un JSON viejo quedan como { low, high }.
    if (v && typeof v === 'object' && typeof v.low === 'number') {
        return (v.high >>> 0) * 0x100000000 + (v.low >>> 0);
    }
    return Number(v);
}

function hashMedia(valor) {
    if (!valor) return null;
    if (typeof valor === 'string') return valor ? `s:${valor}` : null;
    let buf = null;
    if (Buffer.isBuffer(valor)) buf = valor;
    else if (valor instanceof Uint8Array) buf = Buffer.from(valor);
    if (!buf || !buf.length) return null;
    return buf.toString('base64');
}

function construirClaveCache({ media, audio = null, esVideo = false, conAudio = false, tipoMedia = '' } = {}) {
    const hashContenido = hashMedia(media && media.fileSha256);
    if (!hashContenido) return null;
    // En video el audio sale del propio video: no hay un hash de audio aparte.
    const hashAudio = (conAudio && !esVideo) ? hashMedia(audio && audio.fileSha256) : null;
    if (conAudio && !esVideo && !hashAudio) return null;
    return [
        VERSION_CACHE,
        String(tipoMedia || (esVideo ? 'videoMessage' : 'imageMessage')),
        esVideo ? 'v' : 'i',
        conAudio ? 'a' : 'n',
        hashContenido,
        hashAudio || '-'
    ].join(':');
}

function clonarValorCache(valor) {
    if (Buffer.isBuffer(valor)) return Buffer.from(valor);
    if (valor instanceof Uint8Array) return Buffer.from(valor);
    if (Array.isArray(valor)) return valor.map(clonarValorCache);
    if (valor && typeof valor === 'object') {
        // No usar JSON.stringify directo: el toJSON() de protobuf descarta los
        // campos que el proto base no conoce (audioMessage, campo 26).
        if (typeof valor.toNumber === 'function') return valor.toNumber();
        const copia = {};
        for (const clave of Object.keys(valor)) copia[clave] = clonarValorCache(valor[clave]);
        return copia;
    }
    return valor;
}

function clonarJson(valor) {
    return clonarValorCache(valor);
}

function normalizarSticker(stickerMsg) {
    if (!stickerMsg || (!stickerMsg.url && !stickerMsg.directPath)) return null;
    let copia;
    try { copia = clonarJson(stickerMsg); } catch (_) { return null; }
    if (!copia || (!copia.url && !copia.directPath)) return null;
    delete copia.contextInfo;
    if (copia.audioMessage) {
        const audio = copia.audioMessage;
        if (!audio.url && !audio.directPath) {
            delete copia.audioMessage;
        } else {
            delete audio.contextInfo;
        }
    }
    return copia;
}

function esStickerCacheValido(stickerMsg, conAudio = !!stickerMsg?.audioMessage) {
    if (!stickerMsg || (!stickerMsg.url && !stickerMsg.directPath)) return false;
    if (!stickerMsg.mediaKey || !stickerMsg.fileSha256 || !stickerMsg.fileEncSha256) return false;
    if (!(numero(stickerMsg.fileLength) > 0)) return false;

    const audio = stickerMsg.audioMessage;
    if (conAudio) {
        if (!audio || (!audio.url && !audio.directPath)) return false;
        if (!audio.mediaKey || !audio.fileSha256 || !audio.fileEncSha256) return false;
        if (!(numero(audio.fileLength) > 0)) return false;
        if (audio.ptt !== true) return false;
        if (!(numero(audio.seconds) > 0)) return false;
        if (!audio.waveform || audio.waveform.length !== 64) return false;
        if (!audio.mimetype || !String(audio.mimetype).toLowerCase().includes('ogg')) return false;
    } else if (audio && (audio.url || audio.directPath)) {
        return false;
    }
    return true;
}

function serializarStickerParaCache(stickerMsg, { conAudio } = {}) {
    const copia = normalizarSticker(stickerMsg);
    if (!copia) return null;
    const conAudioFinal = typeof conAudio === 'boolean' ? conAudio : !!copia.audioMessage;
    if (!esStickerCacheValido(copia, conAudioFinal)) return null;
    try { return JSON.stringify(copia, BufferJSON.replacer); } catch (_) { return null; }
}

function deserializarStickerCache(json) {
    if (!json || typeof json !== 'string') return null;
    try {
        const obj = JSON.parse(json, BufferJSON.reviver);
        return obj && typeof obj === 'object' ? obj : null;
    } catch (_) {
        return null;
    }
}

function tocarMemoria(clave, json) {
    if (mem.has(clave)) mem.delete(clave);
    mem.set(clave, { json, ultimo: Date.now() });
    while (mem.size > MAX_ENTRADAS) {
        const masViejo = mem.keys().next().value;
        if (masViejo === undefined) break;
        mem.delete(masViejo);
    }
}

function quitarMemoria(clave) {
    mem.delete(clave);
}

async function obtenerStickerCache(clave, dbRef = null, { conAudio } = {}) {
    if (!clave) { stats.misses++; return null; }
    const enMemoria = mem.get(clave);
    if (enMemoria) {
        const obj = deserializarStickerCache(enMemoria.json);
        if (obj && (typeof conAudio !== 'boolean' || esStickerCacheValido(obj, conAudio))) {
            tocarMemoria(clave, enMemoria.json);
            stats.hits++;
            return obj;
        }
        quitarMemoria(clave);
        stats.invalid++;
    }

    stats.misses++;
    if (!dbRef || typeof dbRef.getStickerCache !== 'function') return null;
    try {
        const fila = await dbRef.getStickerCache(clave);
        const json = typeof fila === 'string' ? fila : (fila && fila.sticker);
        if (!json) return null;
        const obj = deserializarStickerCache(json);
        if (!obj || (typeof conAudio === 'boolean' && !esStickerCacheValido(obj, conAudio))) {
            stats.invalid++;
            return null;
        }
        tocarMemoria(clave, json);
        stats.hits++;
        stats.dbHits++;
        return obj;
    } catch (e) {
        stats.errors++;
        return null;
    }
}

async function guardarStickerCache(clave, stickerMsg, dbRef = null, { conAudio } = {}) {
    if (!clave) return false;
    const json = serializarStickerParaCache(stickerMsg, { conAudio });
    if (!json) return false;
    tocarMemoria(clave, json);
    stats.saved++;
    if (!dbRef || typeof dbRef.saveStickerCache !== 'function') return true;
    try {
        await dbRef.saveStickerCache(clave, json, MAX_ENTRADAS);
        return true;
    } catch (e) {
        stats.errors++;
        return false;
    }
}

async function borrarStickerCache(clave, dbRef = null) {
    if (!clave) return false;
    quitarMemoria(clave);
    if (!dbRef || typeof dbRef.deleteStickerCache !== 'function') return true;
    try {
        await dbRef.deleteStickerCache(clave);
        return true;
    } catch (e) {
        stats.errors++;
        return false;
    }
}

function getStats() {
    let bytes = 0;
    for (const [clave, item] of mem) bytes += clave.length + item.json.length;
    return {
        ram: mem.size,
        maxRam: MAX_ENTRADAS,
        ramKB: +(bytes / 1024).toFixed(1),
        ...stats
    };
}

function limpiarCacheMemoriaStickers() {
    mem.clear();
    for (const k of Object.keys(stats)) stats[k] = 0;
}

module.exports = {
    VERSION_CACHE,
    MAX_ENTRADAS,
    construirClaveCache,
    esStickerCacheValido,
    serializarStickerParaCache,
    deserializarStickerCache,
    obtenerStickerCache,
    guardarStickerCache,
    borrarStickerCache,
    getStats,
    limpiarCacheMemoriaStickers
};