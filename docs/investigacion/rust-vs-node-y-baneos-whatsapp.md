# Rust vs Node en Render, y por qué te banearon

**Fecha de consulta de todas las fuentes: 2026-11-26.** Bot auditado: Diky Bot V3, v11.5.4, 55 archivos JS / 20.639 líneas.

## Pregunta

1. ¿Conviene migrar el bot de JavaScript a Rust para Render? ¿Las librerías de WhatsApp en Rust están a la altura de Baileys? ¿Se pierde el sistema anti-ban?
2. ¿Por qué banearon mi número la primera vez, si otros bots mandan stickers "a lo loco" y parecen no ser baneados? ¿Qué sistema anti-ban falta?

## Respuesta corta

- **Rust no reduce el riesgo de ban.** El riesgo nace del cumplimiento de los Términos de WhatsApp, no del lenguaje del servidor. WhatsApp dice explícitamente que enlazar la cuenta a versiones no oficiales "violates our Terms of Service" y que la cuenta "might also be temporarily or permanently banned" (https://faq.whatsapp.com/1217634902127718).
- **Render sí tiene runtime nativo de Rust** (build `cargo build --release`), así que el hosting no es el obstáculo (https://render.com/docs/native-runtimes, https://render.com/docs/deploy-rocket-rust).
- **El plan Free es 0.1 CPU / 512 MB** (https://render.com/docs/compute-plans) y tu bot reporta ~160 MB RSS: no estás ahogado de memoria. El costo real de `!s` es el encode con ffmpeg (`-threads 1`), que Rust no abarata salvo que reimplementes el pipeline.
- **El ecosistema Rust existe y está activo**, pero va por detrás de Baileys en adopción: `whatsapp-rust` 0.7.0 (MIT, 1.133 estrellas, ~200.000 descargas) frente a Baileys (11.744 estrellas, rc14). El camino realista no es reescribir: es `baileyrs`, API compatible con Baileys sobre Rust/WASM, todavía con gaps.
- **Tu ban encaja con número nuevo + cliente no oficial + actividad automatizada**, no con "hacer stickers". WhatsApp restringe cuentas por "spam, automated, or bulk messaging" y lista como consecuencia no poder iniciar chats con desconocidos, crear grupos ni usar dispositivos vinculados (https://faq.whatsapp.com/717472490411581).
- **"A los otros no los banean" es sesgo de supervivencia.** En la ola de octubre de 2025 se banearon bots con más de 3 años y usuarios que no usaban bots (https://github.com/WhiskeySockets/Baileys/issues/1869), y hay reportes de baneos por mandar muchos stickers rápido (https://github.com/WhiskeySockets/Baileys/pull/1561).

## 1. Migración a Rust

### 1.1 Qué cambiaría y qué no

| Aspecto | ¿Cambia con Rust? |
| --- | --- |
| Protocolo (WhatsApp Web multidispositivo) | No. Sigue siendo un cliente no oficial. |
| Riesgo de ban por política | No. Depende del comportamiento y de la huella del cliente, no del lenguaje. |
| Consumo de RAM | Sí, a favor (binario nativo vs runtime JS). |
| Arranque / cold start | Sí, a favor (sin cargar `node_modules`). |
| Tiempo de `!s` | Casi no: el trabajo pesado es ffmpeg como subproceso. |
| Costo de mantenimiento | Mucho mayor: reescritura completa. |

El bot mide hoy ~160 MB RSS y `!s` promedia ~3,2 s en Render (datos de su propio `/health` el 2026-11-26). El pipeline de stickers invoca ffmpeg con `-threads 1` y `-quality`, así que el cuello de botella es CPU del encode WebP, no el runtime.

### 1.2 Render y Rust

- Render lista Rust entre sus *native runtimes* (https://render.com/docs/native-runtimes).
- La guía oficial de Rust usa `cargo build --release` como build y `cargo run --release` como start (https://render.com/docs/deploy-rocket-rust).
- Plan Free: 0.1 CPU y 512 MB (https://render.com/docs/compute-plans). Un servicio web Free se duerme tras 15 minutos sin tráfico entrante y tarda ~1 minuto en despertar (https://render.com/docs/free).

Conclusión de plataforma: migrar no requiere Docker ni plan pago; el problema no es Render.

### 1.3 Librerías: comparación con la misma fecha

| | Baileys | whatsapp-rust | whatsmeow | baileyrs |
| --- | --- | --- | --- | --- |
| Lenguaje | TypeScript | Rust | Go | JS sobre Rust/WASM |
| Madurez visible | 11.744 estrellas, npm `7.0.0-rc14` | 1.133 estrellas, `0.7.0`, MIT, ~200.000 descargas | 7.947 estrellas, MPL-2.0 | Proyecto joven, "known gaps" |
| Autenticación | QR y pairing code | QR y pairing code | QR y pairing code | Hereda de whatsapp-rust |
| Mensajería | Texto, media, grupos, estados | Texto, media, grupos, comunidades, canales, estados, llamadas | Texto, media, grupos, app state | API compatible Baileys |
| Almacenamiento | Pluggable (Turso en tu caso) | Pluggable (SQLite por defecto) | SQLite/Postgres | — |
| Riesgo para ti | Es lo que ya corre | Reescritura + menos comunidad | Reescritura en otro lenguaje | Cambio de librería con menos rodaje |

Fuentes: https://github.com/WhiskeySockets/Baileys · https://github.com/oxidezap/whatsapp-rust · https://github.com/tulir/whatsmeow · https://github.com/oxidezap/baileyrs · https://crates.io/crates/whatsapp-rust

Dato clave: Baileys ya está incorporando Rust por dentro. El puente `whatsapp-rust-bridge` (WASM) cubre protocolo binario, libsignal, app state sync, audio, imagen y metadata de stickers, y se integró en Baileys vía los PR #1698 y #2067 (https://github.com/WhiskeySockets/whatsapp-rust-bridge). O sea: la parte crítica ya se está moviendo a Rust *sin* que reescribas el bot.

Para la base de datos, Turso es Rust de origen y publica clientes oficiales `turso`, `turso_serverless` y `libsql` (https://docs.turso.tech/sdk/rust/reference). Ese punto sí sería más limpio en Rust, pero no justifica una migración.

### 1.4 Costo real de la migración

- 55 archivos JavaScript, 20.639 líneas, 246 comandos en la whitelist.
- Dependencias no triviales: ffmpeg, generación de stickers con sonido (waveform), Turso, dashboard HTTP, lease de instancia, pool de workers PC, juegos y APIs externas.
- Una reescritura en Rust no es "traducir": es rehacer el 100% de la lógica y volver a descubrir los bugs de protocolo que Baileys ya resolvió durante años.

### 1.5 Veredicto

1. **No migrar por anti-ban**: no hay mecanismo por el que Rust evite un ban.
2. **Si el motivo es rendimiento**: primero medir. El gasto está en ffmpeg; subir a 0.5 CPU (plan de pago) es más barato y más rápido que reescribir.
3. **Camino intermedio si insistes**: actualizar Baileys a rc14 y, cuando `baileyrs` cierre sus gaps, cambiar solo la capa de socket (API compatible) sin tocar los 246 comandos.

## 2. Por qué te banearon

### 2.1 Lo que WhatsApp documenta

- **Restricciones**: la cuenta puede quedar restringida por "spam, automated, or bulk messaging". Mientras dura, no puedes iniciar chats con contactos nuevos, crear grupos, añadir miembros ni usar dispositivos vinculados (https://faq.whatsapp.com/717472490411581).
- **Apps no oficiales**: usarlas o enlazar la cuenta a ellas "violates our Terms of Service" y la cuenta "might also be temporarily or permanently banned, or it could lead to restrictions on your account, including the ability to link dev[ices]" (https://faq.whatsapp.com/1217634902127718).
- **Bans**: WhatsApp banea si cree que la actividad viola los Términos, "for example if it involves spam, scams or if it puts WhatsApp users' safety at risk" (https://faq.whatsapp.com/465883178708358).
- **Automatización y masivo**: "Our products are not intended for bulk or automated messaging, both of which have always been a violation of our Terms of Service". Matiz útil: "receiving many messages at once will not result in an account ban" (https://faq.whatsapp.com/5957850900902049).
- **Términos**: si se violan, WhatsApp puede deshabilitar o suspender la cuenta, y prohíbe crear otra sin permiso (https://www.whatsapp.com/legal/terms-of-service).
- **Apelación**: la app ofrece "Request review" al abrir WhatsApp; la mayoría de revisiones se completan en 24 h, se revisa un solo número por apelación y, si la opción no aparece, el ban es definitivo. Además: "it's possible that the previous owner of your new phone number violated our Terms of Service and this caused the account to be banned" (https://faq.whatsapp.com/465883178708358).

### 2.2 Lo que reportan los usuarios de Baileys (no oficial, pero útil)

- **Ola de octubre de 2025**: baneos masivos; afectó a bots con más de 3 años y a personas que no usaban bots; reportado en 6.7.19 y 7.0.0-rc.5 (https://github.com/WhiskeySockets/Baileys/issues/1869).
- **Grupos como disparador**: un usuario con 10 números reporta que se baneaban al publicar en grupos, y que al pasarse a Web.js dejaron de ser baneados (https://github.com/WhiskeySockets/Baileys/issues/1925). Es un reporte, no un experimento controlado.
- **Error 463 / "reachout timelock"**: WhatsApp exige un *Trusted Contact token* para escribir a contactos sin historial reciente; si no se envía, los mensajes fallan y la cuenta puede quedar restringida (https://github.com/WhiskeySockets/Baileys/issues/2707).
- **Volumen saliente**: baneos al mandar mensajes masivos incluso con 7 s entre cada uno (https://github.com/WhiskeySockets/Baileys/issues/2131).
- **Unirse a grupos grandes**: dos números baneados al entrar a un grupo con muchos miembros (https://github.com/WhiskeySockets/Baileys/issues/1901).
- **Stickers en ráfaga**: "I was getting banned for sending too many quick stickers" (https://github.com/WhiskeySockets/Baileys/pull/1561).

### 2.3 ¿Los stickers banean por sí solos?

No hay fuente que diga "los stickers banean". Lo que hay es: (a) un reporte de baneo por ráfagas de stickers rápidos (arriba), y (b) la lógica oficial de que la calidad se degrada por señales de los usuarios: **bloqueos, reportes, silencios y archivados** (https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages, sección "Message quality").

Traducción para tu caso: el sticker no es el delito; la ráfaga de media a grupos es lo que se parece a spam y, sobre todo, lo que dispara reportes. Tu cooldown de 60 s ataca la ráfaga, no la causa raíz.

### 2.4 Por qué "a los otros no"

1. **Sesgo de supervivencia**: los baneados no siguen corriendo bots que presumir. La ola de 2025 alcanzó a cuentas sin bot.
2. **Número con historial**: un número viejo con chats reales tiene más reputación que uno recién vinculado. WhatsApp incluso advierte que un número nuevo puede heredar el ban del dueño anterior (https://faq.whatsapp.com/465883178708358).
3. **Cliente distinto**: quien corre WhatsApp Web real vía navegador se ve como un dispositivo normal; un cliente de WebSocket se ve distinto a nivel de protocolo. El reporte de #1925 apunta ahí, pero Meta no lo confirma.
4. **Volumen entrante ≠ saliente**: recibir mucho no banea (fuente oficial arriba); mandar mucho sí.

### 2.5 Tu caso: hipótesis ordenadas por probabilidad

1. **Número nuevo + vínculo no oficial + actividad en grupos el primer día.** Es el escenario clásico de restricción.
2. **Ráfagas de stickers en grupos** que terminan en reportes/bloqueos de miembros (la señal que Meta documenta).
3. **Versión atrasada** (rc9 instalada frente a rc14 publicada), con bugs de protocolo ya corregidos.
4. **463/TC token** en mensajes 1:1: tu bot casi todo lo hace en grupos, donde el token no aplica, así que pesa menos.

## 3. Anti-ban: qué tienes y qué falta

### 3.1 Lo que ya tienes (verificado en el código)

- `browser: Browsers.macOS('Chrome')`, `markOnlineOnConnect: false`, `syncFullHistory: false`.
- Simulación de "escribiendo" (`sendPresenceUpdate('composing')` / `'paused'`) antes de responder.
- Cola de salida con delays, cooldowns por usuario/global/grupo, deduplicación de comandos.
- Candado de instancia única en Turso (evita dos procesos con la misma sesión).
- Backoff específico para 403/419 y reconexión controlada.
- Lectura de mensajes (`readMessages`) antes de procesar.

### 3.2 Lo que falta o está débil

1. **Actualizar Baileys** de `7.0.0-rc.9` a `7.0.0-rc14` (versión publicada en npm el 2026-11-26).
2. **463 / Trusted Contact**: Baileys rc9 solo *guarda* el `tctoken` que llega y lo adjunta al enviar; no lo pide ni lo refresca (verificado en `lib/Socket/messages-send.js` y `messages-recv.js`). Si el bot escribe a desconocidos por privado, ese es un vector real.
3. **Calentamiento del número**: no hay documento oficial con números; es práctica de la industria. Tratarlo como no confirmado.
4. **Límites por chat y por día**, no solo por comando: hoy el candado es por comando y por grupo/minuto.
5. **No entrar a grupos grandes de golpe** (reporte #1901).
6. **Plan de reemplazo**: si banean, no crear otra cuenta con el mismo número sin revisión; y no clonar la sesión en dos servicios.
7. **Reportes**: no hay API para saber quién te reportó; la única mitigación real es no dar motivo (menos ruido, contenido útil).

## 4. Lo que no se pudo confirmar

- Umbrales oficiales de mensajes/minuto o stickers/minuto: WhatsApp no los publica.
- Que Rust (o cualquier lenguaje) evite la detección: no existe fuente; WhatsApp detecta cliente y comportamiento, no el runtime.
- El caso "Web.js no banea" es un reporte de usuario, sin grupo de control.
- No se midió un port real a Rust; las afirmaciones de rendimiento son sobre el pipeline actual (ffmpeg).

## 5. Fuentes

| Fuente | URL | Fecha |
| --- | --- | --- |
| WhatsApp — cuentas restringidas | https://faq.whatsapp.com/717472490411581 | consultado 2026-11-26 |
| WhatsApp — uso no autorizado de automatización/masivo | https://faq.whatsapp.com/5957850900902049 | consultado 2026-11-26 |
| WhatsApp — apps no oficiales | https://faq.whatsapp.com/1217634902127718 | consultado 2026-11-26 |
| WhatsApp — cuentas baneadas | https://faq.whatsapp.com/465883178708358 | consultado 2026-11-26 |
| WhatsApp — Términos de servicio | https://www.whatsapp.com/legal/terms-of-service | consultado 2026-11-26 |
| Baileys — repo | https://github.com/WhiskeySockets/Baileys | consultado 2026-11-26 |
| Baileys — issue #1869 (ola de baneos) | https://github.com/WhiskeySockets/Baileys/issues/1869 | 2025-10-05 |
| Baileys — issue #1925 (grupos/Web.js) | https://github.com/WhiskeySockets/Baileys/issues/1925 | 2025-10-14 |
| Baileys — issue #2707 (463 reachout timelock) | https://github.com/WhiskeySockets/Baileys/issues/2707 | 2026-07-14 |
| Baileys — issue #2131 (volumen saliente) | https://github.com/WhiskeySockets/Baileys/issues/2131 | 2025-11-29 |
| Baileys — issue #1901 (grupo grande) | https://github.com/WhiskeySockets/Baileys/issues/1901 | 2025-10-11 |
| Baileys — PR #1561 (stickers en ráfaga) | https://github.com/WhiskeySockets/Baileys/pull/1561 | 2025-06-30 |
| whatsapp-rust | https://github.com/oxidezap/whatsapp-rust | consultado 2026-11-26 |
| whatsapp-rust (crate) | https://crates.io/crates/whatsapp-rust | consultado 2026-11-26 |
| whatsapp-rust-bridge (WASM) | https://github.com/WhiskeySockets/whatsapp-rust-bridge | consultado 2026-11-26 |
| baileyrs (API Baileys sobre Rust) | https://github.com/oxidezap/baileyrs | consultado 2026-11-26 |
| whatsmeow (Go) | https://github.com/tulir/whatsmeow | consultado 2026-11-26 |
| Render — native runtimes | https://render.com/docs/native-runtimes | consultado 2026-11-26 |
| Render — deploy Rust (Rocket) | https://render.com/docs/deploy-rocket-rust | consultado 2026-11-26 |
| Render — compute plans | https://render.com/docs/compute-plans | consultado 2026-11-26 |
| Render — free tier | https://render.com/docs/free | consultado 2026-11-26 |
| Turso — SDK Rust | https://docs.turso.tech/sdk/rust/reference | consultado 2026-11-26 |
| Meta — calidad de mensajes | https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages | consultado 2026-11-26 |
| Meta — Groups API (solo OBA, máx 8) | https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/ | consultado 2026-11-26 |
