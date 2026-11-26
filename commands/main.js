/**
 * 🏠 MÓDULO PRINCIPAL
 */
const { helpData } = require('./help');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { proto } = require('@whiskeysockets/baileys');
const { esWebpAnimado, primerFrameWebp } = require('../utils/media');
const { enviarStickerConSonido, enviarStickerPreSubido } = require('../utils/stickerSonido');
const { construirClaveCache, obtenerStickerCache, guardarStickerCache, borrarStickerCache } = require('../utils/stickerCache');

function serializarMediaProto(mediaObj, tipoClave) {
    try {
        if (!mediaObj || (!mediaObj.url && !mediaObj.directPath) || !mediaObj.mediaKey) return null;
        return Buffer.from(proto.Message.encode(proto.Message.create({ [tipoClave]: mediaObj })).finish());
    } catch (_) {
        return null;
    }
}

// Portada del menú: configurada con !setportada menu (cacheada en RAM por
// db.getPortada) o la imagen por defecto del bot. Así el menú sale como UN
// solo mensaje: imagen pegada al texto (caption), como hacen los bots.
let _menuDefaultImg = null;
function getMenuDefaultImg() {
    if (_menuDefaultImg) return _menuDefaultImg;
    try {
        const f = path.join(__dirname, '..', 'imagen_bienvenida.png');
        if (fs.existsSync(f)) _menuDefaultImg = fs.readFileSync(f);
    } catch (_) { }
    return _menuDefaultImg;
}

async function enviarMenuConPortada(sock, chatId, msg, db, texto) {
    let img = null;
    try { img = await db.getPortada('menu', chatId); } catch (_) { }
    if (!img) img = getMenuDefaultImg();
    if (img) {
        return sock.sendMessage(chatId, { image: img, caption: texto }, { quoted: msg });
    }
    return sock.sendMessage(chatId, { text: texto }, { quoted: msg });
}

const DOWNLOAD_MEDIA_TIMEOUT_MS = 20000;
function descargarConTimeout(downloadMediaMessage, target, timeoutMs = DOWNLOAD_MEDIA_TIMEOUT_MS) {
    let timer;
    return Promise.race([
        downloadMediaMessage(target, 'buffer', {}),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('download timeout')), timeoutMs);
        })
    ]).finally(() => clearTimeout(timer));
}

