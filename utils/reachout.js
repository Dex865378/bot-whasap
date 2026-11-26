/**
 * 🚦 REACHOUT TIMELOCK / ERROR 463
 *
 * WhatsApp restringe cuentas cuando su actividad parece spam/automatizada:
 * mientras dura la restricción no se pueden iniciar chats con desconocidos
 * ni unirse a grupos nuevos. Baileys rc14 ya pide el token (tctoken) y
 * reintenta solo; este módulo solo clasifica el error y normaliza el estado
 * que el bot muestra en /health. No bloquea envíos por su cuenta.
 */
'use strict';

const CODIGO_463 = 463;

function esError463(err) {
    if (!err) return false;
    const codigos = [err.data, err.statusCode, err?.output?.statusCode, err?.data?.statusCode];
    if (codigos.some(c => Number(c) === CODIGO_463)) return true;
    const msg = String(err.message || '').toLowerCase();
    if (msg.includes('reachout timelock') || msg.includes('reachout_time_lock')) return true;
    return /\b463\b/.test(msg);
}

function normalizarReachout(raw) {
    const activo = Boolean(raw && raw.isActive);
    const tipo = raw && raw.enforcementType && raw.enforcementType !== 'DEFAULT'
        ? String(raw.enforcementType)
        : null;
    const fin = raw && raw.timeEnforcementEnds ? new Date(raw.timeEnforcementEnds).getTime() : NaN;
    const expiraEn = Number.isFinite(fin) ? fin : null;
    return {
        restringido: activo,
        tipo,
        expiraEn,
        segundosRestantes: expiraEn === null ? null : Math.max(0, Math.round((expiraEn - Date.now()) / 1000)),
    };
}

function esActualizacion463(item) {
    const params = item?.update?.messageStubParameters;
    if (!Array.isArray(params) || params.length === 0) return false;
    return Number(params[0]) === CODIGO_463 || params.some(p => Number(p) === CODIGO_463);
}

module.exports = { esError463, esActualizacion463, normalizarReachout, CODIGO_463 };
