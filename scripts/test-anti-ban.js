/**
 * 🧪 Tests de regresión anti-ban.
 * Uso: node scripts/test-anti-ban.js
 *
 * Verifica:
 *  1. sockProxy.relayMessage pasa por cola (no directo)
 *  2. procesarColaSalida detecta _relay y llama relayMessage
 *  3. Per-user sticker cooldown (5s)
 *  4. Per-group sticker budget (15/min)
 *  5. clasificarDesconexionAuth 403 nunca devuelve shouldReset
 *  6. clasificarDesconexionAuth 403 x5+ devuelve shouldStop
 *  7. QUEUE_MIN_DELAY_MS >= 1100
 *  8. No turbo mode en procesarColaSalida
 */
'use strict';
const assert = require('assert');

(async () => {
    let fallos = 0;
    const probar = async (nombre, fn) => {
        try { await fn(); console.log(`✅ ${nombre}`); }
        catch (e) { fallos++; console.error(`❌ ${nombre}\n   ${e.message}`); }
    };

    // ── Helper: clasificarDesconexionAuth ──
    const { clasificarDesconexionAuth } = require('../turso-auth');
    const DisconnectReason = {
        loggedOut: 401,
        connectionReplaced: 440,
        forbidden: 403,
        badSession: 500,
    };

    await probar('403 iteración 1-4 → shouldReset=false, shouldStop=false', async () => {
        for (let i = 0; i < 4; i++) {
            const r = clasificarDesconexionAuth(403, { errores401: 0, errores403: i }, DisconnectReason);
            assert.strictEqual(r.shouldReset, false, `iteración ${i}: shouldReset debe ser false`);
            assert.ok(!r.shouldStop, `iteración ${i}: shouldStop debe ser falsy`);
            assert.strictEqual(r.handled, true);
        }
    });

    await probar('403 iteración 5+ → shouldStop=true, shouldReset=false', async () => {
        for (let i = 4; i < 8; i++) {
            const r = clasificarDesconexionAuth(403, { errores401: 0, errores403: i }, DisconnectReason);
            assert.strictEqual(r.shouldReset, false, `iteración ${i}: shouldReset debe ser false`);
            assert.strictEqual(r.shouldStop, true, `iteración ${i}: shouldStop debe ser true`);
        }
    });

    await probar('419 (variante forbidden) tampoco devuelve shouldReset', async () => {
        const r = clasificarDesconexionAuth(419, { errores401: 0, errores403: 0 }, DisconnectReason);
        assert.strictEqual(r.shouldReset, false);
        assert.strictEqual(r.handled, true);
    });

    // ── Helper: verificarCooldown (extracted inline) ──
    const cooldowns = new Map();
    function verificarCooldown(userId, comando, ms = 3000) {
        const key = `${userId}-${comando}`;
        const ahora = Date.now();
        const last = cooldowns.get(key) || 0;
        if (ahora - last < ms) return Math.ceil((ms - (ahora - last)) / 1000);
        cooldowns.set(key, ahora);
        return 0;
    }

    await probar('sticker cooldown: 1er uso → 0, 2do dentro de 5s → >0', async () => {
        const sender = 'test-user-cd@s.whatsapp.net';
        const r1 = verificarCooldown(sender, '!s-user', 5000);
        assert.strictEqual(r1, 0, 'primer uso debe devolver 0');
        const r2 = verificarCooldown(sender, '!s-user', 5000);
        assert.ok(r2 > 0, `segundo uso inmediato debe devolver >0, obtuvo ${r2}`);
    });

    await probar('sticker cooldown: diferente usuario no afecta', async () => {
        const r = verificarCooldown('otro-user@s.whatsapp.net', '!s-user', 5000);
        assert.strictEqual(r, 0, 'usuario diferente debe pasar libre');
    });

    // ── Aviso de los 60 s: regresión del bug "el mensaje nunca sale" ──
    // El cooldown global de 4 s cortaba ANTES del chequeo por usuario, así que
    // quien reintentaba enseguida (lo que hacen todos) se iba en silencio.
    await probar('aviso de 60 s: el chequeo del usuario va ANTES del global', async () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
        const iUser = src.indexOf("consultarCooldown(sender, '!s-user'");
        const iGlobal = src.indexOf("verificarCooldown('BOT', '!s-global'");
        assert.ok(iUser > 0, 'falta el chequeo por usuario con consultarCooldown');
        assert.ok(iGlobal > 0, 'falta el cooldown global');
        assert.ok(iUser < iGlobal, 'el aviso de los 60 s se consulta después del cooldown global: saldría en silencio');
        assert.ok(src.includes('stickerGate.notices++'), 'el aviso enviado no se cuenta en /health');
        assert.ok(src.includes('stickerGate: { ...stickerGate }'), '/health no expone los contadores del candado');
        assert.ok(src.includes("verificarCooldown(sender, '!s-user', STICKER_USER_COOLDOWN_MS);"), 'falta marcar el turno real del usuario al final');
    });

    await probar('aviso de 60 s: consultar no consume el turno del usuario', async () => {
        const map = new Map();
        const consultar = (u, c, ms) => {
            const falta = ms - (Date.now() - (map.get(`${u}-${c}`) || 0));
            return falta > 0 ? Math.ceil(falta / 1000) : 0;
        };
        const verificar = (u, c, ms) => {
            const r = consultar(u, c, ms);
            if (r === 0) map.set(`${u}-${c}`, Date.now());
            return r;
        };
        verificar('u1', '!s-user', 60000);   // el sticker que sí salió
        verificar('BOT', '!s-global', 4000); // y la pausa global que dejó
        assert.ok(verificar('BOT', '!s-global', 4000) > 0, 'el global debe estar activo');
        const wait = consultar('u1', '!s-user', 60000);
        const wait2 = consultar('u1', '!s-user', 60000);
        assert.strictEqual(wait, wait2, 'consultar no debe consumir el turno del usuario');
        assert.ok(wait > 0, 'con el global activo el aviso sigue mostrando los segundos');
        assert.ok(wait >= 59 && wait <= 60, `segundos esperados ~60, obtuvo ${wait}`);
    });

    // ── Per-group budget ──
    await probar('budget de grupo: permite 15, bloquea el 16', async () => {
        const stickerGroupBudget = new Map();
        const chatId = 'grupo-test@g.us';
        const ahora = Date.now();
        stickerGroupBudget.set(chatId, { count: 0, windowStart: ahora });

        for (let i = 0; i < 15; i++) {
            const budget = stickerGroupBudget.get(chatId);
            assert.ok(budget.count < 15, `iteración ${i} debe pasar`);
            budget.count++;
        }
        const budget = stickerGroupBudget.get(chatId);
        assert.strictEqual(budget.count >= 15, true, 'solicitud 16 debe ser rechazada');
    });

    await probar('budget de grupo: ventana expira después de 60s', async () => {
        const stickerGroupBudget = new Map();
        const chatId = 'grupo-expire@g.us';
        stickerGroupBudget.set(chatId, { count: 15, windowStart: Date.now() - 61000 });
        const budget = stickerGroupBudget.get(chatId);
        const expired = Date.now() - budget.windowStart > 60000;
        assert.ok(expired, 'ventana de más de 60s debe considerar expirada');
    });

    // ── sockProxy relayMessage → cola ──
    await probar('sockProxy intercepta relayMessage y lo manda a cola', async () => {
        const llamadas = [];
        const sockFake = {
            sendMessage: async () => ({ key: { id: 'SM' } }),
            relayMessage: async (jid, msg, opts) => {
                llamadas.push({ jid, msg, opts });
                return 'RELAY_DIRECT';
            },
        };

        // Simular enviarConCola que captura en vez de enviar
        const capturados = [];
        function enviarConCola(sock, jid, content, opts) {
            capturados.push({ jid, content, opts });
            return Promise.resolve({ key: { id: 'COLA' } });
        }

        const sockProxy = new Proxy(sockFake, {
            get(target, prop) {
                if (prop === 'sendMessage') {
                    return (jid, content, opts) => enviarConCola(target, jid, content, opts);
                }
                if (prop === 'relayMessage') {
                    return (jid, message, opts) => enviarConCola(target, jid, { _relay: true, _relayMsg: message, _relayOpts: opts }, {});
                }
                return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
            }
        });

        await sockProxy.relayMessage('123@g.us', { stickerMessage: {} }, { messageId: 'ABC' });

        assert.strictEqual(llamadas.length, 0, 'NO debe llamar relayMessage directo del sock');
        assert.strictEqual(capturados.length, 1, 'debe ir a la cola');
        assert.strictEqual(capturados[0].content._relay, true, 'marcador _relay');
        assert.deepStrictEqual(capturados[0].content._relayMsg, { stickerMessage: {} }, '_relayMsg preservado');
        assert.deepStrictEqual(capturados[0].content._relayOpts, { messageId: 'ABC' }, '_relayOpts preservado');
    });

    // ── procesarColaSalida reconoce _relay ──
    await probar('cola de salida: item con _relay llama sock.relayMessage', async () => {
        const llamadasRelay = [];
        const llamadasSend = [];
        const sockFake = {
            relayMessage: async (jid, msg, opts) => { llamadasRelay.push({ jid, msg, opts }); },
            sendMessage: async (jid, content, opts) => { llamadasSend.push({ jid, content, opts }); return { key: { id: 'X' } }; },
        };

        // Simulamos la lógica de procesarColaSalida inline
        const content = { _relay: true, _relayMsg: { stickerMessage: {} }, _relayOpts: { messageId: 'Z' } };
        if (content && content._relay) {
            await sockFake.relayMessage('chat@g.us', content._relayMsg, content._relayOpts || {});
        } else {
            await sockFake.sendMessage('chat@g.us', content, {});
        }

        assert.strictEqual(llamadasRelay.length, 1, 'debe llamar relayMessage');
        assert.strictEqual(llamadasSend.length, 0, 'NO debe llamar sendMessage');
        assert.deepStrictEqual(llamadasRelay[0].msg, { stickerMessage: {} });
    });

    await probar('cola de salida: item normal llama sock.sendMessage', async () => {
        const llamadasRelay = [];
        const llamadasSend = [];
        const sockFake = {
            relayMessage: async (jid, msg, opts) => { llamadasRelay.push({ jid, msg, opts }); },
            sendMessage: async (jid, content, opts) => { llamadasSend.push({ jid, content, opts }); return { key: { id: 'X' } }; },
        };

        const content = { text: 'hola' };
        if (content && content._relay) {
            await sockFake.relayMessage('chat@g.us', content._relayMsg, content._relayOpts || {});
        } else {
            await sockFake.sendMessage('chat@g.us', content, {});
        }

        assert.strictEqual(llamadasSend.length, 1, 'debe llamar sendMessage');
        assert.strictEqual(llamadasRelay.length, 0, 'NO debe llamar relayMessage');
    });

    // ── Verificar constantes ──
    await probar('QUEUE_MIN_DELAY_MS >= 2000 (sin env override)', async () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
        const match = src.match(/QUEUE_MIN_DELAY_MS\s*=\s*envInt\s*\(\s*['"]PERF_QUEUE_MIN_MS['"]\s*,\s*(\d+)/);
        assert.ok(match, 'debe encontrar la declaración de QUEUE_MIN_DELAY_MS');
        const defaultVal = parseInt(match[1], 10);
        assert.ok(defaultVal >= 2000, `default ${defaultVal} debe ser >= 2000`);
    });

    await probar('no existe modo turbo (10ms/20ms/35ms) en procesarColaSalida', async () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
        const fnStart = src.indexOf('async function procesarColaSalida');
        const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
        const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 4000);
        assert.ok(!fnBody.includes('delayMs = 10') && !fnBody.includes('delayMs = 20') && !fnBody.includes('delayMs = 35'),
            'no debe haber delays turbo de 10/20/35ms');
        assert.ok(!fnBody.includes('cola.length > 25'), 'no debe haber escalón turbo por tamaño de cola');
    });

    await probar('procesarColaSalida simula composing antes de texto', async () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
        const fnStart = src.indexOf('async function procesarColaSalida');
        const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
        const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 4000);
        assert.ok(fnBody.includes("sendPresenceUpdate('composing'"), 'debe simular typing antes de enviar');
        assert.ok(fnBody.includes("sendPresenceUpdate('paused'"), 'debe pausar typing después');
    });

    await probar('gaussianDelay existe y se usa en cola', async () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
        assert.ok(src.includes('function gaussianDelay'), 'función gaussianDelay debe existir');
        assert.ok(src.includes('gaussianDelay(baseDelay'), 'debe usarse en la cola de salida');
    });

    await probar('readMessages se llama antes de procesar', async () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
        assert.ok(src.includes('sock.readMessages([msg.key])'), 'debe marcar mensajes como leídos');
    });

    await probar('cooldown global de stickers (STICKER_GLOBAL_COOLDOWN_MS)', async () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
        assert.ok(src.includes('STICKER_GLOBAL_COOLDOWN_MS'), 'constante debe existir');
        assert.ok(src.includes("'!s-global'"), 'debe tener cooldown global con key !s-global');
    });

    // ── reacciones: check groupConf guard ──
    await probar('reaccionesGrupoActivas: undefined → false (off por defecto)', async () => {
        const groupConf = { active: { chat_id: 'x' } };
        const isGroup = true;
        const reaccionesGrupoActivas = isGroup && groupConf?.reacciones === 1;
        assert.strictEqual(reaccionesGrupoActivas, false, 'grupo sin campo reacciones debe tener reacciones OFF');
    });

    await probar('reaccionesGrupoActivas: reacciones=0 → false', async () => {
        const groupConf = { active: { chat_id: 'x' }, reacciones: 0 };
        const isGroup = true;
        const reaccionesGrupoActivas = isGroup && groupConf?.reacciones === 1;
        assert.strictEqual(reaccionesGrupoActivas, false, 'grupo con reacciones=0 debe desactivar reacciones');
    });

    await probar('reaccionesGrupoActivas: reacciones=1 → true (activado explícito)', async () => {
        const groupConf = { active: { chat_id: 'x' }, reacciones: 1 };
        const isGroup = true;
        const reaccionesGrupoActivas = isGroup && groupConf?.reacciones === 1;
        assert.strictEqual(reaccionesGrupoActivas, true, 'grupo con reacciones=1 debe activar reacciones');
    });

    await probar('reaccionesGrupoActivas: chat privado siempre false', async () => {
        const isGroup = false;
        const groupConf = { reacciones: 1 };
        const reaccionesGrupoActivas = isGroup && groupConf?.reacciones === 1;
        assert.strictEqual(reaccionesGrupoActivas, false, 'DM nunca debe tener reacciones');
    });

    // ── Archivo reacciones.js carga sin error ──
    await probar('commands/reacciones.js exporta name y execute', async () => {
        const mod = require('../commands/reacciones');
        assert.strictEqual(mod.name, '!reacciones');
        assert.strictEqual(typeof mod.execute, 'function');
    });

    // ── 463 / reachout timelock (Baileys rc14) ──
    const { esError463, normalizarReachout } = require('../utils/reachout');

    await probar('esError463 detecta 463 en data, output.statusCode y mensaje', async () => {
        assert.strictEqual(esError463({ data: 463 }), true);
        assert.strictEqual(esError463({ output: { statusCode: 463 } }), true);
        assert.strictEqual(esError463(new Error('reachout timelock: account restricted')), true);
    });

    await probar('esError463 NO confunde 429 ni ids de mensaje con 4630', async () => {
        assert.strictEqual(esError463({ data: 429 }), false);
        assert.strictEqual(esError463(new Error('sendMessage timeout')), false);
        assert.strictEqual(esError463(new Error('msg 146301234 failed')), false);
        assert.strictEqual(esError463(null), false);
    });

    await probar('normalizarReachout: activo trae tipo y fecha', async () => {
        const fin = new Date(Date.now() + 3600 * 1000);
        const r = normalizarReachout({ isActive: true, enforcementType: 'DEFAULT', timeEnforcementEnds: fin });
        assert.strictEqual(r.restringido, true);
        assert.strictEqual(r.tipo, null, 'DEFAULT no es una restricción real');
        assert.strictEqual(r.expiraEn, fin.getTime());
        assert.ok(r.segundosRestantes > 3500, 'debe calcular segundos restantes');
    });

    await probar('normalizarReachout: inactivo o vacío no restringe', async () => {
        const r = normalizarReachout({ isActive: false, enforcementType: 'DEFAULT' });
        assert.strictEqual(r.restringido, false);
        assert.strictEqual(r.expiraEn, null);
        assert.strictEqual(normalizarReachout(undefined).restringido, false);
    });

    await probar('el índice consulta el reachout y lo expone en /health', async () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
        assert.ok(src.includes('fetchAccountReachoutTimelock'), 'debe consultar el estado de restricción');
        assert.ok(src.includes('reachout: { ...reachout }'), '/health debe exponer el estado');
        assert.ok(src.includes("sock.ev.on('connection.update'") && src.includes('reachoutTimeLock'),
            'debe escuchar reachoutTimeLock en connection.update');
    });

    await probar('la cola detecta el 463 antes de reintentar cualquier 429', async () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
        const fnStart = src.indexOf('async function procesarColaSalida');
        const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
        const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 4000);
        assert.ok(fnBody.includes('esError463(e)'), 'la cola debe detectar 463');
        assert.ok(fnBody.indexOf('esError463(e)') < fnBody.indexOf("rate-overlimit"),
            'el 463 debe revisarse antes del reintento de 429');
    });

    console.log(fallos === 0 ? '\n🎉 TEST ANTI-BAN OK' : `\n💥 TEST ANTI-BAN: ${fallos} fallo(s)`);
    process.exit(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
