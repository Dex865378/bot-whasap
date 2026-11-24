'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { esBufferAnimado, extParaBuffer } = require('./media');
const { agregarExifSticker } = require('./stickerExif');
const { prepararAudioParaSticker } = require('./stickerSonido');

const execFileAsync = promisify(execFile);

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
            const minor = parseInt(m[2], 10);
            // FFmpeg >= 5.1 introdujo -fps_mode passthrough y FFmpeg 8/9 elimino -vsync
            if (major > 5 || (major === 5 && minor >= 1)) {
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
    const vf = 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0,format=yuva420p';

    const intentar = async (comoVideo) => {
        const ext = extParaBuffer(buffer, comoVideo);
        const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const tmpIn = path.join(os.tmpdir(), `stk_in_${uid}.${ext}`);
        const tmpOut = path.join(os.tmpdir(), `stk_out_${uid}.webp`);
        await fs.promises.writeFile(tmpIn, buffer);
        try {
            const videoThreads = String(opts.videoThreads || 1);
            const imgThreads = String(opts.imgThreads || 2);
            const vsyncArgs = comoVideo ? await resolverArgsVsync(ffmpegPath) : [];
            const args = comoVideo
                ? ['-threads', videoThreads, '-i', tmpIn, '-vf', vf.replace('lanczos', 'bilinear') + ',fps=8', '-vcodec', 'libwebp', '-loop', '0', '-preset', 'default', '-an', ...vsyncArgs, '-t', '6', '-quality', '50', '-compression_level', '1', '-y', tmpOut]
                : ['-threads', imgThreads, '-i', tmpIn, '-vf', vf, '-quality', '75', '-compression_level', '4', '-y', tmpOut];
            await execFileAsync(ffmpegPath, args, { timeout: comoVideo ? 30000 : 15000, windowsHide: true });
            return await fs.promises.readFile(tmpOut);
        } finally {
            await fs.promises.unlink(tmpIn).catch(() => { });
            await fs.promises.unlink(tmpOut).catch(() => { });
        }
    };

    const animado = isVideo || esBufferAnimado(buffer);
    try {
        const webp = await intentar(animado);
        return await agregarExifSticker(webp);
    } catch (e) {
        try {
            console.warn(`[Sticker] Reintentando como ${animado ? 'imagen' : 'animado'}:`, e.message);
            const webp2 = await intentar(!animado);
            return await agregarExifSticker(webp2);
        } catch (e2) {
            console.error('❌ [Sticker]', e2.message);
            return null;
        }
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
    imgThreads = 2
}) {
    const ffmpeg = resolverFfmpeg(ffmpegPath);
    const convertir = () => convertirAWebpBuffer(buffer, esVideo, {
        ffmpegPath: ffmpeg,
        videoThreads,
        imgThreads
    });
    const sacarAudio = async () => {
        if (!necesitaAudio) return null;
        try {
            if (audioBuffer && audioBuffer.length) {
                return await prepararAudioParaSticker(audioBuffer, ffmpeg, 10);
            }
            if (esVideo) {
                return await prepararAudioParaSticker(buffer, ffmpeg, 6);
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
    procesarStickerCompleto
};