const MENU_SECCIONES = [
    {
        id: 'admin',
        aliases: ['administracion', 'grupo', 'grupos', 'mod', 'moderacion'],
        icono: '👑',
        titulo: 'ADMINISTRACIÓN',
        resumen: 'Control del grupo, bienvenida, warns y reglas',
        items: [
            { cmd: '!bot <on/off>', desc: 'Encender o apagar el bot en el grupo.' },
            { cmd: '!adm <on/off>', desc: 'Solo admins pueden usar comandos.' },
            { cmd: '!antispam <on/off>', desc: 'Activar protección anti-spam.' },
            { cmd: '!antifarma <on/off>', desc: 'Tope 5 premios/hora. Off = grupo 100% juego.' },
            { cmd: '!autoadmin', desc: 'El bot intenta hacerse admin solo.' },
            { cmd: '!remoto <id-grupo> bot/adm on/off', desc: 'Control del dueño por privado (antitrampa).' },
            { cmd: '!tag', desc: 'Mencionar a todos los miembros.' },
            { cmd: '!kick', desc: 'Eliminar un usuario del grupo.' },
            { cmd: '!bienvenida <on/off/ver/test>', desc: 'Configurar el mensaje de bienvenida.' },
            { cmd: '!setbienvenida <mensaje>', desc: 'Guardar mensaje personalizado ({usuario}).' },
            { cmd: '!despedida <on/off/ver/test>', desc: 'Mensaje cuando alguien sale del grupo.' },
            { cmd: '!setdespedida <mensaje>', desc: 'Guardar despedida personalizada ({usuario}).' },
            { cmd: '!setportada', desc: 'Portada de ESTE grupo (menú, bienvenida y despedida).' },
            { cmd: '!setsticker', desc: 'Sticker de bienvenida (responde a un sticker).' },
            { cmd: '!reglas', desc: 'Ver o configurar reglas del grupo.' },
            { cmd: '!setreglas <texto> / !borrareglas', desc: 'Reglas propias del grupo (admin).' },
            { cmd: '!fantasmas', desc: 'Sin hablar en los últimos 7 días.' },
            { cmd: '!sorteo', desc: 'Elegir un miembro random del grupo.' },
            { cmd: '!encuesta <preg> | <op1> | <op2>', desc: 'Crear encuesta de WhatsApp.' },
            { cmd: '!warn @usuario [motivo]', desc: 'Advertir (3 = expulsión).' },
            { cmd: '!unwarn / !warns @usuario', desc: 'Quitar o ver advertencias.' },
            { cmd: '!afk [motivo]', desc: 'Marcarse ausente.' },
            { cmd: '!topactivos', desc: 'Ranking de los que más hablan.' },
            { cmd: '!recordar <tiempo> <texto>', desc: 'Aviso futuro (s/m/h/d).' }
        ]
    },
    {
        id: 'social',
        aliases: ['perfil', 'perfiles'],
        icono: '👤',
        titulo: 'PERFIL Y SOCIAL',
        resumen: 'Perfil, nivel, regalos, matrimonio y mascotas',
        items: [
            { cmd: '!perfil', desc: 'Ver tu perfil, nivel y estadísticas.' },
            { cmd: '!config', desc: 'Configurar tu bio, nombre y edad.' },
            { cmd: '!prestigio', desc: 'Ascender al llegar a nivel 500.' },
            { cmd: '!mejor', desc: 'Top global de nivel y riqueza.' },
            { cmd: '!dar <monto> @usuario', desc: 'Regalar diky a otro usuario.' },
            { cmd: '!canjear <monto>', desc: 'Convertir diky en XP.' },
            { cmd: '!marry @usuario / !divorce', desc: 'Matrimonio formal / divorciarse.' },
            { cmd: '!clase', desc: 'Elegir tu profesión.' },
            { cmd: '!inventario', desc: 'Ver tus items y mascotas.' },
            { cmd: '!bounty', desc: 'Ver recompensas activas.' }
        ]
    },
    {
        id: 'mercado',
        aliases: ['subastas', 'subasta', 'shop'],
        icono: '⚖️',
        titulo: 'MERCADO Y SUBASTAS',
        resumen: 'Subastar, ofertar y vender items',
        items: [
            { cmd: '!subastar <item> <precio>', desc: 'Poner un item en subasta.' },
            { cmd: '!subastas', desc: 'Ver subastas activas.' },
            { cmd: '!ofertar <id> <monto>', desc: 'Pujar en una subasta.' },
            { cmd: '!vender <item> / todo', desc: 'Vender items por diky.' }
        ]
    },
    {
        id: 'economia',
        aliases: ['dinero', 'diky', 'eco'],
        icono: '💰',
        titulo: 'ECONOMÍA',
        resumen: 'Daily, trabajo, robo, lotería y tienda',
        items: [
            { cmd: '!daily', desc: 'Recompensa gratis cada 24 horas.' },
            { cmd: '!loteria', desc: 'Participar o ver la lotería.' },
            { cmd: '!w', desc: 'Trabajar (1h de espera).' },
            { cmd: '!slut', desc: 'Ganancia rápida de diky.' },
            { cmd: '!robar', desc: 'Robar 75-250 diky (cada 15 min).' },
            { cmd: '!tienda', desc: 'Ver lista de items en venta.' },
            { cmd: '!comprar <número>', desc: 'Comprar un item de la tienda.' }
        ]
    },
    {
        id: 'casino',
        aliases: ['apuestas', 'apuesta'],
        icono: '🎰',
        titulo: 'CASINO DIKY',
        resumen: 'Blackjack, slots, minas, ruleta y dados',
        items: [
            { cmd: '!bj', desc: 'Jugar Blackjack.' },
            { cmd: '!poker', desc: 'Duelo de dados.' },
            { cmd: '!minas', desc: 'Juego del buscaminas.' },
            { cmd: '!slot', desc: 'Tragamonedas.' },
            { cmd: '!ruleta', desc: 'Ruleta rusa.' },
            { cmd: '!apostar', desc: 'Apostar a rojo o blanco.' },
            { cmd: '!dado / !moneda', desc: 'Lanzar dado o moneda.' },
            { cmd: '!ppt / !pptx', desc: 'Piedra-papel-tijera (clásico / 9 elementos).' }
        ]
    },
    {
        id: 'aventura',
        aliases: ['rpg', 'explorar'],
        icono: '⚔️',
        titulo: 'AVENTURA',
        resumen: 'Minar, pescar, cazar, duelos y pokémon',
        items: [
            { cmd: '!minar', desc: 'Explorar la cueva.' },
            { cmd: '!pescar', desc: 'Probar suerte en el mar.' },
            { cmd: '!cazar', desc: 'Explorar el bosque.' },
            { cmd: '!duelo @usuario', desc: 'Retar a combate a alguien.' },
            { cmd: '!pokemon', desc: 'Atrapar un pokémon.' },
            { cmd: '!puente', desc: 'Cruzar el puente de cristal.' },
            { cmd: '!mazmorra', desc: 'Incursión por salas.' },
            { cmd: '!cofre / !bomba / !carta / !donde', desc: 'Mini-juegos de suerte.' }
        ]
    },
    {
        id: 'juegos',
        aliases: ['juego', 'trivia', 'minijuegos', 'duelos', 'pvp'],
        icono: '🧠',
        titulo: 'JUEGOS Y TRIVIA',
        resumen: 'Trivias, duelos 1v1, bingo, wordle y retos',
        items: [
            { cmd: '!trivia / !quiz / !quizanime', desc: 'Preguntas de trivia y anime.' },
            { cmd: '!adivina', desc: 'Adivinar la palabra oculta.' },
            { cmd: '!matematicas', desc: 'Resolver cálculos contra reloj.' },
            { cmd: '!bandera [pais/provincia/capitales]', desc: 'Adivinar banderas o capitales.' },
            { cmd: '!ahorcado', desc: 'Juego del ahorcado.' },
            { cmd: '!ahorcadoanime', desc: 'Ahorcado solo con nombres de anime.' },
            { cmd: '!sopaletras', desc: 'Sopa de letras de anime, rondas infinitas.' },
            { cmd: '!inglish [1|2|3|reseat]', desc: 'Español→inglés en 5 segundos (1 básico, 2 medio, 3 difícil) o reseat para estudiar escribiendo.' },
            { cmd: '!carrera / !suelten', desc: 'Carreras del grupo.' },
            { cmd: '!ttt @usuario', desc: 'Tres en raya contra alguien.' },
            { cmd: '!pptpvp @usuario', desc: 'Piedra-papel-tijera con mapas secretos.' },
            { cmd: '!c4 @usuario', desc: 'Conecta 4 contra alguien.' },
            { cmd: '!quizduelo @usuario', desc: 'Duelo de preguntas, el más rápido gana.' },
            { cmd: '!bingo', desc: 'Bingo grupal con cartones.' },
            { cmd: '!dados @usuario', desc: 'Duelo de dados, mejor de 5 (!tirar).' },
            { cmd: '!numero @usuario', desc: 'Adivina el secreto 1-100 por turnos.' },
            { cmd: '!mates @usuario', desc: 'Carrera de operaciones, el rápido suma.' },
            { cmd: '!carrera2 @usuario', desc: 'Carrera a 30 pasos (!avanza).' },
            { cmd: '!naval @usuario', desc: 'Batalla naval 5x5 (!fuego B3).' },
            { cmd: '!reflejos', desc: 'Responde al ¡AHORA! (récord).' },
            { cmd: '!maraton', desc: '10 operaciones contra reloj (récord).' },
            { cmd: '!simon', desc: 'Memoria de emojis (récord).' },
            { cmd: '!hongbao @ana @luis', desc: 'Sobre rojo, reclama con !abrir.' },
            { cmd: '!mentiroso @usuario', desc: 'Dados con apuesta (!apuesta) y duda (!duda).' },
            { cmd: '!cadena', desc: 'Encadena palabras (!cadena <palabra>).' },
            { cmd: '!traidor', desc: 'Roles secretos, excusas (!soy) y voto (!votar).' },
            { cmd: '!botella @ana @luis', desc: 'Elimina uno por uno (!girar).' },
            { cmd: '!pares @usuario', desc: 'Memorama 4x4 por turnos (!voltea A1 B2).' },
            { cmd: '!ahorcado2 @usuario', desc: 'Uno pone la palabra, el otro adivina.' },
            { cmd: '!palabron @usuario', desc: 'Palabra más larga con 6 letras (3 rondas).' },
            { cmd: '!esgrima @usuario', desc: 'Atacar/bloquear/finta (!tira), 3 toques.' },
            { cmd: '!puja @usuario', desc: 'Precio secreto, cercano sin pasarse.' },
            { cmd: '!miento @usuario', desc: '2 verdades + 1 mentira (!cual 1-3).' },
            { cmd: '!globo @usuario', desc: 'Infla por turnos (!inflar), explota y pierdes.' },
            { cmd: '!anagrama @usuario', desc: 'Desordena la palabra, el rápido gana.' },
            { cmd: '!rima @usuario', desc: 'Batalla de rimas por turnos.' },
            { cmd: '!wordle', desc: 'Palabra de 5 letras en 6 intentos (récord).' },
            { cmd: '!intruso', desc: 'Encuentra al infiltrado, 5 rondas (récord).' },
            { cmd: '!supervivencia', desc: '7 retos con 3 vidas (récord).' },
            { cmd: '!cazatesoros', desc: 'Número 1-50 con pistas de calor (récord).' },
            { cmd: '!ruleta2', desc: 'Palabra de la categoría con esa letra (récord).' },
            { cmd: '!escalera', desc: 'Serpientes y escaleras al 50 (récord).' },
            { cmd: '!caja', desc: 'Caja fuerte de 3 dígitos (récord).' },
            { cmd: '!emojimix 😂❤️', desc: 'Sticker mezclando 2 emojis.' }
        ]
    },
    {
        id: 'anime',
        aliases: ['manga', 'media', 'descargas', 'otaku'],
        icono: '🎬',
        titulo: 'ANIME Y MEDIA',
        resumen: 'Mangas en PDF, estrenos, animes y búsqueda visual',
        items: [
            { cmd: '!manga <nombre> / !leer', desc: 'Ver ficha o capítulos de un manga.' },
            { cmd: '!buscar <nombre>', desc: 'Buscador de mangas.' },
            { cmd: '!catalogo / !anime / !waifu', desc: 'Catálogo, info de anime e imágenes.' },
            { cmd: '!anime reto', desc: 'Desafío de memoria de anime.' },
            { cmd: '!personaje / !personaje random', desc: 'Info de personajes de anime.' },
            { cmd: '!estrenos / !temporada', desc: 'Estrenos y anime de temporada.' },
            { cmd: '!trace', desc: 'Buscar anime por imagen.' },
            { cmd: '!proximo / !estudio', desc: 'Próximos estrenos e info de estudios.' },
            { cmd: '!news', desc: 'Noticias de anime.' }
        ]
    },
    {
        id: 'waifus',
        aliases: ['waifu', 'harem'],
        icono: '🎀',
        titulo: 'WAIFUS',
        resumen: 'Tu top de waifus y desafíos de memoria',
        items: [
            { cmd: '!waifus top', desc: 'Ver tu top de waifus.' },
            { cmd: '!waifus @user', desc: 'Ver el top de otro usuario.' },
            { cmd: '!waifus set <lista>', desc: 'Agregar waifus a tu top.' },
            { cmd: '!waifus config <#> <nombre>', desc: 'Editar una posición de tu top.' },
            { cmd: '!waifus reset', desc: 'Borrar tu lista.' },
            { cmd: '!waifus random', desc: '10 waifus aleatorias.' },
            { cmd: '!waifus reto', desc: 'Desafío de memoria.' }
        ]
    },
    {
        id: 'humor',
        aliases: ['diversion', 'fun', 'entretenimiento'],
        icono: '🎭',
        titulo: 'DIVERSIÓN Y HUMOR',
        resumen: 'Ship, medidores, chistes, retos y sorteos',
        items: [
            { cmd: '!ship @user @user', desc: 'Compatibilidad amorosa entre dos.' },
            { cmd: '!love @user', desc: 'Cuánto te quiere el bot.' },
            { cmd: '!gay / !iq / !suerte', desc: 'Medidores divertidos.' },
            { cmd: '!top <tema>', desc: 'Ranking del grupo con el tema que pongas.' },
            { cmd: '!horoscopo / !8ball', desc: 'Horóscopo y bola mágica.' },
            { cmd: '!roast / !cumplido @user', desc: 'Insulto o cumplido gracioso.' },
            { cmd: '!hacker @user', desc: 'Hackeo falso a un usuario.' },
            { cmd: '!chiste / !reto / !verdad', desc: 'Chistes y retos de verdad o reto.' },
            { cmd: '!seria', desc: '¿Qué preferirías?' },
            { cmd: '!rifa <opc1, opc2, ...>', desc: 'Sorteo por texto entre opciones.' }
        ]
    },
    {
        id: 'reacciones',
        aliases: ['reaccion', 'acciones', 'gif', 'gifs'],
        icono: '✨',
        titulo: 'REACCIONES ANIME',
        resumen: 'GIFs anime de abrazo, beso, golpe y más',
        items: [
            { cmd: '!pat / !hug / !kiss / !slap' },
            { cmd: '!punch / !kill / !cry / !dance' },
            { cmd: '!bite / !highfive / !fumar / !cafe' },
            { cmd: '!puchero / !sonrojar / !baka / !dormir' },
            { cmd: '!comiendo / !pensar / !patear / !risa' },
            { cmd: '!celebrar / !aburrido / !smug / !stare', desc: 'Gifs de reacción (menciona a alguien).' }
        ]
    },
    {
        id: 'herramientas',
        aliases: ['herramienta', 'sticker', 'stickers', 'util', 'utilidades', 'tools'],
        icono: '🛠️',
        titulo: 'HERRAMIENTAS',
        resumen: 'Stickers (15s), voz, letras y utilidades',
        items: [
            { cmd: '!s', desc: 'Sticker de imagen o video/audio hasta 15s (responde o pon !s).' },
            { cmd: '!toimg', desc: 'Convertir sticker a foto.' },
            { cmd: '!decir <texto>', desc: 'El bot lo dice con voz grave.' },
            { cmd: '!setdecir', desc: 'Ver los 15 idiomas de !decir.' },
            { cmd: '!letra <canción>', desc: 'Letra de la canción.' },
            { cmd: '!gstick <nombre> / !stick <nombre>', desc: 'Guarda stickers con nombre y recupéralos.' },
            { cmd: '!wiki <texto> / !ascii <texto>', desc: 'Buscar en wiki o arte ASCII.' },
            { cmd: '!v <texto>', desc: 'Sticker con texto.' },
            { cmd: '!ver @usuario', desc: 'Ver foto de perfil de alguien.' },
            { cmd: '!ping', desc: 'Estado real del bot.' }
        ]
    }
];

