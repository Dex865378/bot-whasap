/**
 * 🧪 Tests del menú compacto por categorías (Opción A).
 * Uso: node scripts/test-menu.js
 */
'use strict';
const assert = require('assert');
const { execute } = require('../commands/main');
const { helpData } = require('../commands/help');

function mockSock() {
    const enviados = [];
    return {
        enviados,
        sock: {
            sendMessage: async (jid, content, opts) => {
                enviados.push({ jid, content, opts });
                return { key: { id: 'MENU_' + enviados.length } };
            }
        }
    };
}

function textoDe(enviado) {
    return enviado?.content?.caption || enviado?.content?.text || '';
}

async function runMenu(cmdStart, args = [], { manga = false, db = {} } = {}) {
    const { sock, enviados } = mockSock();
    await execute(sock, 'grp@g.us', { key: { id: 'M1' } }, args, {
        start: cmdStart,
        cmd: cmdStart,
        txt: [cmdStart, ...args].join(' '),
        isGroup: true,
        sender: 'u1@s.whatsapp.net',
        pushName: 'Usuario',
        botState: {
            startTime: Date.now() - 3660 * 1000,
            mangaMode: new Map([['grp@g.us', manga]])
        },
        db: {
            getPortada: async () => Buffer.from('FAKE_IMG'),
            estaGrupoActivo: async () => ({ modo_manga: manga ? 1 : 0 }),
            ...db
        }
    });
    return enviados;
}

(async () => {
    let fallos = 0;
    const probar = async (nombre, fn) => {
        try { await fn(); console.log(`✅ ${nombre}`); }
        catch (e) { fallos++; console.error(`❌ ${nombre}\n   ${e.message}`); }
    };

    await probar('!menu principal envía resumen compacto por categorías (no muro largo)', async () => {
        const enviados = await runMenu('!menu');
        assert.strictEqual(enviados.length, 1);
        assert.ok(Buffer.isBuffer(enviados[0].content.image), 'debe incluir portada');
        const txt = textoDe(enviados[0]);
        const lineas = txt.split('\n').length;
        assert.ok(lineas <= 40, `el menú compacto debe tener <= 40 líneas, tuvo ${lineas}`);
        assert.ok(txt.includes('!menu admin'), 'debe listar !menu admin');
        assert.ok(txt.includes('!menu juegos'), 'debe listar !menu juegos');
        assert.ok(txt.includes('!menu herramientas'), 'debe listar !menu herramientas');
        assert.ok(txt.includes('!menu todo'), 'debe indicar !menu todo');
    });

    await probar('!menu2 y !help sin args también muestran menú compacto', async () => {
        for (const cmd of ['!menu2', '!help']) {
            const enviados = await runMenu(cmd);
            assert.strictEqual(enviados.length, 1);
            const txt = textoDe(enviados[0]);
            assert.ok(txt.includes('!menu todo') && txt.split('\n').length <= 40, `${cmd} debe ser compacto`);
        }
    });

    await probar('!menu <categoria> muestra solo esa categoría (con alias y acentos)', async () => {
        const envAdmin = await runMenu('!menu', ['Administración']);
        assert.strictEqual(envAdmin.length, 1);
        assert.strictEqual(envAdmin[0].content.image, undefined, 'subcategoría va en texto ligero');
        const txtAdmin = textoDe(envAdmin[0]);
        assert.ok(txtAdmin.includes('!kick') && txtAdmin.includes('!warn'), 'admin incluye !kick y !warn');
        assert.ok(!txtAdmin.includes('!slot'), 'admin no mezcla comandos de casino');

        const envStickers = await runMenu('!menu', ['stickers']);
        const txtStickers = textoDe(envStickers[0]);
        assert.ok(txtStickers.includes('!s') && txtStickers.includes('15'), 'herramientas refleja tope de 15s en !s');
        assert.ok(!txtStickers.includes('!marry'), 'herramientas no mezcla social');
    });

    await probar('!menu todo envía el panel completo con todas las secciones', async () => {
        const enviados = await runMenu('!menu', ['todo']);
        assert.strictEqual(enviados.length, 1);
        assert.ok(Buffer.isBuffer(enviados[0].content.image), '!menu todo conserva portada');
        const txt = textoDe(enviados[0]);
        assert.ok(txt.includes('!kick') && txt.includes('!slot') && txt.includes('!s') && txt.includes('!waifus'), 'debe incluir todas las categorías');
    });

    await probar('!menu respeta modo manga aun si piden otra categoría', async () => {
        const enviados = await runMenu('!menu', ['juegos'], { manga: true });
        assert.strictEqual(enviados.length, 1);
        const txt = textoDe(enviados[0]);
        assert.ok(txt.includes('MODO MANGA'), 'debe seguir en menú reducido de modo manga');
        assert.ok(!txt.includes('!slot'), 'no debe exponer casino en modo manga');
    });

    await probar('!menu <inexistente> orienta con categorías válidas', async () => {
        const enviados = await runMenu('!menu', ['noexiste123']);
        assert.strictEqual(enviados.length, 1);
        const txt = textoDe(enviados[0]);
        assert.ok(txt.split('\n').length <= 15, 'respuesta corta sin volcar el menú');
        assert.ok(txt.includes('No encontré') && txt.includes('admin') && txt.includes('todo'), 'debe indicar las categorías disponibles');
        assert.ok(!txt.includes('!slot'), 'no debe listar todos los comandos');
    });

    await probar('helpData documenta !s (15s, 45s cooldown) y !menu con categorías', () => {
        assert.ok(helpData['!s'], 'helpData debe incluir !s');
        assert.ok(helpData['!s'].desc.includes('15'), 'helpData !s debe mencionar 15s');
        assert.ok(helpData['!s'].cooldown.includes('45'), 'helpData !s debe mencionar cooldown 45s');
        assert.ok(helpData['!menu'].usage.includes('categoria') || helpData['!menu'].usage.includes('todo'), 'helpData !menu debe documentar categorías');
    });

    console.log(fallos === 0 ? '\n🎉 TEST MENU OK' : `\n💥 TEST MENU: ${fallos} fallo(s)`);
    process.exit(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
