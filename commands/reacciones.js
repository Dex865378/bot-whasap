module.exports = {
    name: '!reacciones',
    async execute(sock, chatId, msg, args, { isGroup, isAdmin, isGlobalAdmin, db, botState }) {
        if (!isGroup) {
            return sock.sendMessage(chatId, { text: '⚠️ Este comando solo funciona en grupos.' }, { quoted: msg });
        }
        if (!isAdmin && !isGlobalAdmin) {
            return sock.sendMessage(chatId, { text: '🔒 Solo los administradores pueden cambiar esta configuración.' }, { quoted: msg });
        }

        const arg = (args[0] || '').toLowerCase();
        if (arg !== 'on' && arg !== 'off') {
            const actual = await db.getReacciones(chatId);
            const estado = actual === 1 ? 'activadas' : 'desactivadas';
            return sock.sendMessage(chatId, {
                text: `⚡ *Reacciones cosméticas:* ${estado}\n\nUsa *!reacciones on* o *!reacciones off* para cambiar.`
            }, { quoted: msg });
        }

        const activar = arg === 'on';
        const ok = await db.setReacciones(chatId, activar);
        if (!ok) {
            return sock.sendMessage(chatId, { text: '❌ No se pudo guardar la configuración. Si el bot no está activado aquí, usa *!bot on* primero.' }, { quoted: msg });
        }

        if (botState.groupCache) botState.groupCache.delete(chatId);

        return sock.sendMessage(chatId, {
            text: activar
                ? '✅ *Reacciones activadas.* El bot reaccionará con emojis a los comandos.'
                : '🔇 *Reacciones desactivadas.* El bot dejará de enviar emojis de reacción.'
        }, { quoted: msg });
    }
};
