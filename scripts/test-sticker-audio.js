/**
 * 🧪 Test del sticker con sonido (sin WhatsApp).
 * Uso: node scripts/test-sticker-audio.js
 *
 * Seams:
 *  - enviarStickerConSonido(): el mensaje que se manda por relayMessage lleva
 *    StickerMessage.audioMessage (campo 26) y el AudioMessage se puede decodificar.
 *  - enviarStickerConSonido(): si la subida falla, devuelve null y NO manda nada
 *    (el caller cae al sticker normal).
 *  - extraerAudioSticker(): video con audio -> OGG/Opus; video mudo -> null.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const { proto, getMediaKeys } = require('@whiskeysockets/baileys');
const pkg = require('protobufjs');
const { Reader, Writer } = pkg;
const {
    enviarStickerConSonido,
    prepararAudioParaSticker,
    validarOggOpus,
    calcularWaveformDesdePcm,
    calcularStreamingSidecar,
    dimensionesWebp,
    TAG_AUDIO
} = require('../utils/stickerSonido');
const { extraerAudioSticker } = require('../utils/media');
const { resolverFfmpeg, convertirAWebpBuffer } = require('../utils/stickerProcessor');
const { StickerPool, signAuth, verifyAuth, encodeFrame, decodeFrame } = require('../utils/stickerPool');
const { execute } = require('../commands/main');

const RAIZ = path.join(__dirname, '..');
const STICKER = path.join(RAIZ, 'sticker_bienvenida.webp');
const FFMPEG = resolverFfmpeg(process.env.FFMPEG_PATH);
const TIENE_FFMPEG = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;

function leerAudioDelMensaje(message) {
    const buf = proto.Message.encode(message).finish();
    const r = Reader.create(buf);
    while (r.pos < r.len) {
        const tag = r.uint32();
        if ((tag >>> 3) !== (TAG_AUDIO >>> 3)) { r.skipType(tag & 7); continue; }
        const len = r.uint32();
        const subBuf = r.buf.subarray(r.pos, r.pos + len);
        r.pos += len;
        const sub = Reader.create(subBuf);
        while (sub.pos < sub.len) {
            const t = sub.uint32();
            if ((t >>> 3) !== (TAG_AUDIO >>> 3)) { sub.skipType(t & 7); continue; }
            const l = sub.uint32();
            const audio = proto.Message.AudioMessage.decode(subBuf.subarray(sub.pos, sub.pos + l));
            sub.pos += l;
            return audio;
        }
    }
    return null;
}

function sockFalso({ fallaUpload = false } = {}) {
    const estado = { relay: 0, capturado: null, enviados: [] };
    const sock = {
        user: { id: '123@s.whatsapp.net' },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        waUploadToServer: async () => {
            if (fallaUpload) throw new Error('upload simulado falló');
            return { mediaUrl: 'https://mmg.whatsapp.net/d/fake', directPath: '/v/t62.7118-24/fake' };
        },
        relayMessage: async (jid, message) => {
            estado.relay++;
            estado.capturado = message;
            return 'MSGID';
        },
        sendMessage: async (jid, content, opts) => {
            estado.enviados.push({ jid, content, opts });
            return { key: { id: 'SENDID' } };
        }
    };
    return { sock, estado };
}

(async () => {
    let fallos = 0;
    const probar = async (nombre, fn) => {
        try { await fn(); console.log(`✅ ${nombre}`); }
        catch (e) { fallos++; console.error(`❌ ${nombre}\n   ${e.message}`); }
    };

    await probar('el sticker con audio se serializa con el campo 26', async () => {
        const { sock, estado } = sockFalso();
        const res = await enviarStickerConSonido(sock, '123@s.whatsapp.net', fs.readFileSync(STICKER), Buffer.alloc(4096, 1), null);
        assert.ok(res, 'debe devolver el mensaje generado');
        assert.strictEqual(estado.relay, 1, 'debe llamar relayMessage una vez');
        assert.ok(estado.capturado?.stickerMessage?.audioMessage, 'audioMessage debe seguir pegado antes de serializar');
        const audio = leerAudioDelMensaje(estado.capturado);
        assert.ok(audio, 'el campo 26 debe existir en los bytes');
        assert.strictEqual(audio.ptt, true, 'debe ir marcado como ptt');
        assert.ok(String(audio.mimetype).includes('opus'), 'mimetype debe ser opus');
        assert.ok(audio.url, 'el audio debe tener URL de subida');
    });

    await probar('un sticker entrante con campo 26 recupera el AudioMessage', async () => {
        // El proto estático de rc.9 no conoce el campo 26: al recibir un
        // sticker con sonido real, Message.decode lo descartaba. El wrapper de
        // decode debe reatacharlo sin correrse de offset.
        const entrante = proto.Message.create({
            stickerMessage: {
                url: 'https://mmg/sticker',
                mimetype: 'image/webp',
                audioMessage: {
                    url: 'https://mmg/audio',
                    directPath: '/v/t62/audio',
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt: true,
                    seconds: 6,
                    waveform: Buffer.alloc(64, 9)
                }
            }
        });
        const bytes = proto.Message.encode(entrante).finish();
        const decodificado = proto.Message.decode(bytes);
        assert.ok(decodificado.stickerMessage?.audioMessage, 'audioMessage debe sobrevivir al decode');
        assert.strictEqual(decodificado.stickerMessage.audioMessage.seconds, 6);
        assert.strictEqual(decodificado.stickerMessage.audioMessage.waveform.length, 64);
    });

    await probar('si falla la subida no manda nada y devuelve null', async () => {
        const { sock, estado } = sockFalso({ fallaUpload: true });
        const res = await enviarStickerConSonido(sock, '123@s.whatsapp.net', fs.readFileSync(STICKER), Buffer.alloc(4096, 1), null);
        assert.strictEqual(res, null);
        assert.strictEqual(estado.relay, 0, 'no debe llamar relayMessage');
    });

    await probar('extraerAudioSticker saca Opus de un video con audio y null si es mudo', async () => {
        if (!TIENE_FFMPEG) {
            console.log('   (saltado: ffmpeg no está disponible)');
            return;
        }
        const ffmpeg = FFMPEG;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-audio-test-'));
        const conAudio = path.join(dir, 'con-audio.mp4');
        const mudo = path.join(dir, 'mudo.mp4');
        try {
            execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', '-y', conAudio], { windowsHide: true });
            execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '1', '-c:v', 'mpeg4', '-y', mudo], { windowsHide: true });
            const audio = await extraerAudioSticker(fs.readFileSync(conAudio), ffmpeg, 10);
            assert.ok(audio && audio.length > 200, 'debe devolver un OGG con datos');
            assert.strictEqual(audio.subarray(0, 4).toString('latin1'), 'OggS', 'debe ser un contenedor OGG');
            const sinAudio = await extraerAudioSticker(fs.readFileSync(mudo), ffmpeg, 10);
            assert.strictEqual(sinAudio, null, 'un video mudo no debe devolver audio');
        } finally {
            for (const f of [conAudio, mudo]) { try { fs.unlinkSync(f); } catch (e) {} }
            try { fs.rmdirSync(dir); } catch (e) {}
        }
    });

    await probar('!s en video adjunta el audio del propio video', async () => {
        const { sock, estado } = sockFalso();
        const msg = {
            key: { remoteJid: '123@s.whatsapp.net', id: 'VIDEO1', fromMe: false },
            message: { videoMessage: { mimetype: 'video/mp4', seconds: 3, fileLength: 1000 } }
        };
        let maxAudio = null;
        await execute(sock, '123@s.whatsapp.net', msg, [], {
            start: '!s', cmd: '!s', txt: '!s', isGroup: false, sender: '123@s.whatsapp.net', pushName: 'Test',
            botState: {}, db: {}, FFMPEG_PATH: 'ffmpeg',
            downloadMediaMessage: async () => Buffer.from('VIDEO'),
            convertirAWebp: async () => fs.readFileSync(STICKER),
            prepararAudioParaSticker: async (buf, ff, max) => { maxAudio = max; return { buffer: Buffer.from('OggSaudio'), segundos: 3, waveform: Buffer.alloc(40, 9) }; }
        });
        assert.strictEqual(estado.relay, 1, 'debe mandar por relayMessage');
        assert.strictEqual(estado.enviados.length, 0, 'no debe mandar además el sticker normal');
        assert.strictEqual(maxAudio, 6, 'el audio del video se corta a 6s como el sticker');
        const audio = leerAudioDelMensaje(estado.capturado);
        assert.ok(audio, 'el mensaje debe llevar el campo 26');
    });

    await probar('!s en imagen con audio citado descarga imagen y audio por separado', async () => {
        const { sock, estado } = sockFalso();
        const msg = {
            key: { remoteJid: '123@s.whatsapp.net', id: 'IMG1', fromMe: false },
            message: {
                imageMessage: {
                    mimetype: 'image/jpeg', caption: '!s',
                    contextInfo: { quotedMessage: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', seconds: 2 } } }
                }
            }
        };
        const descargas = [];
        let entradaSticker = null;
        let entradaAudio = null;
        await execute(sock, '123@s.whatsapp.net', msg, [], {
            start: '!s', cmd: '!s', txt: '!s', isGroup: false, sender: '123@s.whatsapp.net', pushName: 'Test',
            botState: {}, db: {}, FFMPEG_PATH: 'ffmpeg',
            downloadMediaMessage: async (m) => {
                if (m.message?.imageMessage) { descargas.push('imagen'); return Buffer.from('IMAGEN'); }
                if (m.message?.audioMessage) { descargas.push('audio'); return Buffer.from('AUDIO'); }
                throw new Error('descarga inesperada');
            },
            convertirAWebp: async (buf) => { entradaSticker = buf; return fs.readFileSync(STICKER); },
            prepararAudioParaSticker: async (buf) => { entradaAudio = buf; return { buffer: Buffer.from('OggSaudio'), segundos: 3, waveform: Buffer.alloc(40, 9) }; }
        });
        assert.deepStrictEqual(descargas, ['imagen', 'audio'], 'primero la imagen del mensaje, después el audio citado');
        assert.strictEqual(entradaSticker.toString(), 'IMAGEN');
        assert.strictEqual(entradaAudio.toString(), 'AUDIO');
        assert.strictEqual(estado.relay, 1, 'debe mandar el sticker con sonido');
        assert.ok(leerAudioDelMensaje(estado.capturado), 'el mensaje debe llevar el campo 26');
    });

    await probar('!s sin audio cae al sticker normal', async () => {
        const { sock, estado } = sockFalso();
        const msg = {
            key: { remoteJid: '123@s.whatsapp.net', id: 'VIDEO2', fromMe: false },
            message: { videoMessage: { mimetype: 'video/mp4', seconds: 2, fileLength: 1000 } }
        };
        await execute(sock, '123@s.whatsapp.net', msg, [], {
            start: '!s', cmd: '!s', txt: '!s', isGroup: false, sender: '123@s.whatsapp.net', pushName: 'Test',
            botState: {}, db: {}, FFMPEG_PATH: 'ffmpeg',
            downloadMediaMessage: async () => Buffer.from('VIDEO'),
            convertirAWebp: async () => fs.readFileSync(STICKER),
            prepararAudioParaSticker: async () => null
        });
        assert.strictEqual(estado.relay, 0, 'no debe mandar mensaje con audio');
        assert.strictEqual(estado.enviados.length, 1, 'debe mandar el sticker normal');
        assert.ok(estado.enviados[0].content.sticker, 'el fallback es un sticker');
    });

    await probar('!s en imagen no se bloquea por citar un video largo', async () => {
        const { sock, estado } = sockFalso();
        const msg = {
            key: { remoteJid: '123@s.whatsapp.net', id: 'IMG2', fromMe: false },
            message: {
                imageMessage: {
                    mimetype: 'image/jpeg', caption: '!s',
                    contextInfo: { quotedMessage: { videoMessage: { mimetype: 'video/mp4', seconds: 45, fileLength: 999999 } } }
                }
            }
        };
        await execute(sock, '123@s.whatsapp.net', msg, [], {
            start: '!s', cmd: '!s', txt: '!s', isGroup: false, sender: '123@s.whatsapp.net', pushName: 'Test',
            botState: {}, db: {}, FFMPEG_PATH: 'ffmpeg',
            downloadMediaMessage: async () => Buffer.from('IMAGEN'),
            convertirAWebp: async () => fs.readFileSync(STICKER),
            prepararAudioParaSticker: async () => { throw new Error('no debe extraer audio de un video citado'); }
        });
        assert.strictEqual(estado.enviados.length, 1, 'debe mandar el sticker de la imagen');
        assert.ok(estado.enviados[0].content.sticker, 'no debe responder con el aviso de video largo');
    });

    // REGRESIÓN del "toco el sticker y sale error al reproducir": el
    // audioMessage embebido debe llevar seconds >= 1 y waveform (64 bytes),
    // igual que toda nota de voz de WhatsApp. Antes Baileys dejaba waveform
    // fuera (audio-decode no instalado) y el cliente no reproducía el sonido.
    await probar('audio embebido lleva seconds y waveform reales (regresión tap-error)', async () => {
        if (!TIENE_FFMPEG) {
            console.log('   (saltado: ffmpeg no está disponible)');
            return;
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk_reg_'));
        const video = path.join(dir, 'v.mp4');
        execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=256x256:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-y', video], { stdio: 'pipe' });
        try {
            const info = await prepararAudioParaSticker(fs.readFileSync(video), FFMPEG, 6);
            assert.ok(info && info.buffer.length > 100, 'extrae OGG');
            assert.ok(info.segundos >= 1 && info.segundos <= 6.5, 'segundos reales, fue ' + info.segundos);
            assert.ok(info.waveform && info.waveform.length === 64, 'waveform 64 bytes (una muestra 0-100 por byte), fue ' + (info.waveform && info.waveform.length));
            assert.ok([...info.waveform].every(v => v >= 0 && v <= 100), 'cada muestra de waveform debe estar entre 0 y 100');
            // E2E: el mensaje final lleva esos campos dentro del campo 26.
            const { sock, estado } = sockFalso();
            await enviarStickerConSonido(sock, '123@s.whatsapp.net', fs.readFileSync(STICKER), info, null, FFMPEG);
            const audio = leerAudioDelMensaje(estado.capturado);
            assert.ok(audio, 'el mensaje lleva el campo 26');
            assert.ok(Number(audio.seconds) >= 1, 'seconds >= 1, fue ' + audio.seconds);
            assert.ok(audio.waveform && audio.waveform.length === 64, 'waveform embebido de 64 bytes');
        } finally {
            try { fs.unlinkSync(video); } catch (e) {}
            try { fs.rmdirSync(dir); } catch (e) {}
        }
    });

    // REGRESION: video largo ya NO da error, se convierte con los primeros
    // segundos (el -t 6 del encode recorta; antes: 'El video es demasiado largo').
    await probar('!s en video de 45s no da error y lo convierte igual', async () => {
        const { sock, estado } = sockFalso();
        const msg = {
            key: { remoteJid: '123@s.whatsapp.net', id: 'VIDEOLARGO', fromMe: false },
            message: { videoMessage: { mimetype: 'video/mp4', seconds: 45, fileLength: 5000 } }
        };
        await execute(sock, '123@s.whatsapp.net', msg, [], {
            start: '!s', cmd: '!s', txt: '!s', isGroup: false, sender: '123@s.whatsapp.net', pushName: 'Test',
            botState: {}, db: {}, FFMPEG_PATH: 'ffmpeg',
            downloadMediaMessage: async () => Buffer.from('VIDEO'),
            convertirAWebp: async () => fs.readFileSync(STICKER),
            prepararAudioParaSticker: async () => ({ buffer: Buffer.from('OggSaudio'), segundos: 6, waveform: Buffer.alloc(64, 9) })
        });
        assert.strictEqual(estado.relay, 1, 'debe mandar el sticker con sonido');
        assert.ok(!estado.enviados.some(m => String(m.content?.text || '').includes('demasiado largo')), 'no debe avisar de video largo');
    });

    // REGRESION del 'no se pudo reproducir el sonido': audio mudo mandaba
    // waveform null; ahora lleva una waveform minima plana SIEMPRE.
    await probar('audio mudo lleva waveform plana (no null)', async () => {
        if (!TIENE_FFMPEG) {
            console.log('   (saltado: ffmpeg no está disponible)');
            return;
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk_mudo_'));
        const ogg = path.join(dir, 'mudo.ogg');
        execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '2', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', '-y', ogg], { stdio: 'pipe' });
        try {
            const info = await prepararAudioParaSticker(fs.readFileSync(ogg), FFMPEG, 6);
            assert.ok(info && info.buffer.length > 100, 'extrae OGG');
            assert.ok(info.waveform && info.waveform.length === 64, 'waveform de 64 bytes aun siendo mudo, fue ' + (info.waveform && info.waveform.length));
        } finally {
            try { fs.unlinkSync(ogg); } catch (e) {}
            try { fs.rmdirSync(dir); } catch (e) {}
        }
    });

    await probar('sticker anidado en quotedMessage/ephemeral recupera campo 26 al decodificar', async () => {
        const anidado = proto.Message.create({
            ephemeralMessage: {
                message: {
                    extendedTextMessage: {
                        text: 'x'.repeat(200),
                        contextInfo: {
                            quotedMessage: {
                                stickerMessage: {
                                    url: 'https://mmg/s',
                                    mimetype: 'image/webp',
                                    audioMessage: {
                                        url: 'https://mmg/a',
                                        directPath: '/v/t62/a',
                                        mimetype: 'audio/ogg; codecs=opus',
                                        ptt: true,
                                        seconds: 5,
                                        waveform: Buffer.alloc(64, 12)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
        const bytes = proto.Message.encode(anidado).finish();
        const dec = proto.Message.decode(bytes);
        const qStk = dec.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage;
        assert.ok(qStk?.audioMessage, 'audioMessage debe recuperarse dentro de sticker anidado');
        assert.strictEqual(qStk.audioMessage.seconds, 5);
    });

    await probar('campo top-level 134 (audioStickerMessage) se desenvuelve a stickerMessage al decodificar', async () => {
        const innerMsg = proto.Message.encode(proto.Message.create({
            stickerMessage: {
                url: 'https://mmg/s134',
                mimetype: 'image/webp',
                audioMessage: {
                    url: 'https://mmg/a134',
                    directPath: '/v/t62/a134',
                    mimetype: 'audio/ogg; codecs=opus',
                    seconds: 4
                }
            }
        })).finish();
        const fpBytes = Writer.create().uint32((1 << 3) | 2).bytes(innerMsg).finish();
        const topBytes = Writer.create().uint32((134 << 3) | 2).bytes(fpBytes).finish();
        const dec = proto.Message.decode(topBytes);
        assert.ok(dec.stickerMessage, 'debe exponer stickerMessage desde campo 134');
        assert.ok(dec.stickerMessage.audioMessage, 'debe recuperar audioMessage dentro de campo 134');
        assert.strictEqual(dec.stickerMessage.audioMessage.seconds, 4);
    });

    await probar('subida nunca lee el archivo cifrado antes de que Baileys lo termine de escribir', async () => {
        const { sock, estado } = sockFalso();
        let verificaciones = 0;
        sock.waUploadToServer = async (filePath, { fileEncSha256B64 }) => {
            const bytes = fs.readFileSync(filePath);
            const hash = crypto.createHash('sha256').update(bytes).digest('base64');
            assert.strictEqual(hash, fileEncSha256B64, 'el archivo cifrado en disco debe estar completo antes de subirlo');
            verificaciones++;
            return { mediaUrl: 'https://mmg.whatsapp.net/d/ok', directPath: '/v/t62/ok' };
        };
        const stickerBuf = fs.readFileSync(STICKER);
        const audioBuf = Buffer.alloc(15000, 7);
        for (let i = 0; i < 8; i++) {
            const res = await enviarStickerConSonido(sock, '123@s.whatsapp.net', stickerBuf, {
                buffer: audioBuf,
                segundos: 4,
                waveform: Buffer.alloc(64, 25)
            }, null);
            assert.ok(res, 'envio #' + i + ' debe completar');
        }
        assert.strictEqual(verificaciones, 16, 'las 16 subidas deben recibir el archivo cifrado integro');
        assert.strictEqual(estado.relay, 8);
    });

    await probar('stickerMessage y audioMessage llevan metadatos y streamingSidecar validos', async () => {
        const { sock, estado } = sockFalso();
        let ultimoEncAudio = null;
        sock.waUploadToServer = async (filePath, { mediaType }) => {
            if (mediaType === 'audio') ultimoEncAudio = fs.readFileSync(filePath);
            return { mediaUrl: 'https://mmg.whatsapp.net/d/ok', directPath: '/v/t62/ok' };
        };
        const stickerBuf = fs.readFileSync(STICKER);
        const res = await enviarStickerConSonido(sock, '123@s.whatsapp.net', stickerBuf, {
            buffer: Buffer.alloc(4096, 3),
            segundos: 3,
            waveform: Buffer.alloc(64, 42)
        }, null);
        assert.ok(res, 'debe enviar el mensaje');
        const dimsEsperadas = dimensionesWebp(stickerBuf);
        const stk = estado.capturado.stickerMessage;
        assert.strictEqual(stk.width, dimsEsperadas.width, 'width debe coincidir con el WebP');
        assert.strictEqual(stk.height, dimsEsperadas.height, 'height debe coincidir con el WebP');
        assert.strictEqual(stk.isAnimated, false, 'sticker_bienvenida es estatico');
        assert.ok(Number(stk.stickerSentTs) > 0, 'stickerSentTs debe ir presente');
        const audio = leerAudioDelMensaje(estado.capturado);
        assert.ok(audio.streamingSidecar && audio.streamingSidecar.length === 10, 'streamingSidecar de 10 bytes para <64KB');
        const { iv, macKey } = await getMediaKeys(audio.mediaKey, 'audio');
        const esperadoSidecar = crypto.createHmac('sha256', macKey).update(iv).update(ultimoEncAudio).digest().subarray(0, 10);
        assert.deepStrictEqual(Buffer.from(audio.streamingSidecar), esperadoSidecar, 'streamingSidecar debe coincidir con HMAC(macKey, iv + enc)');
    });

    await probar('validarOggOpus rechaza OGG sin frames de audio y acepta OGG/Opus valido', () => {
        assert.strictEqual(typeof validarOggOpus, 'function', 'debe exportar validarOggOpus');
        const crearPaginaOgg = (payload) => {
            const hdr = Buffer.alloc(28, 0);
            hdr.write('OggS', 0, 'latin1');
            hdr[26] = 1;
            hdr[27] = payload.length;
            return Buffer.concat([hdr, payload]);
        };
        const soloCabeceras = Buffer.concat([
            crearPaginaOgg(Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(30, 0)])),
            crearPaginaOgg(Buffer.concat([Buffer.from('OpusTags'), Buffer.alloc(120, 0)]))
        ]);
        assert.strictEqual(validarOggOpus(soloCabeceras), false, 'OGG sin pagina de audio no es reproducible');
        const valido = Buffer.concat([soloCabeceras, crearPaginaOgg(Buffer.alloc(60, 1))]);
        assert.strictEqual(validarOggOpus(valido), true, 'OGG con 3+ paginas y OpusHead es valido');
        assert.strictEqual(validarOggOpus(valido.subarray(0, valido.length - 5)), false, 'OGG truncado debe rechazarse');
        assert.strictEqual(typeof calcularWaveformDesdePcm, 'function', 'debe exportar calcularWaveformDesdePcm');
        assert.strictEqual(calcularWaveformDesdePcm(Buffer.alloc(100)), null, 'menos de 160 muestras (<20ms) devuelve null');
        const wf = calcularWaveformDesdePcm(Buffer.alloc(3200, 1));
        assert.ok(wf && wf.length === 64, 'devuelve waveform de 64 bytes');
        assert.strictEqual(typeof calcularStreamingSidecar, 'function', 'debe exportar calcularStreamingSidecar');
        assert.strictEqual(typeof dimensionesWebp, 'function', 'debe exportar dimensionesWebp');
    });

    await probar('encodeFrame/decodeFrame sin Base64 y firma HMAC anti-replay', () => {
        const b1 = Buffer.from([1, 2, 3, 4, 5]);
        const b2 = Buffer.from([9, 8, 7]);
        const frame = encodeFrame({ type: 'job', id: 'j1', esVideo: true }, [b1, b2]);
        const dec = decodeFrame(frame);
        assert.strictEqual(dec.meta.id, 'j1');
        assert.deepStrictEqual(Buffer.from(dec.buffers[0]), b1);
        assert.deepStrictEqual(Buffer.from(dec.buffers[1]), b2);

        const now = 1700000000000;
        const secret = 'secreto-test';
        const sig = signAuth(secret, now);
        assert.strictEqual(verifyAuth(secret, now, sig, now + 5000), true);
        assert.strictEqual(verifyAuth(secret, now - 300000, signAuth(secret, now - 300000), now), false, 'firma expirada debe fallar');
        assert.strictEqual(verifyAuth(secret, now, 'deadbeef', now), false, 'firma manipulada debe fallar');
    });

    await probar('StickerPool combina PC (WebSocket) + Render local bajo rafaga y hace fallback si PC cae', async () => {
        const secret = 'test-secret-pool';
        let hechosEnLocal = 0;
        const pool = new StickerPool({
            maxLocal: 2,
            maxQueue: 50,
            workerJobTimeoutMs: 5000,
            getSecret: () => secret,
            localRunner: async ({ buffer }) => {
                await new Promise(r => setTimeout(r, 30));
                hechosEnLocal++;
                return { stiker: Buffer.concat([Buffer.from('LOCAL:'), buffer.subarray(0, 4)]), audio: null };
            }
        });
        const srv = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
        pool.attachServer(srv, { wsPath: '/ws/worker' });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        const port = srv.address().port;

        // 1. Conexión no autenticada debe ser rechazada
        await assert.rejects(
            () => new Promise((resolve, reject) => {
                const badWs = new WebSocket(`ws://127.0.0.1:${port}/ws/worker?ts=${Date.now()}&sig=bad`);
                badWs.on('open', () => { badWs.close(); resolve('opened'); });
                badWs.on('error', reject);
                badWs.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
            }),
            /HTTP 401/
        );

        // 2. Worker PC autenticado con concurrencia = 3
        const ts = Date.now();
        const pcWs = new WebSocket(`ws://127.0.0.1:${port}/ws/worker?ts=${ts}&sig=${signAuth(secret, ts)}&name=ryzen&concurrency=3`);
        await new Promise((resolve, reject) => {
            pcWs.on('open', resolve);
            pcWs.on('error', reject);
        });
        pcWs.on('message', async (data, isBinary) => {
            if (!isBinary) return;
            const { meta, buffers } = decodeFrame(data);
            await new Promise(r => setTimeout(r, 20));
            const out = Buffer.concat([Buffer.from('PC:'), buffers[0].subarray(0, 4)]);
            pcWs.send(encodeFrame({ type: 'result', id: meta.id, ok: true, audioSegundos: 0 }, [out, Buffer.alloc(0), Buffer.alloc(0)]), { binary: true });
        });
        // Esperar registro del hello
        await new Promise(r => setTimeout(r, 30));

        // 3. Ráfaga de 14 peticiones simultáneas -> PC (3) + Render (2) + cola (9), 0 rechazadas
        const resultados = await Promise.all(
            Array.from({ length: 14 }, (_, i) => pool.procesarSticker({
                descargarMedia: async () => Buffer.from(`img_${i}_payload`),
                esVideo: false,
                necesitaAudio: false,
                fallbackConvertir: async () => null
            }))
        );
        assert.strictEqual(resultados.filter(r => r.stiker && r.stiker.length > 0).length, 14, 'todos los 14 stickers deben completarse');
        const st = pool.getStats();
        assert.ok(st.donePc > 0 && st.doneLocal > 0, `debe combinar PC (${st.donePc}) y Render (${st.doneLocal})`);

        // 4. Fallback si PC se cae en mitad del trabajo
        pcWs.removeAllListeners('message');
        pcWs.on('message', () => { pcWs.terminate(); });
        const fallbackRes = await pool.procesarSticker({
            descargarMedia: async () => Buffer.from('cae_pc_123'),
            esVideo: false,
            necesitaAudio: false,
            fallbackConvertir: async () => null
        });
        assert.ok(fallbackRes.stiker && fallbackRes.stiker.toString().startsWith('LOCAL:'), 'si PC cae, Render completa el sticker');
        assert.strictEqual(pool.getStats().fallbacks, 1);

        pool.close();
        await new Promise(r => srv.close(r));
    });

    await probar('!s acepta rafaga simultanea de 15 peticiones de un mismo usuario sin rechazar por cola', async () => {
        const pool = new StickerPool({
            maxLocal: 3,
            maxQueue: 100,
            localRunner: async ({ buffer }) => ({ stiker: Buffer.from('WEBP_OK_' + buffer.toString()), audio: null })
        });
        const enviados = [];
        const sock = {
            sendMessage: async (_jid, payload) => { enviados.push(payload); return { key: { id: 'k' } }; }
        };
        const trabajos = Array.from({ length: 15 }, (_, i) => execute(sock, 'grp@g.us', {
            key: { id: 'm_' + i },
            message: { imageMessage: { mimetype: 'image/jpeg', caption: '!s' } }
        }, [], {
            start: '!s', cmd: '!s', txt: '!s', isGroup: true, sender: 'u1@s.whatsapp.net', pushName: 'U',
            downloadMediaMessage: async (m) => Buffer.from(m.key.id),
            convertirAWebp: async (b) => b,
            extraerAudioSticker: async () => null,
            prepararAudioParaSticker: async () => null,
            stickerPool: pool,
            FFMPEG_PATH: FFMPEG, botState: {}, db: {}
        }));
        await Promise.all(trabajos);
        const stickersOk = enviados.filter(e => Buffer.isBuffer(e.sticker));
        assert.strictEqual(stickersOk.length, 15, 'ninguno de los 15 !s concurrentes debe ser rechazado');
    });

    await probar('index.js exime !s y !sticker de cooldowns, antiSpam y semaforo global', () => {
        const idxSrc = fs.readFileSync(path.join(RAIZ, 'index.js'), 'utf8');
        assert.ok(idxSrc.includes("UNLIMITED_STICKER_CMDS = new Set(['!s', '!sticker'])"), 'debe definir UNLIMITED_STICKER_CMDS');
        const heavyMatch = idxSrc.match(/const heavyCmds = \[([^\]]+)\]/);
        assert.ok(heavyMatch && !heavyMatch[1].includes("'!s'") && !heavyMatch[1].includes("'!sticker'"), '!s y !sticker fuera de heavyCmds');
        assert.ok(idxSrc.includes('!esStickerIlimitado'), 'debe eximir !s/!sticker en antiSpam / dupCmd / cooldown global');
        assert.ok(idxSrc.includes('!esStickerCmd'), '!s debe usar carril independiente de adquirirSlotMensaje');
    });

    if (TIENE_FFMPEG) {
        await probar('convertirAWebpBuffer convierte imagen real de forma asincrona con exif', async () => {
            const img = fs.readFileSync(STICKER);
            const out = await convertirAWebpBuffer(img, false, { ffmpegPath: FFMPEG });
            assert.ok(out && out.length > 20, 'debe producir un webp valido');
        });

        await probar('convertirAWebpBuffer convierte video real a WebP animado (FFmpeg 5.x/9.x)', async () => {
            const { esWebpAnimado } = require('../utils/media');
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-vid-test-'));
            const vidPath = path.join(dir, 'clip.mp4');
            try {
                execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=12', '-t', '1', '-c:v', 'mpeg4', '-y', vidPath], { windowsHide: true });
                const out = await convertirAWebpBuffer(fs.readFileSync(vidPath), true, { ffmpegPath: FFMPEG, videoThreads: 2 });
                assert.ok(out && out.length > 100, 'debe producir WebP animado valido');
                assert.strictEqual(esWebpAnimado(out), true, 'el WebP de video debe conservar animacion');
            } finally {
                try { fs.unlinkSync(vidPath); } catch (_) { }
                try { fs.rmdirSync(dir); } catch (_) { }
            }
        });
    }

    console.log(fallos === 0 ? '\n🎉 TEST STICKER SONIDO OK' : `\n💥 TEST STICKER SONIDO: ${fallos} fallo(s)`);
    process.exit(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });