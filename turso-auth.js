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
    let cancelled = false;

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
        if (cancelled || !credsDirty) return;
        credsDirty = false;
        try {
            await db.saveAuthKey('creds', JSON.stringify(creds, BufferJSON.replacer));
        } catch (e) {
            if (!cancelled) credsDirty = true;
            console.error('❌ [Auth] Error crítico al guardar credenciales:', e.message);
        }
    }

    function saveCreds() {
        if (cancelled) return Promise.resolve();
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
        if (cancelled) return;
        if (flushInFlight) return flushInFlight;
        if (pendingWrites.size === 0) return;

        flushInFlight = (async () => {
            while (!cancelled && pendingWrites.size > 0) {
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

                if (!ok && !cancelled) {
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
        if (cancelled) return;
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
        if (cancelled) return;
        await Promise.allSettled([writeCredsNow(), flushKeys()]);
    }

    // Evita que escrituras diferidas resuciten credenciales viejas tras resetAuthSession().
    function cancelPending() {
        cancelled = true;
        credsDirty = false;
        if (credsTimer) { clearTimeout(credsTimer); credsTimer = null; }
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        pendingWrites.clear();
        inFlightWrites.clear();
        memCache.clear();
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
        flush,
        cancelPending
    };
}

/**
 * Clasifica códigos de desconexión no autorizados (401/403/419/loggedOut)
 * aplicando backoff gradual antes de invalidar credenciales en Turso.
 */
function clasificarDesconexionAuth(code, counters = {}, disconnectReason = {}) {
    const c401 = counters.errores401 || 0;
    const c403 = counters.errores403 || 0;
    const loggedOutCode = disconnectReason.loggedOut ?? 401;
    const forbiddenCode = disconnectReason.forbidden ?? 403;

    const es401 = code === loggedOutCode || code === 401;
    const es403 = code === forbiddenCode || code === 403 || code === 419;

    if (!es401 && !es403) {
        return { handled: false, shouldReset: false, errores401: 0, errores403: 0 };
    }

    if (es401) {
        const next = c401 + 1;
        if (next >= 5) {
            return {
                handled: true,
                shouldReset: true,
                reason: 'logout/401',
                waitMs: 10000,
                status: 'Reiniciando con sesión limpia...',
                errores401: 0,
                errores403: 0,
            };
        }
        const waitMs = Math.min(next * 20000, 60000);
        return {
            handled: true,
            shouldReset: false,
            waitMs,
            status: `Error 401 (${next}/5). Reintentando...`,
            errores401: next,
            errores403: 0,
        };
    }

    // 403/419 (forbidden): backoff gradual, NUNCA borrar sesión automáticamente.
    // Tras 5 intentos seguidos, dejar de reintentar (shouldStop) y esperar
    // reinicio manual desde el dashboard.
    const next = c403 + 1;
    if (next >= 5) {
        return {
            handled: true,
            shouldReset: false,
            shouldStop: true,
            reason: `forbidden/${code}`,
            waitMs: 0,
            status: `⛔ Error ${code} persistente — reinicia manualmente cuando el número esté habilitado`,
            errores401: 0,
            errores403: next,
        };
    }
    const waitMs = Math.min(next * 20000, 60000);
    return {
        handled: true,
        shouldReset: false,
        shouldStop: false,
        waitMs,
        status: `Error ${code} (${next}/5). Reintentando en ${Math.round(waitMs / 1000)}s...`,
        errores401: 0,
        errores403: next,
    };
}

module.exports = { useTursoAuthState, clasificarDesconexionAuth };
