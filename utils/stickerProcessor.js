'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { esBufferAnimado, esWebpAnimado, esMp4, extParaBuffer, primerFrameWebp } = require('./media');
const { agregarExifSticker } = require('./stickerExif');
const { prepararAudioParaSticker } = require('./stickerSonido');

const execFileAsync = promisify(execFile);

// 0 = sin tope de duración: el sticker dura lo que el video. Lo que sí se
// respeta siempre es el tope de tamaño de WhatsApp (se baja escala/fps).
function leerTopeSegundos() {
    const raw = process.env.STICKER_MAX_SEGUNDOS;
    if (raw === undefined || String(raw).trim() === '') return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
}
const STICKER_MAX_SEGUNDOS = leerTopeSegundos();
const STICKER_VIDEO_FPS = 15;
const MAX_STICKER_WEBP_BYTES = 920 * 1024; // Margen bajo el tope de ~1 MB de WhatsApp WebP animado

const PERFILES_VIDEO_PC = [
    { scale: 512, fps: STICKER_VIDEO_FPS, quality: 45, comp: 1 },
    { scale: 320, fps: STICKER_VIDEO_FPS, quality: 35, comp: 2 },
    { scale: 256, fps: 12, quality: 30, comp: 2 }
];
const PERFILES_VIDEO_LOCAL = [
    { scale: 384, fps: STICKER_VIDEO_FPS, quality: 40, comp: 1 },
    { scale: 320, fps: 12, quality: 32, comp: 2 },
    { scale: 256, fps: 10, quality: 28, comp: 2 }
];
// Máxima calidad para PC con CPU de sobra (STICKER_CALIDAD=alta): 512px,
// 20 fps, scaler lanczos y WebP con más calidad. Si el archivo pasa el tope,
// cae a los perfiles siguientes en vez de mandar algo ilegible.
// kbps = KB por segundo medidos en un video 720p cargado. Sirven para elegir
// el perfil de arranque según la duración y evitar reencodear 2-3 veces.
const PERFILES_VIDEO_ALTA = [
    { scale: 512, fps: 15, quality: 78, comp: 4, kbps: 111 },
    { scale: 512, fps: 15, quality: 62, comp: 3, kbps: 89 },
    { scale: 384, fps: 15, quality: 48, comp: 3, kbps: 56 },
    { scale: 320, fps: 12, quality: 36, comp: 2, kbps: 43 },
    { scale: 256, fps: 12, quality: 32, comp: 2, kbps: 27 },
    { scale: 224, fps: 10, quality: 28, comp: 2, kbps: 17 },
    { scale: 192, fps: 8, quality: 24, comp: 2, kbps: 10 }
];

// Sin tope de duración un video de 2-3 minutos no entra en 920 KB ni con el
// último perfil fijo, así que se sigue bajando escala y fps hasta 96px/3fps.
function perfilesAlta() {
    const lista = PERFILES_VIDEO_ALTA.map(p => ({ ...p }));
    while (lista.length < 12) {
        const prev = lista[lista.length - 1];
        const next = {
            scale: Math.max(96, Math.round((prev.scale * 0.8) / 8) * 8),
            fps: Math.max(3, Math.round(prev.fps * 0.8)),
            quality: Math.max(20, prev.quality - 2),
            comp: 2
        };
        if (next.scale === prev.scale && next.fps === prev.fps) break;
        next.kbps = Math.max(2, Math.round(prev.kbps * (next.scale ** 2 * next.fps) / (prev.scale ** 2 * prev.fps)));
        lista.push(next);
    }
    return lista;
}

function perfilInicialAlta(segundos, maxBytes = MAX_STICKER_WEBP_BYTES) {
    if (!(segundos > 0)) return 0;
    const perfiles = perfilesAlta();
    const presupuestoKb = (Number(maxBytes) / 1024) * 0.95;
    for (let i = 0; i < perfiles.length; i++) {
        if (segundos * perfiles[i].kbps <= presupuestoKb) return i;
    }
    return perfiles.length - 1;
}

function calidadAlta(opts = {}) {
    if (opts.calidad) return opts.calidad === 'alta';
    return process.env.STICKER_CALIDAD === 'alta';
}

let _cachedFfmpegPath = null;
const _vsyncArgsCache = new Map();

async function resolverArgsVsync(ffmpegPath) {
    if (_vsyncArgsCache.has(ffmpegPath)) return _vsyncArgsCache.get(ffmpegPath);
    let flag = ['-vsync', '0'];
    try {
        const { stdout } = await execFileAsync(ffmpegPath, ['-version'], { timeout: 3000, windowsHide: true });
        const m = String(stdout || '').match(/ffmpeg version (\d+)\.(\d+)/i);
        if (m) {
            const major = parseInt(m[1], 10);
            // FFmpeg 5.x/6.x soporta -vsync 0; FFmpeg 7/8/9+ requiere -fps_mode passthrough
            if (major >= 7) {
                flag = ['-fps_mode', 'passthrough'];
            }
        }
    } catch (_) { }
    _vsyncArgsCache.set(ffmpegPath, flag);
    return flag;
}

function resolverFfmpeg(preferido = null) {
    if (preferido) return preferido;
    if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
        return process.env.FFMPEG_PATH;
    }
    if (_cachedFfmpegPath) return _cachedFfmpegPath;

    try {
        const inst = require('@ffmpeg-installer/ffmpeg');
        if (inst?.path && fs.existsSync(inst.path)) {
            _cachedFfmpegPath = inst.path;
            return _cachedFfmpegPath;
        }
    } catch (_) { }

    const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of pathEntries) {
        try {
            const candidate = path.join(dir, exe);
            if (fs.existsSync(candidate)) {
                _cachedFfmpegPath = candidate;
                return _cachedFfmpegPath;
            }
        } catch (_) { }
    }

    // En Windows, WinGet instala Gyan.FFmpeg bajo %LOCALAPPDATA%\Microsoft\WinGet\Packages
    // y el shell actual puede conservar un PATH anterior hasta reiniciar sesión.
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        const links = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
        if (fs.existsSync(links)) {
            _cachedFfmpegPath = links;
            return _cachedFfmpegPath;
        }
        const pkgsDir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
        try {
            if (fs.existsSync(pkgsDir)) {
                const dirs = fs.readdirSync(pkgsDir).filter(d => /ffmpeg/i.test(d));
                for (const d of dirs) {
                    const base = path.join(pkgsDir, d);
                    const sub = fs.readdirSync(base);
                    for (const entry of sub) {
                        const direct = path.join(base, entry, 'ffmpeg.exe');
                        const bin = path.join(base, entry, 'bin', 'ffmpeg.exe');
                        if (fs.existsSync(bin)) { _cachedFfmpegPath = bin; return _cachedFfmpegPath; }
                        if (fs.existsSync(direct)) { _cachedFfmpegPath = direct; return _cachedFfmpegPath; }
                    }
                }
            }
        } catch (_) { }
    }

    return 'ffmpeg';
}

async function convertirAWebpBuffer(buffer, isVideo = false, opts = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const ffmpegPath = resolverFfmpeg(opts.ffmpegPath);
    const vfBase = (scale, interp) =>
        `scale=${scale}:${scale}:force_original_aspect_ratio=decrease:flags=${interp},format=rgba,pad=${scale}:${scale}:(ow-iw)/2:(oh-ih)/2:color=white@0,format=yuva420p`;
    const alta = calidadAlta(opts);

    const intentar = async (comoVideo, soloUnFrame = false, bufOverride = null, perfil = null) => {
        const src = bufOverride || buffer;
        const ext = extParaBuffer(src, comoVideo || esMp4(src));
        const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const tmpIn = path.join(os.tmpdir(), `stk_in_${uid}.${ext}`);
        const tmpOut = path.join(os.tmpdir(), `stk_out_${uid}.webp`);
        await fs.promises.writeFile(tmpIn, src);
        try {
            const videoThreads = String(opts.videoThreads || 1);
            const imgThreads = String(opts.imgThreads || 2);
            const esAnimado = comoVideo && !soloUnFrame;
            const vsyncArgs = esAnimado ? await resolverArgsVsync(ffmpegPath) : [];
            const p = perfil || { scale: 512, fps: STICKER_VIDEO_FPS, quality: 45, comp: 1 };
            const maxSeg = Number(opts.maxSegundos ?? STICKER_MAX_SEGUNDOS) > 0
                ? String(Math.floor(Number(opts.maxSegundos ?? STICKER_MAX_SEGUNDOS)))
                : null;
            const interp = alta ? 'lanczos' : 'bilinear';
            const args = esAnimado
                ? ['-threads', videoThreads, '-i', tmpIn, '-vf', `${vfBase(p.scale, interp)},fps=${p.fps}`, '-vcodec', 'libwebp', '-loop', '0', '-preset', 'default', '-an', ...vsyncArgs, ...(maxSeg ? ['-t', maxSeg] : []), '-quality', String(p.quality), '-compression_level', String(p.comp), '-y', tmpOut]
                : ['-threads', imgThreads, '-i', tmpIn, '-vf', vfBase(512, 'lanczos'), ...(soloUnFrame ? ['-vframes', '1'] : []), '-quality', alta ? '90' : '75', '-compression_level', alta ? '5' : '4', '-y', tmpOut];
            await execFileAsync(ffmpegPath, args, { timeout: esAnimado ? 90000 : 25000, windowsHide: true });
            return await fs.promises.readFile(tmpOut);
        } finally {
            await fs.promises.unlink(tmpIn).catch(() => { });
            await fs.promises.unlink(tmpOut).catch(() => { });
        }
    };

    if (esWebpAnimado(buffer)) {
        // ffmpeg no decodifica WebP animado: conservar si ya es válido o extraer primer frame
        try {
            return await agregarExifSticker(buffer);
        } catch (_) {
            const frame = primerFrameWebp(buffer);
            if (frame) {
                try {
                    const webp = await intentar(false, false, frame);
                    return await agregarExifSticker(webp);
                } catch (__) { }
            }
        }
    }

    const animado = isVideo || esBufferAnimado(buffer);
    const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_STICKER_WEBP_BYTES;
    try {
        if (!animado) {
            const webp = await intentar(false, false);
            return await agregarExifSticker(webp);
        }

        const basePerfiles = alta
            ? perfilesAlta()
            : ((Number(opts.videoThreads) || 1) >= 2 ? PERFILES_VIDEO_PC : PERFILES_VIDEO_LOCAL);
        const inicio = alta ? Math.min(perfilInicialAlta(Number(opts.segundos) || 0, maxBytes), basePerfiles.length - 1) : 0;
        if (inicio > 0) {
            console.log(`[Sticker] Video de ${Math.round(Number(opts.segundos))}s: arranco directo en ${basePerfiles[inicio].scale}px/${basePerfiles[inicio].fps}fps.`);
        }
        let ultimo = null;
        for (let i = inicio; i < basePerfiles.length; i++) {
            const perfil = (i === 0 && Number(opts.fps) > 0) ? { ...basePerfiles[i], fps: Number(opts.fps) } : basePerfiles[i];
            const webp = await intentar(true, false, null, perfil);
            const conExif = await agregarExifSticker(webp);
            ultimo = conExif;
            if (!conExif || conExif.length <= maxBytes || i === basePerfiles.length - 1) {
                return conExif;
            }
            const next = basePerfiles[i + 1];
            console.log(`[Sticker] WebP ${Math.round(conExif.length / 1024)}KB > ${Math.round(maxBytes / 1024)}KB, ajustando a ${next.scale}px/${next.fps}fps.`);
        }
        return ultimo;
    } catch (e) {
        try {
            console.warn(`[Sticker] Reintentando (${animado ? 'fallback estatico/alt' : 'animado'}):`, e.message);
            // Si es MP4 y falló animado, conservar extensión mp4 sacando 1 frame en lugar de tratarlo como .png
            const webp2 = esMp4(buffer)
                ? await intentar(true, true)
                : await intentar(!animado, false);
            return await agregarExifSticker(webp2);
        } catch (e2) {
            console.error('❌ [Sticker]', e2.message);
            return null;
        }
    }
}

