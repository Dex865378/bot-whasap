/**
 * Metadatos (EXIF) de los stickers que el bot crea.
 *
 * WhatsApp muestra esta info al abrir el sticker: el nombre del pack en
 * negrita y debajo el autor. Ahí va el link del Discord del bot, de modo
 * que cada sticker creado por el bot lo traiga consigo.
 *
 * Se usa node-webpmux (puro JS, sin binarios) igual que hacen los sticker
 * makers probados (wa-sticker-formatter, whatsapp-web.js). Si algo falla,
 * se devuelve el webp sin tocar: el sticker se manda igual, solo pierde
 * el metadato. Nunca tumba el envío.
 */

const LINK_DISCORD = 'discord.gg/bJVq2seCJe';
const NOMBRE_PACK = 'Diky Bot';

let ImageWebp = null;
function getImage() {
    if (!ImageWebp) ImageWebp = require('node-webpmux').Image;
    return ImageWebp;
}

function construirExif(pack, autor) {
    // Estructura TIFF que espera WhatsApp (misma de wa-sticker-formatter):
    // 22 bytes de cabecera + JSON, con el largo del JSON en el offset 14.
    const json = JSON.stringify({
        'sticker-pack-id': 'diky-bot',
        'sticker-pack-name': pack,
        'sticker-pack-publisher': autor,
        emojis: ['']
    });
    const jsonLen = Buffer.byteLength(json, 'utf-8');
    const exif = Buffer.concat([
        Buffer.from([
            0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
            0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00,
            0x00, 0x00
        ]),
        Buffer.from(json, 'utf-8')
    ]);
    exif.writeUIntLE(jsonLen, 14, 4);
    return exif;
}

/**
 * Agrega el pack y el autor al webp. Devuelve el buffer con EXIF, o el
 * original si no se pudo (webp inválido, librería ausente, error).
 */
async function agregarExifSticker(webp, pack = NOMBRE_PACK, autor = LINK_DISCORD) {
    try {
        if (!webp || webp.length < 12) return webp;
        if (webp.slice(0, 4).toString('ascii') !== 'RIFF') return webp;
        const img = new (getImage())();
        await img.load(webp);
        img.exif = construirExif(pack, autor);
        const out = await img.save(null);
        return out && out.length ? out : webp;
    } catch (e) {
        console.warn('[STICKER-EXIF] Sin metadatos (el sticker sale igual):', e.message);
        return webp;
    }
}

module.exports = { agregarExifSticker, construirExif, LINK_DISCORD, NOMBRE_PACK };
