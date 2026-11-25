/**
 * 🔐 ADAPTADOR DE AUTENTICACIÓN PARA TURSO
 * Cache LRU en memoria + write-behind coalesced batching para que Baileys
 * no dispare cientos de queries HTTP por segundo en grupos grandes.
 */
const db = require('./database');

let initAuthCreds, BufferJSON;
try {
    const baileys = require('@whiskeysockets/baileys');
    initAuthCreds = baileys.initAuthCreds;
    BufferJSON = baileys.BufferJSON;
} catch (e) {
    console.error('❌ [Auth] No se pudo importar utilidades de Baileys');
}

const MAX_AUTH_CACHE = 5000;
const AUTH_FLUSH_MS = 600;
const CREDS_DEBOUNCE_MS = 1500;
const CACHE_MISS = Symbol('CACHE_MISS');

async function useTursoAuthState() {
    if (!db.isConnected() || !initAuthCreds || !BufferJSON) {
        console.warn('⚠️ [Auth] Turso no disponible, se usará auth local.');
        return null;
    }

    let creds;
    const credsData = await db.getAuthKey('creds');
    if (credsData) {
        try {
            creds = JSON.parse(credsData, BufferJSON.reviver);
            console.log('🔑 [Auth] Sesión recuperada de Turso.');
        } catch (e) {
            console.warn('⚠️ [Auth] Credenciales corruptas, creando nuevas.');
            creds = initAuthCreds();
        }
    } else {
        console.log('🆕 [Auth] Primera vez, creando credenciales nuevas.');
        creds = initAuthCreds();
    }

    const memCache = new Map(); // dbKey -> parsedValue | CACHE_MISS
    const pendingWrites = new Map(); // dbKey -> { op: 'save'|'del', valObj, seq }
    const inFlightWrites = new Map(); // dbKey -> { op, valObj } mientras corre el batch HTTP
    let writeSeq = 0;
    let flushTimer = null;
    let flushInFlight = null;
    let credsDirty = false;
    let credsTimer = null;

    function cacheSet(dbKey, value) {
        if (memCache.has(dbKey)) memCache.delete(dbKey);
        memCache.set(dbKey, value);
        if (memCache.size > MAX_AUTH_CACHE) {
            const oldest = memCache.keys().next().value;
            if (oldest !== undefined) memCache.delete(oldest);
        }
    }

    // Precarga unica de claves Signal calientes al iniciar (evita cientos de
    // roundtrips a Turso durante rafagas de mensajes en grupos grandes).
    if (typeof db.getAllAuthKeys === 'function') {
        try {
            const all = await db.getAllAuthKeys(MAX_AUTH_CACHE);
            let preloaded = 0;
            for (const [k, raw] of Object.entries(all || {})) {
                if (!raw) continue;
                try {
                    cacheSet(k, JSON.parse(raw, BufferJSON.reviver));
                    preloaded++;
                } catch (_) { }
            }
            if (preloaded > 0) console.log(`⚡ [Auth] Precargadas ${preloaded} claves Signal en RAM.`);
        } catch (_) { }
    }

    function cacheGet(dbKey) {
        if (!memCache.has(dbKey)) return undefined;
        const val = memCache.get(dbKey);
        memCache.delete(dbKey);
        memCache.set(dbKey, val);
        return val;
    }

    async function writeCredsNow() {
        if (credsTimer) { clearTimeout(credsTimer); credsTimer = null; }
        if (!credsDirty) return;
        credsDirty = false;
        try {
            await db.saveAuthKey('creds', JSON.stringify(creds, BufferJSON.replacer));
        } catch (e) {
            credsDirty = true;
            console.error('❌ [Auth] Error crítico al guardar credenciales:', e.message);
        }
    }

    function saveCreds() {
        credsDirty = true;
        if (credsTimer) return Promise.resolve();
        credsTimer = setTimeout(() => {
            credsTimer = null;
            writeCredsNow().catch(() => { });
        }, CREDS_DEBOUNCE_MS);
        if (credsTimer.unref) credsTimer.unref();
        return Promise.resolve();
    }

    async function flushKeys() {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (flushInFlight) return flushInFlight;
        if (pendingWrites.size === 0) return;

        flushInFlight = (async () => {
            while (pendingWrites.size > 0) {
                const snapshot = [...pendingWrites.entries()];
                pendingWrites.clear();
                inFlightWrites.clear();
                for (const [k, item] of snapshot) inFlightWrites.set(k, item);

                const ops = snapshot.map(([key, item]) => ({
                    key,
                    op: item.op,
                    val: item.op === 'save' ? JSON.stringify(item.valObj, BufferJSON.replacer) : null
                }));

                let ok = false;
                if (typeof db.saveAuthKeysBatch === 'function') {
                    ok = await db.saveAuthKeysBatch(ops).catch(() => false);
                } else {
                    try {
                        for (let i = 0; i < ops.length; i += 10) {
                            const chunk = ops.slice(i, i + 10);
                            await Promise.all(chunk.map(t => t.op === 'save' ? db.saveAuthKey(t.key, t.val) : db.deleteAuthKey(t.key)));
                        }
                        ok = true;
                    } catch (_) { ok = false; }
                }
                inFlightWrites.clear();

                if (!ok) {
                    // Re-encolar las entradas que no fueron pisadas durante el envío
                    for (const [k, item] of snapshot) {
                        if (!pendingWrites.has(k)) pendingWrites.set(k, item);
                    }
                    break;
                }
            }
        })().finally(() => {
            inFlightWrites.clear();
            flushInFlight = null;
        });
        return flushInFlight;
    }

    function scheduleFlush() {
        if (pendingWrites.size >= 80) {
            flushKeys().catch(() => { });
            return;
        }
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushKeys().catch(() => { });
        }, AUTH_FLUSH_MS);
        if (flushTimer.unref) flushTimer.unref();
    }

    async function flush() {
        await Promise.allSettled([writeCredsNow(), flushKeys()]);
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    const missing = [];

                    for (const id of ids) {
                        const dbKey = `${type}-${id}`;
                        if (pendingWrites.has(dbKey)) {
                            const pend = pendingWrites.get(dbKey);
                            if (pend.op === 'save') data[id] = pend.valObj;
                            continue;
                        }
                        if (inFlightWrites.has(dbKey)) {
                            const inf = inFlightWrites.get(dbKey);
                            if (inf.op === 'save') data[id] = inf.valObj;
                            continue;
                        }
                        const cached = cacheGet(dbKey);
                        if (cached !== undefined) {
                            if (cached !== CACHE_MISS) data[id] = cached;
                            continue;
                        }
                        missing.push(id);
                    }

                    if (missing.length > 0) {
                        const dbIds = missing.map(id => `${type}-${id}`);
                        const results = await db.getAuthKeys(dbIds);
                        for (const id of missing) {
                            const dbKey = `${type}-${id}`;
                            const raw = results[dbKey];
                            if (raw) {
                                try {
                                    const parsed = JSON.parse(raw, BufferJSON.reviver);
                                    data[id] = parsed;
                                    cacheSet(dbKey, parsed);
                                } catch (e) {
                                    cacheSet(dbKey, CACHE_MISS);
                                }
                            } else {
                                cacheSet(dbKey, CACHE_MISS);
                            }
                        }
                    }
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const dbKey = `${category}-${id}`;
                            if (value) {
                                cacheSet(dbKey, value);
                                pendingWrites.set(dbKey, { op: 'save', valObj: value, seq: ++writeSeq });
                            } else {
                                cacheSet(dbKey, CACHE_MISS);
                                pendingWrites.set(dbKey, { op: 'del', valObj: null, seq: ++writeSeq });
                            }
                        }
                    }
                    scheduleFlush();
                }
            }
        },
        saveCreds,
        flush
    };
}

module.exports = { useTursoAuthState };