async function limpiarTemporalesStickers(maxEdadMs = 120000) {
    try {
        const tmpDir = os.tmpdir();
        const ahora = Date.now();
        const files = await fs.promises.readdir(tmpDir);
        let borrados = 0;
        for (const name of files) {
            if (!name.startsWith('stk_')) continue;
            const full = path.join(tmpDir, name);
            try {
                const st = await fs.promises.stat(full);
                if (ahora - st.mtimeMs >= maxEdadMs) {
                    await fs.promises.unlink(full).catch(() => { });
                    borrados++;
                }
            } catch (_) { }
        }
        return borrados;
    } catch (_) {
        return 0;
    }
}

async function procesarStickerCompleto({
    buffer,
    esVideo = false,
    necesitaAudio = false,
    audioBuffer = null,
    ffmpegPath = null,
    parallelAudio = true,
    videoThreads = 1,
    imgThreads = 2,
    calidad = null,
    segundos = 0
}) {
    const ffmpeg = resolverFfmpeg(ffmpegPath);
    const convertir = () => convertirAWebpBuffer(buffer, esVideo, {
        ffmpegPath: ffmpeg,
        videoThreads,
        imgThreads,
        calidad,
        segundos
    });
    const sacarAudio = async () => {
        if (!necesitaAudio) return null;
        try {
            if (audioBuffer && audioBuffer.length) {
                return await prepararAudioParaSticker(audioBuffer, ffmpeg, STICKER_MAX_SEGUNDOS);
            }
            if (esVideo) {
                return await prepararAudioParaSticker(buffer, ffmpeg, STICKER_MAX_SEGUNDOS);
            }
        } catch (e) {
            console.warn('[STICKER] No pude preparar el sonido:', e.message);
        }
        return null;
    };

    if (parallelAudio) {
        const [stiker, audio] = await Promise.all([convertir(), sacarAudio()]);
        return { stiker, audio };
    }

    // Modo secuencial (Render 512MB): evita dos ffmpeg simultáneos compitiendo por RAM
    const stiker = await convertir();
    if (!stiker) return { stiker: null, audio: null };
    const audio = await sacarAudio();
    return { stiker, audio };
}

module.exports = {
    resolverFfmpeg,
    convertirAWebpBuffer,
    procesarStickerCompleto,
    limpiarTemporalesStickers,
    STICKER_MAX_SEGUNDOS,
    STICKER_VIDEO_FPS,
    MAX_STICKER_WEBP_BYTES
};