function normalizarClaveMenu(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function buscarSeccionMenu(clave) {
    const norm = normalizarClaveMenu(clave);
    if (!norm) return null;
    return MENU_SECCIONES.find(s => s.id === norm || s.aliases.includes(norm)) || null;
}

function renderSeccionMenu(seccion) {
    const out = [`${seccion.icono} *[ ${seccion.titulo} ]*`];
    for (const item of seccion.items) {
        out.push(`• *${item.cmd}*`);
        if (item.desc) out.push(`└ _${item.desc}_`);
    }
    return out.join('\n');
}

function construirMenuCompacto({ pushName, uptimeH, uptimeM, motto }) {
    const categorias = MENU_SECCIONES
        .map(s => `• ${s.icono} *!menu ${s.id}* — ${s.resumen} (${s.items.length})`)
        .join('\n');
    return `✨ *DIKY BOT V3 - PANEL MAESTRO* ✨\n`
        + `📜 _"${motto}"_\n`
        + `━━━━━━━━━━━━━━━━━━━━━━\n`
        + `👤 *${pushName}*  |  🕒 *${uptimeH}h ${uptimeM}m*  |  💰 *diky*\n`
        + `━━━━━━━━━━━━━━━━━━━━━━\n\n`
        + `📂 *Categorías disponibles:*\n${categorias}\n\n`
        + `━━━━━━━━━━━━━━━━━━━━━━\n`
        + `📜 *!menu todo* — Ver todos los comandos\n`
        + `❓ *!help <comando>* — Ayuda detallada (ej: *!help s*)`;
}

function construirMenuCompleto({ pushName, uptimeH, uptimeM, motto }) {
    const cuerpo = MENU_SECCIONES.map(renderSeccionMenu).join('\n\n');
    return `✨ *DIKY BOT V3 - PANEL MAESTRO* ✨\n`
        + `📜 _"${motto}"_\n`
        + `━━━━━━━━━━━━━━━━━━━━━━\n\n`
        + `👤 *USUARIO:* ${pushName}\n`
        + `🕒 *UPTIME:* ${uptimeH}h ${uptimeM}m\n`
        + `💰 *MONEDA:* diky\n\n`
        + `━━━━━━━━━━━━━━━━━━━━━━\n\n`
        + `${cuerpo}\n\n`
        + `━━━━━━━━━━━━━━━━━━━━━━\n`
        + `> _Escribe un comando para empezar._\n`
        + `> _Diky Bot V3 - El bot más completo._`;
}

function formatearAyudaComando(commandName, help) {
    let response = `❓ *AYUDA: ${commandName}*\n\n`;
    response += `📖 *Descripción:*\n${help.desc}\n\n`;
    response += `📝 *Uso:*\n\`\`\`${help.usage}\`\`\`\n\n`;
    response += `💡 *Ejemplo:*\n${help.ejemplo}\n\n`;
    response += `📋 *Argumentos:* ${help.args}\n`;
    response += `⏱️ *Cooldown:* ${help.cooldown}`;
    if (help.alias) response += `\n🔁 *Alias:* ${help.alias}`;
    return response;
}

module.exports = {
    name: 'main',
    isMultiple: true,
    names: ['!menu', '!menu2', '!help', '!s', '!sticker', '!toimg'],
    async execute(sock, chatId, msg, args, { start, cmd, txt, isGroup, sender, pushName, downloadMediaMessage, convertirAWebp, extraerAudioSticker, prepararAudioParaSticker, stickerPool, limpiarCachePostSticker, getMediaConn, sockOriginal, FFMPEG_PATH, botState, db }) {

        // !ping esta manejado por commands/ping.js (mide latencia real con timestamp).
        // Se elimino la version duplicada de aqui, que nunca se ejecutaba (ping.js
        // se carga despues alfabeticamente y sobrescribe el registro de este comando).

        // !help <comando> - Ayuda detallada de un comando o categoría
        if (start === '!help' && args[0]) {
            const rawArg = String(args[0]).trim().toLowerCase();
            const commandName = rawArg.startsWith('!') ? rawArg : '!' + rawArg;
            const help = helpData[commandName];

            if (!help) {
                const secHelp = buscarSeccionMenu(rawArg);
                if (secHelp) {
                    const textoSec = `${renderSeccionMenu(secHelp)}\n\n💡 _Usa *!menu* para ver todas las categorías._`;
                    return sock.sendMessage(chatId, { text: textoSec }, { quoted: msg });
                }
                return sock.sendMessage(chatId, {
                    text: `❌ No tengo ayuda detallada para *${commandName}*.\n\nUsa *!menu* para ver las categorías disponibles.`
                }, { quoted: msg });
            }

            return sock.sendMessage(chatId, { text: formatearAyudaComando(commandName, help) }, { quoted: msg });
        }

        // !menu / !menu2 / !help (sin argumento -> compacto por categorías)
        if (start === '!menu' || start === '!menu2' || start === '!help') {
            const pick = (v) => v[Math.floor(Math.random() * v.length)];

            // ── MODO MANGA: menú reducido ──
            let isMangaActive = isGroup && botState.mangaMode?.get(chatId);
            if (isGroup && !isMangaActive && db) {
                const gConf = await db.estaGrupoActivo(chatId);
                if (gConf && gConf.modo_manga === 1) {
                    isMangaActive = true;
                    botState.mangaMode?.set(chatId, true);
                }
            }

            if (isMangaActive) {
                const up = Math.floor((Date.now() - botState.startTime) / 1000);
                const h = Math.floor(up / 3600), mn = Math.floor((up % 3600) / 60);

                let mt = `📚 *DIKY BOT — MODO MANGA* 📚\n`;
                mt += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                mt += `👤 *USUARIO:* ${pushName}\n`;
                mt += `🕒 *UPTIME:* ${h}h ${mn}m\n\n`;
                mt += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

                mt += `📖 *[ COMANDOS DE MANGA ]*\n\n`;

                mt += `• *!catalogo*\n`;
                mt += `└ _Lista los mangas disponibles con sus códigos._\n`;
                mt += `• *!manga <nombre o código>*\n`;
                mt += `└ _Ver portada e información de un manga._\n`;
                mt += `• *!leer <código>*\n`;
                mt += `└ _Ver lista de capítulos disponibles._\n`;
                mt += `• *!leer <código> <número>*\n`;
                mt += `└ _Descargar un capítulo en PDF._\n`;
                mt += `• *!leer <código> all*\n`;
                mt += `└ _Descargar todos los capítulos seguidos._\n`;
                mt += `• *!buscar <nombre>*\n`;
                mt += `└ _Buscar un manga por su título._\n`;
                mt += `• *!recomanga*\n`;
                mt += `└ _Recomienda un manga aleatorio en español._\n`;
                mt += `• *!recomanga <género>*\n`;
                mt += `└ _Recomienda un manga del género elegido (ej: terror)._\n`;
                mt += `• *!recomanga generos*\n`;
                mt += `└ _Ver la lista de géneros disponibles._\n`;
                mt += `• *!parar*\n`;
                mt += `└ _Detener una descarga masiva en curso._\n\n`;

                mt += `⚙️ *[ ADMINISTRACIÓN ]*\n\n`;

                mt += `• *!bot <on/off>*\n`;
                mt += `└ _Encender o apagar el bot en el grupo._\n`;
                mt += `• *!adm <on/off>*\n`;
                mt += `└ _Permitir comandos solo a administradores._\n`;
                mt += `• *!manga off*\n`;
                mt += `└ _Desactivar modo manga y restaurar todo el bot._\n\n`;

                mt += `━━━━━━━━━━━━━━━━━━━━━━\n`;
                mt += `> _Modo manga activo. Solo comandos de manga._\n`;
                mt += `> _Usa *!manga off* para volver al modo normal._`;

                return enviarMenuConPortada(sock, chatId, msg, db, mt);
            }

            // ── MENÚ COMPACTO / POR CATEGORÍA / COMPLETO (modo normal) ──
            const subArg = normalizarClaveMenu(args[0]);
            if (subArg) {
                if (subArg === 'todo' || subArg === 'completo' || subArg === 'all' || subArg === 'full') {
                    const mottos = [
                        "¡Tu compañero digital definitivo!",
                        "¡El bot más loco de WhatsApp!",
                        "¡Divirtiéndote desde el primer día!",
                        "¡Llevando el grupo al siguiente nivel!",
                        "¡Economía, juegos y mucha diversión!",
                        "¡El bot que tu grupo merece!",
                        "¡Diky Bot: Potencia y Estilo!",
                        "¡Donde la tecnología encuentra la risa!"
                    ];
                    const up = Math.floor((Date.now() - botState.startTime) / 1000);
                    const fullText = construirMenuCompleto({
                        pushName,
                        uptimeH: Math.floor(up / 3600),
                        uptimeM: Math.floor((up % 3600) / 60),
                        motto: pick(mottos)
                    });
                    return enviarMenuConPortada(sock, chatId, msg, db, fullText);
                }

                const seccion = buscarSeccionMenu(subArg);
                if (seccion) {
                    const text = `${renderSeccionMenu(seccion)}\n\n━━━━━━━━━━━━━━━━━━━━━━\n`
                        + `📂 _Usa *!menu* para otras categorías o *!menu todo* para ver todo._\n`
                        + `❓ _Usa *!help <comando>* para ver ejemplos._`;
                    return sock.sendMessage(chatId, { text }, { quoted: msg });
                }

                if (subArg.startsWith('!')) {
                    const helpCmd = helpData[subArg];
                    if (helpCmd) {
                        return sock.sendMessage(chatId, { text: formatearAyudaComando(subArg, helpCmd) }, { quoted: msg });
                    }
                }

                const ids = MENU_SECCIONES.map(s => `*${s.id}*`).join(', ');
                return sock.sendMessage(chatId, {
                    text: `📂 No encontré la categoría *${args[0]}*.\n\nCategorías válidas: ${ids}, *todo*.\nEjemplo: *!menu juegos*`
                }, { quoted: msg });
            }

            const mottos = [
                "¡Tu compañero digital definitivo!",
                "¡El bot más loco de WhatsApp!",
                "¡Divirtiéndote desde el primer día!",
                "¡Llevando el grupo al siguiente nivel!",
                "¡Economía, juegos y mucha diversión!",
                "¡El bot que tu grupo merece!",
                "¡Diky Bot: Potencia y Estilo!",
                "¡Donde la tecnología encuentra la risa!"
            ];
            const up = Math.floor((Date.now() - botState.startTime) / 1000);
            const compactText = construirMenuCompacto({
                pushName,
                uptimeH: Math.floor(up / 3600),
                uptimeM: Math.floor((up % 3600) / 60),
                motto: pick(mottos)
            });

            return enviarMenuConPortada(sock, chatId, msg, db, compactText);
        }

        // !sticker / !s
        if (start === '!sticker' || start === '!s') {
            // El contexto puede venir de un texto, pero también de una foto o
            // video con caption (!s). Así se detecta el audio citado cuando el
            // usuario responde a una nota de voz con una imagen.
            const cInfo = msg.message?.extendedTextMessage?.contextInfo
                || msg.message?.imageMessage?.contextInfo
                || msg.message?.videoMessage?.contextInfo
                || msg.message?.documentMessage?.contextInfo
                || msg.message?.stickerMessage?.contextInfo;
            const quoted = cInfo?.quotedMessage;
            // Desarma envoltorios (efímero / una sola vista / documento con caption)
            const desarmar = (q) => {
                let x = q;
                for (let i = 0; i < 4 && x; i++) {
                    if (x.ephemeralMessage?.message) x = x.ephemeralMessage.message;
                    else if (x.viewOnceMessage?.message) x = x.viewOnceMessage.message;
                    else if (x.viewOnceMessageV2?.message) x = x.viewOnceMessageV2.message;
                    else if (x.viewOnceMessageV2Extension?.message) x = x.viewOnceMessageV2Extension.message;
                    else if (x.documentWithCaptionMessage?.message) x = x.documentWithCaptionMessage.message;
                    else if (x.editedMessage?.message) x = x.editedMessage.message;
                    else break;
                }
                return x;
            };
            const citada = desarmar(quoted);
            // Fotos/videos mandados como documento (modo HD) también valen.
            // Se mira tanto el mensaje propio como el citado: la imagen puede
            // venir con caption !s y el audio estar citado (o al revés).
            const docMime = String(citada?.documentMessage?.mimetype || '');
            const docEsImagen = citada?.documentMessage && docMime.startsWith('image/');
            const docEsVideo = citada?.documentMessage && docMime.startsWith('video/');
            const msgDocMime = String(msg.message?.documentMessage?.mimetype || '');
            const msgDocEsImagen = msg.message?.documentMessage && msgDocMime.startsWith('image/');
            const msgDocEsVideo = msg.message?.documentMessage && msgDocMime.startsWith('video/');

            const mediaPropia = msg.message?.imageMessage
                || msg.message?.videoMessage
                || ((msgDocEsImagen || msgDocEsVideo) ? msg.message.documentMessage : null);
            const mediaCitada = citada?.imageMessage
                || citada?.videoMessage
                || ((docEsImagen || docEsVideo) ? citada.documentMessage : null);
            const media = mediaPropia || mediaCitada;
            // Audio citado: nota de voz normal o archivo de audio como documento.
            const audioMimeCitado = String(citada?.documentMessage?.mimetype || '');
            const audioCitado = citada?.audioMessage
                || (audioMimeCitado.startsWith('audio/') ? citada.documentMessage : null);

            if (!media) {
                // Log siempre visible (sin VERBOSE): si citó algo pero no se
                // reconoce, las claves dicen qué forma trajo y se diagnostica
                // desde el log de Render sin adivinar.
                if (quoted) console.warn('[STICKER] Citado sin media reconocible. Claves:', Object.keys(quoted).join(','));
                return sock.sendMessage(chatId, {
                    text: '*Como usar el sticker maker:*\n\n• Responde a una imagen/video con *!s*.\n• Video/GIF: hasta 15 segundos, sale con sonido.\n• Imagen con sonido: responde al audio (hasta 15s) con la imagen y pon *!s* de caption.\n\nEl sonido se reproduce en clientes con stickers con sonido (beta).'
                }, { quoted: msg });
            }

            // La media que se convierte puede ser la propia o la citada. El
            // video a validar debe ser ESA media, no cualquier video citado
            // (ej. imagen con caption !s que cita un video largo).
            const esVideo = !!(
                media === msg.message?.videoMessage
                || media === citada?.videoMessage
                || (media === msg.message?.documentMessage && msgDocEsVideo)
                || (media === citada?.documentMessage && docEsVideo));
            // Video largo: NO se rechaza, se convierte igual. ffmpeg recorta
            // solo los primeros 15 segundos (-t 15) y el tope real es
            // la descarga de 15MB.
            const videoInfo = esVideo ? media : null;
            if (videoInfo && videoInfo.seconds > 15) {
                console.log(`[STICKER] Video largo (${Math.round(videoInfo.seconds)}s): se convierte con los primeros 15 segundos.`);
            }

            const entradaMedia = mediaPropia ? msg : { key: msg.key, message: citada };
            const necesitaAudio = (esVideo && !media.gifPlayback) || !!audioCitado;
            const fallbackAudio = (buf, maxSeg) => prepararAudioParaSticker(buf, FFMPEG_PATH, maxSeg);
            const manejarErrorDescarga = (eDesc) => {
                console.error('[STICKER] Descarga falló:', eDesc.message);
                const msgCaduco = eDesc.message && (eDesc.message.includes('404') || eDesc.message.includes('410') || eDesc.message.includes('vacío'));
                return sock.sendMessage(chatId, {
                    text: msgCaduco
                        ? '⚠️ *No pude descargar ese archivo.*\n\nLos mensajes viejos caducan en WhatsApp: mándalo de nuevo al chat y responde *!s*.'
                        : '⚠️ *No pude descargar ese archivo.*\n\nMándalo de nuevo al chat y responde *!s*.'
                }, { quoted: msg });
            };

            const mediaClave = esVideo
                ? ((media === msg.message?.documentMessage || media === citada?.documentMessage) ? 'documentMessage' : 'videoMessage')
                : ((media === msg.message?.documentMessage || media === citada?.documentMessage) ? 'documentMessage' : 'imageMessage');
            const claveCache = construirClaveCache({
                media,
                audio: audioCitado,
                esVideo,
                conAudio: necesitaAudio,
                tipoMedia: mediaClave
            });
            const guardarCacheSticker = (stickerMsg, conAudio) => {
                if (!claveCache || !stickerMsg) return;
                // No se espera: un fallo de Turso nunca debe retrasar el envío.
                guardarStickerCache(claveCache, stickerMsg, db, { conAudio })
                    .catch(e => console.warn('[STICKER] No se pudo guardar cache:', e.message));
            };

            try {
                let stiker = null;
                let audio = null;

                // Cache hit: el sticker ya está subido a WhatsApp. Se reenvía
                // por relay con la cita NUEVA, sin descargar ni convertir nada.
                if (claveCache) {
                    const cacheado = await obtenerStickerCache(claveCache, db, { conAudio: necesitaAudio });
                    if (cacheado) {
                        try {
                            const envioCache = await enviarStickerPreSubido(sock, chatId, cacheado, msg);
                            if (envioCache) {
                                console.log(`[STICKER] Cache hit (${mediaClave}, audio=${necesitaAudio ? 'si' : 'no'}) -> relay directo.`);
                                return;
                            }
                        } catch (eCache) {
                            console.warn('[STICKER] Cache no reenviable, se regenera:', eCache.message);
                        }
                        await borrarStickerCache(claveCache, db);
                    }
                }

                if (stickerPool) {
                    const mediaProtoBytes = serializarMediaProto(media, mediaClave);
                    const audioProtoBytes = (!esVideo && audioCitado)
                        ? serializarMediaProto(audioCitado, audioCitado === citada?.audioMessage ? 'audioMessage' : 'documentMessage')
                        : null;

                    const res = await stickerPool.procesarSticker({
                        descargarMedia: () => descargarConTimeout(downloadMediaMessage, entradaMedia),
                        descargarAudioCitado: (!esVideo && audioCitado)
                            ? () => descargarConTimeout(downloadMediaMessage, { key: msg.key, message: citada })
                            : null,
                        mediaProtoBytes,
                        audioProtoBytes,
                        getMediaConn,
                        esVideo,
                        necesitaAudio,
                        fallbackConvertir: convertirAWebp,
                        fallbackAudio,
                        maxBytes: 15 * 1024 * 1024
                    });
                    if (res.overloaded) {
                        return sock.sendMessage(chatId, { text: '⏳ *Hay muchos stickers en fila.*\nEspera unos segundos y manda el tuyo de nuevo.' }, { quoted: msg });
                    }
                    if (res.downloadError) return manejarErrorDescarga(res.downloadError);
                    if (res.empty) {
                        return sock.sendMessage(chatId, { text: '⚠️ *No pude descargar ese archivo.*\n\nMándalo de nuevo al chat y responde *!s*.' }, { quoted: msg });
                    }
                    if (res.tooLarge) {
                        return sock.sendMessage(chatId, { text: '⚠️ *Archivo muy pesado* (más de 15MB).\nManda un video más corto o una imagen más liviana.' }, { quoted: msg });
                    }
                    if (res.preuploadedStickerMsg) {
                        const envio = await enviarStickerPreSubido(sock, chatId, res.preuploadedStickerMsg, msg);
                        if (envio) {
                            guardarCacheSticker(envio.message?.stickerMessage, necesitaAudio);
                            console.log(`[STICKER] Enviado via PC directo (Render solo relayMessage).`);
                            return;
                        }
                        throw new Error('No se pudo reenviar sticker pre-subido por relayMessage');
                    }
                    stiker = res.stiker;
                    audio = res.audio;
                } else {
                    let buffer;
                    try {
                        buffer = await descargarConTimeout(downloadMediaMessage, entradaMedia);
                    } catch (eDesc) {
                        return manejarErrorDescarga(eDesc);
                    }
                    if (!buffer || buffer.length === 0) {
                        return sock.sendMessage(chatId, { text: '⚠️ *No pude descargar ese archivo.*\n\nMándalo de nuevo al chat y responde *!s*.' }, { quoted: msg });
                    }
                    if (buffer.length > 15 * 1024 * 1024) {
                        return sock.sendMessage(chatId, { text: '⚠️ *Archivo muy pesado* (más de 15MB).\nManda un video más corto o una imagen más liviana.' }, { quoted: msg });
                    }
                    const tareaAudio = (async () => {
                        if (!necesitaAudio) return null;
                        try {
                            if (audioCitado) {
                                const audioBuf = await descargarConTimeout(downloadMediaMessage, { key: msg.key, message: citada });
                                if (audioBuf && audioBuf.length && audioBuf.length <= 15 * 1024 * 1024) {
                                    return await fallbackAudio(audioBuf, 15);
                                }
                            }
                            if (esVideo) return await fallbackAudio(buffer, 15);
                        } catch (eAudio) {
                            console.warn('[STICKER] No pude preparar el sonido:', eAudio.message);
                        }
                        return null;
                    })();
                    stiker = await convertirAWebp(buffer, esVideo);
                    audio = await tareaAudio;
                }

                if (!stiker) {
                    return sock.sendMessage(chatId, { text: '❌ *No pude convertirlo* (formato raro).\nPrueba con otra imagen o GIF.' });
                }

                if (audio && audio.buffer && audio.buffer.length && audio.waveform && audio.waveform.length) {
                    const enviado = await enviarStickerConSonido(sock, chatId, stiker, audio, msg, FFMPEG_PATH);
                    if (enviado) {
                        guardarCacheSticker(enviado.message?.stickerMessage, true);
                        console.log(`[STICKER] Enviado con sonido (${Math.round(audio.buffer.length / 1024)} KB, ${Math.round(audio.segundos || 0)}s, waveform: ${audio.waveform.length}B).`);
                        return;
                    }
                }
                const enviadoSinSonido = await sock.sendMessage(chatId, { sticker: stiker }, { quoted: msg });
                // Si se esperaba audio y falló, NO se cachea: guardar un sticker
                // mudo bajo la clave con audio envenenaría los siguientes envíos.
                if (!necesitaAudio) {
                    guardarCacheSticker(enviadoSinSonido?.message?.stickerMessage, false);
                }
                return enviadoSinSonido;
            } catch (e) {
                console.error('[STICKER] Error:', e.message);
                return sock.sendMessage(chatId, { text: '❌ Error al crear sticker.' });
            } finally {
                if (typeof limpiarCachePostSticker === 'function') {
                    Promise.resolve(limpiarCachePostSticker()).catch(() => { });
                }
            }
        }

        // !toimg — sticker → imagen
        if (start === '!toimg') {
            const cInfo = msg.message?.extendedTextMessage?.contextInfo
                || msg.message?.imageMessage?.contextInfo
                || msg.message?.videoMessage?.contextInfo;
            const quoted = cInfo?.quotedMessage;

            // El sticker citado no siempre está en el primer nivel: WhatsApp lo
            // envuelve en viewOnce / ephemeral / documentWithCaption / edited.
            let sticker = msg.message?.stickerMessage || null;
            if (!sticker && quoted) {
                let q = quoted;
                for (let i = 0; i < 3 && q && !q.stickerMessage; i++) {
                    q = q.viewOnceMessage?.message
                        || q.viewOnceMessageV2?.message
                        || q.viewOnceMessageV2Extension?.message
                        || q.ephemeralMessage?.message
                        || q.documentWithCaptionMessage?.message
                        || q.editedMessage?.message
                        || null;
                }
                sticker = q?.stickerMessage || null;
            }
            if (!sticker) return sock.sendMessage(chatId, { text: '🖼️ Responde a un *sticker* con *!toimg* para convertirlo a imagen.' }, { quoted: msg });

            const { execFile } = require('child_process');
            const { promisify } = require('util');
            const execFileAsync = promisify(execFile);
            const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const tmpIn = path.join(os.tmpdir(), `toimg_in_${uid}.webp`);
            const tmpPng = path.join(os.tmpdir(), `toimg_out_${uid}.png`);

            try {
                const buffer = await downloadMediaMessage(
                    msg.message?.stickerMessage ? msg : { message: quoted },
                    'buffer', {}
                );
                if (!buffer || buffer.length === 0) throw new Error('sticker vacio');

                // Los stickers animados son WebP con animación y NINGÚN ffmpeg
                // los decodifica (probado: 5.1, 6.0 y 7.0 fallan con "Invalid
                // data found when processing input"; dwebp tampoco). Por eso se
                // extrae el primer frame del contenedor en JS y ese frame, que
                // ya es un WebP fijo, sí lo convierte ffmpeg.
                const esAnim = sticker.isAnimated === true || esWebpAnimado(buffer);
                let entrada = buffer;
                if (esAnim) {
                    const frame = primerFrameWebp(buffer);
                    if (!frame) throw new Error('no se pudo extraer el primer frame del sticker animado');
                    entrada = frame;
                }
                fs.writeFileSync(tmpIn, entrada);

                // `-frames:v 1` deja el resultado determinista (un solo PNG) y
                // evita el error del muxer image2 con entradas multi-frame.
                await execFileAsync(FFMPEG_PATH, [
                    '-threads', '2', '-i', tmpIn, '-frames:v', '1', '-an', '-y', tmpPng
                ], { timeout: 15000, windowsHide: true });
                const imgBuffer = fs.readFileSync(tmpPng);
                if (!imgBuffer || imgBuffer.length === 0) throw new Error('PNG vacio');
                return sock.sendMessage(chatId, {
                    image: imgBuffer,
                    caption: esAnim
                        ? '🖼️ Sticker animado convertido a imagen (primer frame).'
                        : '🖼️ Sticker convertido a imagen.'
                }, { quoted: msg });
            } catch (e) {
                console.error('❌ [toimg] Error:', e.message, '| stderr:', String(e.stderr || '').slice(0, 300));
                return sock.sendMessage(chatId, { text: '❌ No pude convertir ese sticker.\n\nProbá con otro: los stickers de *Lottie* (animación vectorial) no se pueden convertir a imagen.' }, { quoted: msg });
            } finally {
                // Antes los temporales quedaban en disco si ffmpeg fallaba.
                try { fs.unlinkSync(tmpIn); } catch (e) { }
                try { fs.unlinkSync(tmpPng); } catch (e) { }
            }
        }
    }
};
