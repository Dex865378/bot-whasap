/**
 * 🧪 Tests del cache de stickers (sin WhatsApp).
 * Uso: node scripts/test-sticker-cache.js
 *
 * Seams:
 *  - construirClaveCache(): misma media + mismo audio = misma clave;
 *    audio distinto o tipo distinto = clave distinta.
 *  - serializar/deserializar: conserva Buffers (waveform, mediaKey) y
 *    elimina contextInfo viejo para no reenviar citas equivocadas.
 *  - !s: un segundo envío idéntico no descarga ni convierte ni sube.
 *  - !s con audio fallido NO guarda un sticker mudo bajo la clave con audio.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execute } = require('../commands/main');
const {
    construirClaveCache,
    serializarStickerParaCache,
    deserializarStickerCache,
    esStickerCacheValido,
    obtenerStickerCache,
    guardarStickerCache,
    limpiarCacheMemoriaStickers
} = require('../utils/stickerCache');
const { enviarStickerPreSubido } = require('../utils/stickerSonido');

const STICKER = fs.readFileSync(path.join(__dirname, '..', 'sticker_bienvenida.webp'));

function mensajeSticker({ audio = true } = {}) {
    const msg = {
        url: 'https://mmg.whatsapp.net/d/f/sticker',
        directPath: '/v/t62.7118-24/sticker',
        mimetype: 'image/webp',
        mediaKey: Buffer.alloc(32, 1),
        fileSha256: Buffer.alloc(32, 2),
        fileEncSha256: Buffer.alloc(32, 3),
        fileLength: 1234,
        width: 512,
        height: 512,
        isAnimated: false
    };
    if (audio) {
        msg.audioMessage = {
            url: 'https://mmg.whatsapp.net/d/f/audio',
            directPath: '/v/t62.7118-24/audio',
            mimetype: 'audio/ogg; codecs=opus',
            mediaKey: Buffer.alloc(32, 4),
            fileSha256: Buffer.alloc(32, 5),
            fileEncSha256: Buffer.alloc(32, 6),
            fileLength: 4321,
            ptt: true,
            seconds: 6,
            waveform: Buffer.alloc(64, 9),
            streamingSidecar: Buffer.alloc(20, 7)
        };
    }
    return msg;
}

function sockFalso({ stickerEnviado = null } = {}) {
    const estado = { relay: 0, capturado: null, enviados: [] };
    const sock = {
        user: { id: '123@s.whatsapp.net' },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        waUploadToServer: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/d/f/fake', directPath: '/v/t62.7118-24/fake' }),
        relayMessage: async (jid, message) => {
            estado.relay++;
            estado.capturado = message;
            return 'MSGID';
        },
        sendMessage: async (jid, content, opts) => {
            estado.enviados.push({ jid, content, opts });
            return stickerEnviado || { key: { id: 'SENDID' } };
        }
    };
    return { sock, estado };
}

function msgImagenSinAudio(hashImagen) {
    return {
        key: { remoteJid: '123@s.whatsapp.net', id: 'SINAUDIO1', fromMe: false },
        message: { imageMessage: { mimetype: 'image/jpeg', caption: '!s', fileSha256: hashImagen } }
    };
}

function msgImagenConAudio(hashImagen, hashAudio) {
    return {
        key: { remoteJid: '123@s.whatsapp.net', id: 'CACHE1', fromMe: false },
        message: {
            imageMessage: {
                mimetype: 'image/jpeg', caption: '!s',
                fileSha256: hashImagen,
                contextInfo: {
                    quotedMessage: {
                        audioMessage: {
                            ptt: true,
                            mimetype: 'audio/ogg; codecs=opus',
                            seconds: 3,
                            fileSha256: hashAudio
                        }
                    }
                }
            }
        }
    };
}

async function ejecutarSticker(sock, msg, extra = {}) {
    return execute(sock, '123@s.whatsapp.net', msg, [], {
        start: '!s', cmd: '!s', txt: '!s', isGroup: false, sender: '123@s.whatsapp.net', pushName: 'Test',
        botState: {}, db: {}, FFMPEG_PATH: 'ffmpeg',
        ...extra
    });
}

(async () => {
    let fallos = 0;
    const probar = async (nombre, fn) => {
        try { await fn(); console.log(`✅ ${nombre}`); }
        catch (e) { fallos++; console.error(`❌ ${nombre}\n   ${e.message}`); }
    };

    await probar('la clave es estable y distingue audio/tipo', async () => {
        const media = { fileSha256: Buffer.alloc(32, 1) };
        const audio = { fileSha256: Buffer.alloc(32, 2) };
        const base = { media, audio, esVideo: false, conAudio: true, tipoMedia: 'imageMessage' };
        const k1 = construirClaveCache(base);
        const k2 = construirClaveCache(base);
        const k3 = construirClaveCache({ ...base, audio: { fileSha256: Buffer.alloc(32, 3) } });
        const k4 = construirClaveCache({ ...base, tipoMedia: 'documentMessage' });
        const k5 = construirClaveCache({ ...base, conAudio: false, audio: null });
        assert.ok(k1, 'debe generar clave');
        assert.strictEqual(k1, k2, 'misma media/audio debe dar la misma clave');
        assert.notStrictEqual(k1, k3, 'audio distinto debe dar clave distinta');
        assert.notStrictEqual(k1, k4, 'tipo distinto debe dar clave distinta');
        assert.notStrictEqual(k1, k5, 'con/sin audio debe dar clave distinta');
        assert.strictEqual(construirClaveCache({ media: {}, conAudio: false }), null, 'sin hash no hay cache');
        assert.strictEqual(construirClaveCache({ media, conAudio: true, audio: null }), null, 'con audio exige hash de audio');
    });

    await probar('serializa Buffers y elimina contextInfo viejo', async () => {
        const original = mensajeSticker();
        original.contextInfo = { stanzaId: 'VIEJO' };
        original.audioMessage.contextInfo = { stanzaId: 'VIEJO-AUDIO' };
        const json = serializarStickerParaCache(original);
        assert.ok(json, 'debe serializar un sticker válido');
        const copia = deserializarStickerCache(json);
        assert.ok(Buffer.isBuffer(copia.mediaKey), 'mediaKey debe volver como Buffer');
        assert.ok(Buffer.isBuffer(copia.audioMessage.waveform), 'waveform debe volver como Buffer');
        assert.strictEqual(copia.audioMessage.waveform.length, 64);
        assert.ok(Buffer.isBuffer(copia.audioMessage.streamingSidecar));
        assert.strictEqual(copia.contextInfo, undefined, 'no debe guardar la cita vieja');
        assert.strictEqual(copia.audioMessage.contextInfo, undefined, 'no debe guardar la cita vieja del audio');
        assert.strictEqual(esStickerCacheValido(copia, true), true);
        assert.strictEqual(esStickerCacheValido({ ...copia, audioMessage: null }, true), false, 'sin audio no vale para clave con audio');
    });

    await probar('enviarStickerPreSubido reemplaza la cita vieja, no la reusa', async () => {
        const { sock, estado } = sockFalso();
        const guardado = mensajeSticker();
        guardado.contextInfo = { stanzaId: 'VIEJO', participant: '999@s.whatsapp.net' };
        const quote = { key: { id: 'NUEVO' }, message: { conversation: 'cita nueva' } };
        const res = await enviarStickerPreSubido(sock, '123@s.whatsapp.net', guardado, quote);
        assert.ok(res, 'debe enviar');
        assert.strictEqual(estado.relay, 1);
        const ctx = estado.capturado?.stickerMessage?.contextInfo;
        assert.ok(ctx, 'debe llevar la cita nueva');
        assert.notStrictEqual(ctx.stanzaId, 'VIEJO', 'no debe conservar la cita vieja');
        assert.ok(estado.capturado.stickerMessage.audioMessage, 'debe conservar audioMessage');
    });

    await probar('persiste en DB y recupera al vaciar la RAM', async () => {
        limpiarCacheMemoriaStickers();
        const filas = new Map();
        const dbFalso = {
            getStickerCache: async (clave) => filas.get(clave) || null,
            saveStickerCache: async (clave, json) => { filas.set(clave, json); return true; },
            deleteStickerCache: async (clave) => filas.delete(clave)
        };
        const clave = 'v1:db:test';
        assert.strictEqual(await guardarStickerCache(clave, mensajeSticker(), dbFalso, { conAudio: true }), true);
        assert.ok(filas.has(clave), 'debe escribir en la DB');
        limpiarCacheMemoriaStickers();
        const recuperado = await obtenerStickerCache(clave, dbFalso, { conAudio: true });
        assert.ok(recuperado, 'debe recuperar desde la DB');
        assert.ok(recuperado.audioMessage, 'debe conservar el audio');
        assert.strictEqual(recuperado.audioMessage.waveform.length, 64);
    });

    await probar('!s cachea audio y el segundo envío no descarga ni convierte', async () => {
        limpiarCacheMemoriaStickers();
        const { sock, estado } = sockFalso();
        const hashImagen = Buffer.alloc(32, 11);
        const hashAudio = Buffer.alloc(32, 12);
        const msg = msgImagenConAudio(hashImagen, hashAudio);
        // La clave se calcula ANTES de enviar: Baileys limpia el contextInfo
        // del mensaje citado al generar el mensaje de salida.
        const clave = construirClaveCache({ media: msg.message.imageMessage, audio: msg.message.imageMessage.contextInfo.quotedMessage.audioMessage, esVideo: false, conAudio: true, tipoMedia: 'imageMessage' });
        assert.ok(clave, 'debe existir clave de cache');
        let descargas = 0;
        let conversiones = 0;
        let audios = 0;
        const extra = {
            downloadMediaMessage: async (m) => {
                descargas++;
                if (m.message?.imageMessage) return Buffer.from('IMAGEN');
                if (m.message?.audioMessage) return Buffer.from('AUDIO');
                throw new Error('descarga inesperada');
            },
            convertirAWebp: async () => { conversiones++; return STICKER; },
            prepararAudioParaSticker: async () => { audios++; return { buffer: Buffer.alloc(4096, 1), segundos: 3, waveform: Buffer.alloc(64, 8) }; }
        };
        await ejecutarSticker(sock, msg, extra);
        assert.strictEqual(estado.relay, 1, 'primer envío por relay');
        assert.strictEqual(descargas, 2, 'primera vez descarga imagen y audio');
        assert.strictEqual(conversiones, 1, 'primera vez convierte');
        assert.strictEqual(audios, 1, 'primera vez prepara audio');
        assert.ok(await obtenerStickerCache(clave, {}), 'debe quedar en cache RAM');
        // Mensaje nuevo e idéntico: no reutilizar el objeto que Baileys ya tocó.
        const segundo = msgImagenConAudio(hashImagen, hashAudio);
        segundo.key = { ...segundo.key, id: 'CACHE2' };
        await ejecutarSticker(sock, segundo, {
            downloadMediaMessage: async () => { throw new Error('no debe descargar en cache hit'); },
            convertirAWebp: async () => { throw new Error('no debe convertir en cache hit'); },
            prepararAudioParaSticker: async () => { throw new Error('no debe preparar audio en cache hit'); }
        });
        assert.strictEqual(estado.relay, 2, 'segundo envío por relay directo');
        assert.strictEqual(descargas, 2, 'no debe volver a descargar');
        assert.strictEqual(conversiones, 1, 'no debe volver a convertir');
        assert.strictEqual(audios, 1, 'no debe volver a preparar audio');
        assert.ok(estado.capturado?.stickerMessage?.audioMessage, 'el hit conserva el sonido');
    });

    await probar('audio distinto no usa el cache del anterior', async () => {
        const { sock, estado } = sockFalso();
        const msg = msgImagenConAudio(Buffer.alloc(32, 11), Buffer.alloc(32, 13));
        let descargas = 0;
        await ejecutarSticker(sock, msg, {
            downloadMediaMessage: async () => { descargas++; return Buffer.from('OTRA'); },
            convertirAWebp: async () => STICKER,
            prepararAudioParaSticker: async () => ({ buffer: Buffer.from('OggSaudio'), segundos: 3, waveform: Buffer.alloc(64, 8) })
        });
        assert.strictEqual(descargas, 2, 'debe procesar porque el audio cambió');
        assert.strictEqual(estado.relay, 1);
    });

    await probar('imagen sin audio cachea el sticker normal', async () => {
        limpiarCacheMemoriaStickers();
        const hashImagen = Buffer.alloc(32, 41);
        const stickerNormal = mensajeSticker({ audio: false });
        const { sock, estado } = sockFalso({ stickerEnviado: { key: { id: 'NORMAL' }, message: { stickerMessage: stickerNormal } } });
        const msg = msgImagenSinAudio(hashImagen);
        const clave = construirClaveCache({ media: msg.message.imageMessage, esVideo: false, conAudio: false, tipoMedia: 'imageMessage' });
        let descargas = 0;
        await ejecutarSticker(sock, msg, {
            downloadMediaMessage: async () => { descargas++; return Buffer.from('IMAGEN'); },
            convertirAWebp: async () => STICKER,
            prepararAudioParaSticker: async () => null
        });
        assert.strictEqual(estado.enviados.length, 1, 'primer envío normal');
        assert.strictEqual(estado.relay, 0);
        assert.strictEqual(descargas, 1);
        assert.ok(await obtenerStickerCache(clave, {}, { conAudio: false }), 'sticker normal queda cacheado');
        const segundo = msgImagenSinAudio(hashImagen);
        segundo.key.id = 'SINAUDIO2';
        await ejecutarSticker(sock, segundo, {
            downloadMediaMessage: async () => { throw new Error('no debe descargar imagen en cache hit'); },
            convertirAWebp: async () => { throw new Error('no debe convertir imagen en cache hit'); },
            prepararAudioParaSticker: async () => null
        });
        assert.strictEqual(estado.relay, 1, 'segundo envío por relay directo');
        assert.strictEqual(descargas, 1);
    });

    await probar('video con audio reusa cache y no vuelve a descargar', async () => {
        limpiarCacheMemoriaStickers();
        const { sock, estado } = sockFalso();
        const hashVideo = Buffer.alloc(32, 31);
        const crearVideo = () => ({
            key: { remoteJid: '123@s.whatsapp.net', id: 'VIDEO1', fromMe: false },
            message: { videoMessage: { mimetype: 'video/mp4', seconds: 4, fileLength: 2000, fileSha256: hashVideo } }
        });
        const msg = crearVideo();
        const clave = construirClaveCache({ media: msg.message.videoMessage, esVideo: true, conAudio: true, tipoMedia: 'videoMessage' });
        let descargas = 0;
        let conversiones = 0;
        let audios = 0;
        await ejecutarSticker(sock, msg, {
            downloadMediaMessage: async () => { descargas++; return Buffer.from('VIDEO'); },
            convertirAWebp: async () => { conversiones++; return STICKER; },
            prepararAudioParaSticker: async () => { audios++; return { buffer: Buffer.alloc(4096, 1), segundos: 4, waveform: Buffer.alloc(64, 8) }; }
        });
        assert.strictEqual(estado.relay, 1);
        assert.strictEqual(descargas, 1, 'video se descarga una vez');
        assert.strictEqual(conversiones, 1);
        assert.strictEqual(audios, 1);
        assert.ok(await obtenerStickerCache(clave, {}, { conAudio: true }), 'video queda cacheado con audio');
        await ejecutarSticker(sock, crearVideo(), {
            downloadMediaMessage: async () => { throw new Error('no debe descargar video en cache hit'); },
            convertirAWebp: async () => { throw new Error('no debe convertir video en cache hit'); },
            prepararAudioParaSticker: async () => { throw new Error('no debe preparar audio en cache hit'); }
        });
        assert.strictEqual(estado.relay, 2, 'segundo video por relay directo');
        assert.strictEqual(descargas, 1);
        assert.strictEqual(conversiones, 1);
        assert.strictEqual(audios, 1);
    });

    await probar('audio fallido no envenena la clave con audio', async () => {
        limpiarCacheMemoriaStickers();
        const { sock, estado } = sockFalso();
        const hashVideo = Buffer.alloc(32, 21);
        const msg = {
            key: { remoteJid: '123@s.whatsapp.net', id: 'MUDO', fromMe: false },
            message: { videoMessage: { mimetype: 'video/mp4', seconds: 3, fileLength: 1000, fileSha256: hashVideo } }
        };
        await ejecutarSticker(sock, msg, {
            downloadMediaMessage: async () => Buffer.from('VIDEO'),
            convertirAWebp: async () => STICKER,
            prepararAudioParaSticker: async () => null
        });
        assert.strictEqual(estado.enviados.length, 1, 'debe caer al sticker normal');
        const clave = construirClaveCache({ media: msg.message.videoMessage, esVideo: true, conAudio: true, tipoMedia: 'videoMessage' });
        assert.strictEqual(await obtenerStickerCache(clave, {}), null, 'no debe guardar un sticker mudo como si tuviera audio');
    });

    await probar('rechaza URLs de media vencidas y acepta las vigentes', async () => {
        const vencido = mensajeSticker();
        vencido.url = 'https://mmg.whatsapp.net/d/f/sticker?oe=00000000';
        assert.strictEqual(esStickerCacheValido(vencido, true), false, 'oe vencido debe rechazarse');
        const vigente = mensajeSticker();
        vigente.url = 'https://mmg.whatsapp.net/d/f/sticker?oe=' + Math.floor(Date.now() / 1000 + 3600).toString(16);
        assert.strictEqual(esStickerCacheValido(vigente, true), true, 'oe futuro debe aceptarse');
        const audioVencido = mensajeSticker();
        audioVencido.audioMessage.url = 'https://mmg.whatsapp.net/d/f/audio?oe=00000000';
        assert.strictEqual(esStickerCacheValido(audioVencido, true), false, 'audio vencido debe rechazarse');
    });

    await probar('cache viejo inválido no se devuelve y limpia la DB', async () => {
        limpiarCacheMemoriaStickers();
        const clave = 'invalida';
        const guardado = await guardarStickerCache(clave, { url: 'https://x', directPath: '/x' }, {});
        assert.strictEqual(guardado, false, 'no debe guardar un sticker sin metadatos de subida');
        assert.strictEqual(await obtenerStickerCache(clave, {}), null);

        // Entrada vencida ya presente en DB: debe borrar la fila zombie en Turso
        const borrados = [];
        let dbReads = 0;
        const vencido = mensajeSticker();
        vencido.url = 'https://mmg.whatsapp.net/d/f/sticker?oe=00000000';
        const claveExp = 'v1:expirada:test';
        const expJson = JSON.stringify(vencido, require('@whiskeysockets/baileys').BufferJSON.replacer);
        const dbMock = {
            getStickerCache: async () => { dbReads++; return expJson; },
            deleteStickerCache: async (k) => { borrados.push(k); return true; }
        };
        limpiarCacheMemoriaStickers();
        assert.strictEqual(await obtenerStickerCache(claveExp, dbMock, { conAudio: true }), null);
        assert.strictEqual(dbReads, 1);
        assert.deepStrictEqual(borrados, [claveExp], 'entrada vencida en DB debe borrarse para no re-consultarse');

        // Entrada en RAM que vence con el tiempo: borra DB sin re-leerla
        const porVencer = mensajeSticker();
        porVencer.url = 'https://mmg.whatsapp.net/d/f/sticker?oe=' + Math.floor(Date.now() / 1000 + 120).toString(16);
        await guardarStickerCache('v1:ram:vence', porVencer, null, { conAudio: true });
        const realNow = Date.now;
        try {
            Date.now = () => realNow() + 180000;
            assert.strictEqual(await obtenerStickerCache('v1:ram:vence', dbMock, { conAudio: true }), null);
        } finally {
            Date.now = realNow;
        }
        assert.strictEqual(dbReads, 1, 'RAM vencida no debe re-consultar Turso');
        assert.deepStrictEqual(borrados, [claveExp, 'v1:ram:vence'], 'RAM vencida también limpia Turso');
    });

    await probar('GIF de WhatsApp (gifPlayback) se cachea sin audio en :v:n:', async () => {
        limpiarCacheMemoriaStickers();
        const hashGif = Buffer.alloc(32, 51);
        const stickerNormal = mensajeSticker({ audio: false });
        const { sock, estado } = sockFalso({ stickerEnviado: { key: { id: 'GIF1' }, message: { stickerMessage: stickerNormal } } });
        const crearGif = () => ({
            key: { remoteJid: '123@s.whatsapp.net', id: 'GIFMSG', fromMe: false },
            message: { videoMessage: { mimetype: 'video/mp4', seconds: 3, gifPlayback: true, fileLength: 1500, fileSha256: hashGif } }
        });
        let audioCalls = 0;
        let convCalls = 0;
        await ejecutarSticker(sock, crearGif(), {
            downloadMediaMessage: async () => Buffer.from('GIFMP4'),
            convertirAWebp: async () => { convCalls++; return STICKER; },
            prepararAudioParaSticker: async () => { audioCalls++; return null; }
        });
        assert.strictEqual(audioCalls, 0, 'GIF gifPlayback no debe intentar extraer audio');
        assert.strictEqual(convCalls, 1);
        await ejecutarSticker(sock, crearGif(), {
            downloadMediaMessage: async () => { throw new Error('GIF segundo envío debe usar cache'); },
            convertirAWebp: async () => { throw new Error('GIF segundo envío no debe convertir'); },
            prepararAudioParaSticker: async () => { throw new Error('no debe preparar audio'); }
        });
        assert.strictEqual(estado.relay, 1, 'segundo GIF sale directo por relay');
    });

    await probar('enviarStickerPreSubido no corta por timeout mientras espera en sockProxy de cola', async () => {
        const { sock: baseSock } = sockFalso();
        let envioTerminado = false;
        const queuedSock = {
            ...baseSock,
            _esColaProxy: true,
            relayMessage: async (jid, message, opts) => {
                await new Promise(r => setTimeout(r, 60));
                envioTerminado = true;
                return baseSock.relayMessage(jid, message, opts);
            }
        };
        const res = await enviarStickerPreSubido(queuedSock, '123@s.whatsapp.net', mensajeSticker(), null, { relayTimeoutMs: 20 });
        assert.ok(res && envioTerminado, 'con _esColaProxy debe esperar a la cola sin abortar a los 20ms');

        let falloRaw = false;
        const slowRawSock = {
            ...baseSock,
            relayMessage: async () => { await new Promise(r => setTimeout(r, 60)); }
        };
        try {
            await enviarStickerPreSubido(slowRawSock, '123@s.whatsapp.net', mensajeSticker(), null, { relayTimeoutMs: 20 });
        } catch (e) {
            falloRaw = /timeout/i.test(e.message);
        }
        assert.strictEqual(falloRaw, true, 'sin _esColaProxy sí debe mantener timeout directo');
    });

    console.log(fallos ? `\n❌ ${fallos} test(s) fallaron` : '\n🎉 TEST STICKER CACHE OK');
    process.exitCode = fallos ? 1 : 0;
})().catch(e => { console.error('❌ Error fatal:', e); process.exitCode = 1; });