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
const { proto } = require('@whiskeysockets/baileys');
const pkg = require('protobufjs');
const { Reader } = pkg;
const { enviarStickerConSonido, prepararAudioParaSticker, TAG_AUDIO } = require('../utils/stickerSonido');
const { extraerAudioSticker } = require('../utils/media');
const { execute } = require('../commands/main');

const RAIZ = path.join(__dirname, '..');
const STICKER = path.join(RAIZ, 'sticker_bienvenida.webp');

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
        const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
        const version = spawnSync(ffmpeg, ['-version'], { windowsHide: true });
        if (version.status !== 0) {
            console.log('   (saltado: ffmpeg no está disponible)');
            return;
        }
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
        const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
        const { execFileSync } = require('child_process');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk_reg_'));
        const video = path.join(dir, 'v.mp4');
        execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=256x256:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-y', video], { stdio: 'pipe' });
        try {
            const info = await prepararAudioParaSticker(fs.readFileSync(video), ffmpeg, 6);
            assert.ok(info && info.buffer.length > 100, 'extrae OGG');
            assert.ok(info.segundos >= 1 && info.segundos <= 6.5, 'segundos reales, fue ' + info.segundos);
            assert.ok(info.waveform && info.waveform.length === 64, 'waveform 64 bytes (una muestra 0-100 por byte), fue ' + (info.waveform && info.waveform.length));
            assert.ok([...info.waveform].every(v => v >= 0 && v <= 100), 'cada muestra de waveform debe estar entre 0 y 100');
            // E2E: el mensaje final lleva esos campos dentro del campo 26.
            const { sock, estado } = sockFalso();
            await enviarStickerConSonido(sock, '123@s.whatsapp.net', fs.readFileSync(STICKER), info, null, ffmpeg);
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
        const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
        const { execFileSync } = require('child_process');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk_mudo_'));
        const ogg = path.join(dir, 'mudo.ogg');
        execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '2', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', '-y', ogg], { stdio: 'pipe' });
        try {
            const info = await prepararAudioParaSticker(fs.readFileSync(ogg), ffmpeg, 6);
            assert.ok(info && info.buffer.length > 100, 'extrae OGG');
            assert.ok(info.waveform && info.waveform.length === 64, 'waveform de 64 bytes aun siendo mudo, fue ' + (info.waveform && info.waveform.length));
        } finally {
            try { fs.unlinkSync(ogg); } catch (e) {}
            try { fs.rmdirSync(dir); } catch (e) {}
        }
    });

    console.log(fallos === 0 ? '\n🎉 TEST STICKER SONIDO OK' : `\n💥 TEST STICKER SONIDO: ${fallos} fallo(s)`);
    process.exit(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });