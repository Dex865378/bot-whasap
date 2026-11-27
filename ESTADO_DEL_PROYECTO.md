# 😺 MEMORIA DE DIKY BOT V3 - [Actualizado: 2026-02-27 21:15]

Este documento es la BIBLIA del proyecto. TODO asistente DEBE leerlo PRIMERO antes de tocar cualquier archivo.

---

## 🚨 ADVERTENCIAS CRÍTICAS (LEER PRIMERO)

### ❌ LO QUE NUNCA DEBES HACER:
1. **NO COMENTAR ni desactivar la autenticación de Turso** (`useTursoAuthState()`). Si lo haces, Render pierde la sesión en cada redeploy.
2. **NO quitar `fetchLatestBaileysVersion()`**. Sin esto el bot da Error 405 infinito.
3. **NO mover el bloque de "Registro Automático de Nombre"** arriba de la definición de `isCommand`. Causa un `ReferenceError` y el bot deja de responder.
4. **NO ignorar el `B-ID` en `!ping`**. Si ves que el ID cambia entre mensajes, significa que hay dos instancias corriendo en Render y hay que apagar la vieja.
5. **NO quitar el Heartbeat (setInterval)**. Es vital para que Turso mantenga la sesión viva en el plan gratuito de Render.
6. **NO editar `index.js` para añadir comandos**. Ahora se deben añadir en la carpeta `commands/` siguiendo la estructura modular.
7. **NO reducir la lista de países en `!bandera`**. La base de datos debe mantener siempre los 196 países registrados en `triviaData.js`.
8. **NO cambiar el temporizador de 1 minuto** en el comando `!bandera`. Es una mecánica de "Muerte Súbita" que debe permanecer inalterable.

- **Rango y Prestigio Dinámico**: 
    - **Nuevos Rangos:** Estudiante, Genin, Chunin, Jonin, Jonin Especial, Kage, Sannin, Maestro Elemental y Deidad.
    - **Títulos de Prestigio:** Al usar `!prestigio`, el usuario gana el título permanente "🌌 Ascendente X".
    - **XP Duplicado:** Se ha duplicado el XP necesario para subir del nivel. Ahora el requerimiento es `Nivel * 200`.
- **🏹 Expansión Masiva de Aventura (150+ ítems):** Se ha llevado la variedad al límite. Cada comando (`!pescar`, `!cazar`, `!minar`) cuenta ahora con **50 ítems exclusivos**, desde basura común hasta objetos ancestrales y míticos.
- **⚖️ Sistema de Subastas Globales:** Los usuarios pueden subastar sus ítems raros con `!subastar`. Otros postores pueden usar `!ofertar` en tiempo real. Sistema automatizado de cobro y entrega.
- **🛡️ Escudo vs Silencio:** El **Escudo de Oro** protege contra la **Tarjeta Silencio**.
- **Ajuste de Bandera:** Multiplicador de apuesta reducido a **1.1x**.
- **Persistencia Inmortal:** `seConectoAlgunaVez` para sesiones estables.

---

## 🚀 ESTADO GENERAL
- **Nombre:** Diky Bot V3
- **Motor:** Baileys v7.0.0-rc14
- **Hosting:** Render (Cloud) - Plan Free (512MB RAM)
- **Base de Datos:** Turso Cloud
- **Persistencia:** Turso Cloud (Heartbeat 10 min) + Local fallback.
- **Repositorio:** [GitHub - Dex865378/bot-whasap](https://github.com/Dex865378/bot-whasap)

## 🧠 CACHE DE STICKERS (v11.6.0)
- `!s` calcula una clave con el `fileSha256` de la imagen/video antes de descargar. Si ya existe, reenvía el sticker por `relayMessage` sin volver a descargar, convertir con FFmpeg ni subir a WhatsApp.
- La clave incluye el tipo de media y el audio citado: la misma imagen con otro audio se procesa de nuevo. Un video con audio y el mismo video mudo no comparten entrada.
- Se guarda solo el "recibo" de subida (`url`, `directPath`, `mediaKey`, hashes, `waveform`, etc.), no el WebP completo: ~300-500 bytes por entrada, máximo 500 en RAM y 500 en Turso (`stickers_cache`).
- Si el sticker esperaba audio y el audio falló, NO se cachea el sticker mudo. Si el reenvío falla o la URL firmada (`oe`) venció, se borra/descarta la entrada y se regenera normalmente.
- `/health` expone `stickersCache` (`ram`, `hits`, `misses`, `saved`, `errors`).

## 🛠️ ARQUITECTURA TÉCNICA (MODULAR V3)

### Estructura de Archivos:
- `index.js`: Motor principal, conexión y enrutamiento ligero.
- `commandHandler.js`: Cargador dinámico de módulos de comandos.
- `gameResponder.js`: Gestor centralizado de respuestas para juegos activos (trivia, ahorcado, etc.).
- `database.js`: Operaciones de DB (Turso/SQLite).
- `commands/`: Carpeta con módulos categorizados (casino, economy, fun, main, media, ping, pptx, settings, social_reactions, trivia).

### Sistema de Comandos:
- Cada archivo en `commands/` exporta un objeto con `name`, `names` (array de disparadores) y `execute`.
- Se usa un objeto `extras` compartido para pasar utilidades (db, botState, socket, etc.) a los módulos.

## 💰 SISTEMA ECONÓMICO (ACTUALIZADO)
- **Moneda:** diky.
- **Clases (`!clase`):** Sistema de profesiones (Cazador, Pescador, Apostador, Empresario, Hacker) con bonos pasivos.
- **Logros:** Medallas visuales permanentes en `!perfil` (Millonario, Leyenda, Gladiador).
- **Comandos:** `!daily`, `!w` (trabajo), `!slut`, `!tienda`, `!comprar`, `!dar`, `!clase`, `!perfil`.
- **Ranking:** `!mejor` muestra el Top 20 de nivel y riqueza.

## 🐛 HISTORIAL DE CAMBIOS Y CORRECCIONES (Últimas 24h)

### Expansión de Geografía y Reforma Económica (2026-02-26)
- **Nuevo Sub-comando `!bandera capitales`**: Añadida modalidad de adivinar capitales con nombres complejos.
    - **Lógica de Dificultad:** El bot prioriza nombres largos y difíciles (70% de probabilidad).
    - **Apuestas en Trivia:** Implementado sistema de dinero en juego (`!bandera [sub] [monto]`) con pago de x3 al ganar.
- **Sistema de Clases (`!clase`)**: Los usuarios ahora pueden elegir una profesión que otorga bonos específicos (ej: Hacker tiene -10% de descuento en la tienda).
- **Sistema de Logros**: Añadidas columnas `clase` y `logros` en la DB. Los logros se desbloquean por hitos (100k dikys, Nivel 50, 50 victorias en duelos).
- **Overhaul de Casino (`!slot`)**:
    - Probabilidad de ganar aumentada al 50%.
    - Coste de entrada aleatorio entre 50 y 100 dikys.
    - Recompensa fija de 500 dikys (más bonos de clase).
- **Remodelación de la Tienda**: Ítems organizados por categorías (Básicos, Protección, Especiales, Míticos).
    - **Nuevos Ítems:** Anillo de Bodas, Guardaespalda, Grimorio de Diky, Ticket Lotería.
- **Eliminación de Contenido Obsoleto**:
    - Se eliminó el comando `!deseo` y todas las referencias a las "Esferas del Dragón" por petición del usuario.
    - Limpieza del inventario inicial del "Modo Dios".
- **Correcciones Menores:** Ajustados mensajes de victoria en `gameResponder.js` para ser dinámicos según el tipo de trivia.

### Sistema de Prestigio y Lotería Automática (2026-02-26 14:05)
- **Sistema de Prestigio (Endgame)**: Los usuarios que alcancen el **Nivel 500** pueden usar `!prestigio` para reiniciar a nivel 1 a cambio de un rango de prestigio permanente que otorga un multiplicador de monedas acumulativo (10% por rango).
- **Lotería Global Automática**: Se ha implementado un sorteo de lotería que ocurre cada 6 horas. Los usuarios compran tickets en la tienda (`!comprar 3`) para participar. El pozo se acumula con cada compra.
- **Activación Instantánea de Ítems**: Los ítems de la tienda (`!tienda`) ahora se activan automáticamente al comprarlos.
    - **Ítems de Tiempo:** Pico, Cebo, Escudo y Guardaespalda activan beneficios por 2 horas.
    - **Pociones/Frutas:** Se consumen inmediatamente otorgando XP o efectos aleatorios (títulos, dinero).
- **Media Search V2 (Jikan Integration)**: Mejorados los comandos `!anime` y `!manga`.
    - **Híbrido Manga:** `!manga` busca primero en el catálogo local y, si no existe, busca en la base de datos mundial de MyAnimeList.
    - **Formatos Enriquecidos:** Resultados con géneros, estudios, autores, puntuaciones y links directos.
- **Seguridad en DB**: Implementada columna `prestigio` y temporizadores de ítems en Turso.

### Correcciones de Estabilidad y Variedad (2026-02-26 21:25)
- **Equilibrio en Duelos (`!duelo`)**: Se randomizó el atacante inicial y se corrigió la lógica de victoria para evitar que el iniciador gane siempre por ventaja de turno.
- **Variedad en Trivia (`!bandera`)**: Eliminada la lógica que priorizaba países con nombres largos (70% de probabilidad). Ahora la selección es 100% aleatoria para evitar repeticiones constantes.
- **Restauración de Comandos Fun**: Implementados los comandos que faltaban en `fun.js` (`!8ball`, `!dado`, `!moneda`, `!ship`, `!love`, `!gay`, `!iq`, `!suerte`, `!horoscopo`, `!ppt`).

### Expansión de Clases y Corrección de Perfil (2026-02-26 21:30)
- **Nuevas Clases Añadidas**: Implementadas 4 nuevas profesiones en `!clase`:
    - **Minero**: +15% de monedas en `!minar`.
    - **Guerrero**: +10% de daño en `!duelo`.
    - **Mercader**: +20% de probabilidad de ganar en subastas.
    - **Sacerdote**: Multiplicador de XP x1.5 permanente en todos los comandos.
- **Corrección de Perfil (`!perfil`)**: Se corrigió el error donde el Rango de Prestigio no aparecía. Ahora se muestra claramente el nivel de prestigio y el multiplicador de monedas actual.
- **Sincronización de XP**: La lógica de la DB ahora reconoce el bono de clase del Sacerdote al ganar XP.

### Reforma de Mecánicas en Banderas (2026-02-26 21:35)
- **Nuevo Modificador en `!bandera`**: Se eliminó el sistema de 3 vidas.
    - **Muerte Súbita**: Una respuesta incorrecta ahora resulta en la pérdida inmediata del juego y la apuesta.
    - **Límite de Tiempo**: Se implementó un temporizador estricto de **1 minuto**. Si el usuario no responde en ese tiempo, el bot cancela el juego y el usuario pierde su apuesta automáticamente.
- **Sincronización de Temporizadores**: Se añadió lógica para limpiar los procesos de fondo una vez que el usuario responde, optimizando el uso de memoria.

### Ajuste de Dificultad: Prestigio Escalonado (2026-02-26 21:55)
- **Escalamiento de Prestigio**: Se modificó el comando `!prestigio` para que el requisito de nivel aumente en **+500 niveles** por cada ascenso.
    - **Nivel 500**: Requerido para Prestigio 1.
    - **Nivel 1000**: Requerido para Prestigio 2.
    - **Nivel 1500**: Requerido para Prestigio 3 (y así sucesivamente).
- **Interfaz de Prestigio**: El mensaje de advertencia ahora muestra dinámicamente cuántos niveles le faltan al usuario basándose en su rango actual.

### Megay-Expansión de Tienda y Sistema Alfabético (2026-02-26 22:35)
- **Tienda DIKY V3**: Añadidos nuevos objetos:
    - **🧭 Brújula del Destino**: Otorga suerte extra en exploraciones.
    - **🍀 Poción de Suerte**: Aumenta el multiplicador de premios en juegos por 2h.
    - **✨ Fragmento Estelar**: Objeto de colección rarísimo para futuras actualizaciones.
- **Poderes de la Fruta del Diablo**: Implementada una lista masiva de efectos (titles de fuego/hielo/rayo, grandes sumas de dinero y XP, pero también efectos negativos por "fruta podrida").
- **Grimorio de Diky (Reforma Mítica)**: Ahora el grimorio es un ítem de "Un solo uso" extremadamente poderoso que puede:
    - Ganar **100,000 dikys** de golpe.
    - Subir **+50 niveles** y **+1 Prestigio** instantáneamente.
    - Otorgar títulos ancestrales como "Archimaggo Supremo".
- **Sistema de Banderas Alfabético**: Para eliminar la repetición, la trivia ahora sigue un ciclo estricto de la **A a la Z**. Cada vez que se usa el comando, el bot busca un lugar que empiece por la siguiente letra del alfabeto, reiniciándose al llegar a la Z.

### Restauración Masiva de Geografía y Reforma de Media (2026-02-27)
- **Base de Datos Masiva (`triviaData.js`)**: Restaurados los **196 países del mundo** con sus respectivas banderas y pistas personalizadas.
    - **Expansión de Categorías**: Añadidas 19 nuevas provincias/estados y 19 capitales complejas.
    - **Sistema Alfabético**: La trivia ahora sigue un ciclo de la **A a la Z** para evitar repeticiones.
- **Corrección de Pinterest (`!pinterest`)**: Implementado sistema de manejo de errores y servicio de respaldo (Fallback) con Pollinations AI.

### Integración Global de IA y Mejoras de Estabilidad (2026-02-27 Final)
- **🧠 Nueva IA: Liquid AI LFM 2.5 (1.2B Thinking)**: 
    - Migración total a OpenRouter para usar modelos de "pensamiento".
    - **Detección Universal:** El bot ahora responde a **todos los usuarios** por nombre ("Diky"), tag (@bot) o Reply.
    - **Filtro de Mensajes:** La IA solo procesa texto, ignorando multimedia para ahorrar recursos.
- **🛡️ Sistema de Resiliencia de IA**:
    - **Rotación de Llaves:** Soporte para múltiples API Keys separadas por coma.
    - **Fallback a Gemini:** Respaldo automático a **Gemini 1.5 Flash** si falla OpenRouter.
- **🖼️ Solución a errores visuales**: 
    - **Fix "Borde Rojo":** Descarga automática a buffer para `!pinterest` y `!waifu`.
    - **Búsqueda Multi-palabra:** Pinterest ahora detecta frases completas separadas por comas.
- **📦 Documento Maestro de Configuración**: Creado `CONFIGURACION_RENDER.md` como respaldo crítico de credenciales.
### Parche v11.1: Estabilización de Manga y Casino (2026-02-27)
- **Corrección de Catálogo de Mangas**: 
    - Corregida la ruta de `mangas.json` (estaba apuntando a una carpeta inexistente).
    - Arreglada la propiedad `.resumen` que causaba que las descripciones locales no se mostraran.
    - Soporte para portadas automáticas (`portada.png`) en el comando `!manga`.
    - Comando `!leer` mejorado con soporte para `.png`, `.webp` y un orden alfanumérico estricto.
- **Seguridad y Balance en !minas**:
    - **Bloqueo de Intrusos:** Ahora solo el usuario que inicia el juego puede enviar números.
    - **Ajuste de Bombas:** Reducido de 5 a 3 bombas. El juego ahora es matemáticamente ganable (antes era imposible ganar).
- **Nuevo Comando !sincronizar**: Permite al Administrador Maestro sincronizar manualmente el archivo JSON con la base de datos Turso Cloud.

### Optimización Crítica de Rendimiento (2026-03-05)
- **Procesamiento de Mensajes Concurrente**: Eliminada la ejecución secuencial. El bot ahora procesa mensajes en paralelo, evitando que comandos pesados (IA) bloqueen el resto del chat.
- **Eficiencia en Turso Cloud**: Implementada recuperación de claves de sesión por lotes (`getAuthKeys`). Reduce las llamadas a la red durante el inicio y la reconexión.
- **Caché Inteligente de Grupos**: Sistema de caché con TTL de 5 min para configuraciones de grupo y administradores, minimizando consultas a la base de datos.
- **Acciones No Bloqueantes**: Los logs de estadísticas y registros de racha ahora se ejecutan en segundo plano (sin `await` innecesario) para acelerar la respuesta al usuario.
- **Throttling de IA**: Control de concurrencia para evitar saturar las APIs de OpenRouter/Gemini.

### Reforma de Perfil: Enfoque en Waifus (2026-03-11)
- **Limpieza de Perfil (`!perfil`)**: 
    - Se eliminó la sección de **"Últimas Actividades"** (historial de pescas/cazas) para un diseño más limpio.
    - Se mantuvo la **"Mejor Pesca"** como récord personal.
- **Integración de Top Waifu**: 
    - Añadida sección **"👑 Top 1 Waifu"** en el perfil, que muestra automáticamente la primera waifu de la lista personalizada del usuario (`!waifus top`).
- **Sincronización de Inventario**: La lógica del perfil ahora parsea el inventario en tiempo real para extraer el ranking de waifus.

### Rendimiento para Render Free 512MB — v11.1.0 (2026-11-18)
Plan completo en `PLAN_RENDIMIENTO_RENDER.md`. Resumen de lo aplicado:
- **Estadísticas en 1-3 requests**: `flushStatsBatch` ya no hace SELECT+UPDATE por usuario. Usa `registrarComandosBatch` / `actualizarRachasBatch` / `sumarActividadBatch` con `dbClient.batch` y UPSERT atómico. Antes: hasta ~200 roundtrips por minuto con 100 usuarios activos.
- **Rachas en SQL**: `actualizarRachasBatch` replica la lógica de `actualizarRacha` con CASE (misma semántica, verificada contra libSQL local).
- **Cola de salida adaptativa**: piso de 80ms (`PERF_QUEUE_MIN_MS`) en vez de 250ms fijos; si el chat viene de un timeout/429, `esChatLento()` lo devuelve a 250ms por 5 min.
- **ffmpeg**: detección de animado por firma del buffer (GIF/WebP animado/MP4) para NO convertir dos veces; `-threads` acotado (1 video / 2 imagen); `MAX_PROCESOS` default 3 (antes 9) por thrashing de CPU.
- **Arranque**: `db.init()` y `fetchLatestBaileysVersion()` en paralelo; sync de los 21 mangas en segundo plano (antes bloqueaba el handler de conexión).
- **Red**: agentes HTTP con keep-alive compartidos por todo axios (~100-300ms menos por llamada a APIs externas).
- **Estabilidad**: semáforo de 16 mensajes en vuelo (`PERF_MAX_MSG_CONCURRENT`), tope del mapa de deduplicación, un solo par de handlers de `SIGINT`/`SIGTERM`.
- **Bug corregido**: `activarModoAdmin` / `activarAntiSpam` / `activarModoManga` devolvían `true` aunque el UPDATE afectara 0 filas (grupo nunca activado con `!bot on`). Ahora devuelven si se guardó de verdad y los comandos avisan.
- **Seguridad**: eliminadas las claves de OpenRouter (IA ya removida) de `CONFIGURACION_RENDER.md` y `CONFIGURACION_HUGGINGFACE.md`; token de HF movido de `.git/config` a `bot_whatsapp_2_credenciales_render.txt` (ignorado por git).

### Fix !toimg — WebP animado (2026-11-19)
- **Causa real**: los stickers de WhatsApp son WebP **animados** y **NINGUNA versión de ffmpeg los decodifica** (verificado en 5.1, 6.0 y 7.0: `Invalid data found when processing input`). `dwebp` de libwebp tampoco los soporta. Por eso `!toimg` fallaba con cualquier sticker animado, que es la mayoría.
- **Solución**: `utils/media.primerFrameWebp()` extrae el **primer frame** del contenedor RIFF en JS puro (chunk `ANMF` → WebP fijo, agregando `VP8X` si el frame trae `ALPH`) y ese frame sí lo convierte ffmpeg. Sin dependencias nuevas ni binarios extra.
- `!toimg` ahora: detecta animado por `isAnimated` **o** por magic bytes, extrae el frame, convierte con `-frames:v 1`, y borra los temporales siempre (`finally`).
- Probado de punta a punta con ffmpeg real: animado con alpha → PNG 53 KB en ~117 ms; animado sin alpha y fijo → PNG 49 KB en ~100 ms.
- **Ojo**: nunca usar `ffmpeg` directo sobre un sticker animado; siempre pasar por `primerFrameWebp()` primero.

---
*Documento actualizado por Antigravity (IA) — 2026-03-11 17:27 EST*

### Candado de instancia única (v11.3.0, 2026-11-19)
- **Causa raíz de los `440 / Bad MAC / Key used already` en bucle**: el repo estaba conectado a **DOS servicios de Render** (`srv-dbr2q6on74is73d60o80` = `bot-manga-whatsapp.onrender.com`, el bueno, y `srv-da8b3e0ae00c73cd4rgg`, duplicado creado cuando el bot "se apagó" — era solo Render Free dormido). Dos procesos con la MISMA sesión de WhatsApp se descifran los mensajes entre sí: cada mensaje se puede descifrar UNA vez por sesión → el que pierde tira `MessageCounterError` / `Bad MAC` en bucle, y ambos se patean con 440. Cada push redeploya a los dos.
- **`/instancias` (endpoint nuevo)** lista las instancias vivas (latido cada 30 s en Turso, tabla `bot_instancias`): id, servicio, commit desplegado, uptime, conectado. **total > 1 = hay duplicado**.
- **Candado**: al arrancar, si hay otra instancia viva (latido < 45 s), la segunda NO abre el socket de WhatsApp (dashboard y /health siguen arriba) y reintenta cada 15 s. Gana la de mayor uptime (empate → id menor): un duplicado tardío nunca le roba la sesión al que ya sirve. `apagar()` marca la instancia muerta al momento, así un reinicio limpio no espera latidos de procesos muertos.
- **Ojo con la columna**: `commit` es palabra reservada de SQLite; la columna se llama `commit_sha`.
- **Regla**: NUNCA crear un segundo servicio de Render apuntando a este repo. Solo existe `srv-dbr2q6on74is73d60o80` (`bot-manga-whatsapp.onrender.com`). Si el bot "se apaga", es Render Free dormido/suspendido: revisar el dashboard, no crear otro.

### Sticker con sonido: fix de reproducción + velocidad (v11.4.0, 2026-11-19)
- **Causa del "toco y sale error"**: el `audioMessage` embebido llegaba **sin `waveform`** (Baileys la calcula con `audio-decode`, peerDependency opcional que no está instalada, y se la salta en silencio). Toda nota de voz real de WhatsApp lleva waveform y `seconds` > 0 (formato corregido en v11.4.3: ver abajo). Ahora se genera con ffmpeg en el MISMO pase que extrae el OGG (PCM 8 kHz → picos → empaquetado 5-bit LSB-first) y se fuerza `seconds` >= 1. Test de regresión: `scripts/test-sticker-audio.js` decodifica el campo 26 y exige seconds+waveform.
- **Velocidad `!s`** (tardaba ~10-20 s en Render por el encode WebP en 0.1 vCPU):
  1. Audio y WebP ahora corren **en paralelo** (el audio es liviano, el WebP pesa).
  2. Extracción de audio + PCM de waveform: **un solo pase de ffmpeg con dos salidas** (antes dos pases).
  3. Encode WebP de video: `compression_level 3→1`, `lanczos→bilinear`, `fps 10→8` (~-40% de CPU medida local; los ratios se trasladan a Render).
  - Baseline producción: `!s` promedio 10.4 s (métricas de /health). Comparar después del deploy.
- **Repo movido**: GitHub ahora es `Dex865378/bot-whasap` (el viejo `bot-manga-whatsapp` queda como remote `github-viejo`).

### Sticker con sonido: waveform real de 64 bytes (v11.4.3, 2026-11-24)
- **Causa del "no se pudo reproducir el sonido"**: el waveform se generaba con **63 muestras empaquetadas a 5 bits = 40 bytes**, pero WhatsApp (y Baileys en `getAudioWaveform`) espera **64 bytes directos, uno por muestra, con valores 0-100**. Un buffer de 40 bytes no es el formato del campo `AudioMessage.waveform` y el cliente rechaza la reproducción.
- **Fix**: `prepararAudioParaSticker()` ahora calcula 64 promedios de amplitud del PCM 8 kHz, los normaliza contra el máximo y escribe un byte 0-100 por muestra. Audio mudo queda en 1 (no cero) para conservar una forma de onda mínima.
- **Decoder de entrada**: el wrapper de `StickerMessage.decode` capturaba `reader.pos` DESPUÉS de decodificar (ya al final), y además el escaneo saltaba un byte con `r.pos += r.uint32()`. Ahora captura posición/límite antes y lee el largo primero. Esto permite ver el `AudioMessage` real de stickers con sonido recibidos (`[SONIDO-DE-VERDAD]` en logs).
- **Tests**: `scripts/test-sticker-audio.js` exige waveform de 64 bytes con valores 0-100 y que `proto.Message.decode()` recupere el campo 26 de un sticker entrante. Antes del fix ambos fallaban.

### Aviso de los 60 s que nunca salía (v11.5.4, 2026-11-24)
- **Síntoma**: al pegar el cooldown de stickers el bot debía avisar `⏳ Espera X s`, pero el mensaje no aparecía nunca.
- **Causa raíz**: el cooldown global de 4 s se evaluaba ANTES del límite de 60 s por usuario (`if (globalStickerWait > 0) return;`). Quien reintentaba enseguida —el caso normal— moría en silencio en el global y jamás llegaba al aviso.
- **Fix**: `consultarCooldown()` consulta SIN marcar el turno y va primero; el turno del usuario (`!s-user`) se marca recién al final, cuando el sticker sí se va a hacer. Así un rechazo por cooldown global o cupo de grupo no castiga 60 s de gusto.
- **Diagnóstico**: `/health` ahora trae `stickerGate { userHits, notices, adminSkip }`.
- **Ojo al probar**: los números de `NUMERO_ADMIN` no pasan por el candado (se cuentan en `adminSkip`); con el número del dueño el aviso no sale por diseño.
- **Test**: `npm run test-anti-ban` exige que el chequeo por usuario quede antes del global (falla con el orden viejo).
### Perfil de máxima calidad de stickers (v11.7.0, 2026-11-27)
- **Motivo**: el bot corría con los perfiles pensados para Render (0.1 vCPU): 384 px, calidad 40, compresión 1 y scaler bilinear. En una PC eso es tirar calidad a la basura.
- **Nuevo**: `STICKER_CALIDAD=alta` activa `PERFILES_VIDEO_ALTA` en `utils/stickerProcessor.js`: 512 px, calidad 78, compresión 4 y scaler **lanczos**. Si el WebP pasa el tope de 920 KB, cae a 512/62, luego 384/48, 320/36 y 256/28 (antes de reventar el límite de WhatsApp).
- **Imagen fija**: con calidad alta sube de `-quality 75/-compression_level 4` a `90/5`, mismo 512 px lanczos.
- **Audio**: `STICKER_AUDIO_PARALELO=1` vuelve a correr WebP y audio a la vez (antes secuencial por los 512 MB de Render) y `STICKER_VIDEO_THREADS` permite darle más hilos a ffmpeg.
- **Sin efecto en Render**: si las variables no están, todo sigue exactamente como antes.
- **Verificado**: `npm run test-stickers` verde; el caso de video de 14 s sigue bajando hasta 320 px para no pasar el tope.
### Stickers más rápidos y sin tope por grupo (v11.7.1, 2026-11-27)
- **Motivo**: un video de 15 s tardaba ~13 s solo en convertir porque arrancaba en 512px/calidad 78 y reencodeaba 3 veces hasta entrar en los 920 KB.
- **Nuevo**: `perfilInicialAlta(segundos)` en `utils/stickerProcessor.js` elige el perfil de arranque según la duración real del video (la manda WhatsApp en `videoMessage.seconds`): ≤8 s → 512/78, ≤10 s → 512/62, resto → 384/48. Un video de 15 s ahora convierte en **~2,7 s** en vez de ~13 s.
- **Medido** (720p cargado, 15 s): 512/78/comp4 = 1662 KB en 4,5 s; 384/48/comp2 = 908 KB en 1,7 s. La escalera cae igual si el archivo no entra.
- **Tope por grupo**: `STICKER_GROUP_PER_MIN=0` desactiva el límite de 15 stickers por grupo/minuto. El **cooldown de 45 s por usuario** y el **global de 4 s** siguen igual (con 4 s global el grupo igual no puede pasar de 15/min).
- **Sin efecto en Render**: si `segundos` no llega, arranca por el perfil más alto como antes.
### Stickers sin tope de duración (v11.7.2, 2026-11-27)
- **Bug**: todo video se recortaba a 15 s (`-t 15` en `convertirAWebpBuffer` y en `prepararAudioParaSticker`) aunque el usuario había pedido quitar ese límite.
- **Ahora**: `STICKER_MAX_SEGUNDOS=0` (valor por defecto) manda el video **completo**. El único tope real es el peso: 920 KB de WebP, que se respeta bajando escala/fps con la escalera extendida (`perfilesAlta()` sigue hasta 96px/3fps).
- **Medido**: 20 s → 20,0 s (320px/12fps, ~4 s de conversión); 45 s → 45,0 s (224px/10fps, 616 KB, 3,2 s); 180 s → 180,0 s (120px/5fps, 574 KB, 6,4 s).
- **Audio**: `prepararAudioParaSticker` y `extraerAudioSticker` aceptan 0 = sin tope y el campo `seconds` del audio ya no se clampa a 15.
- **Volver a limitar**: `STICKER_MAX_SEGUNDOS=15` en `.env`.
- **Aviso**: stickers de más de ~30 s pueden no reproducirse en algunos clientes de WhatsApp; el envío no falla.
- **Test de regresión**: `scripts/test-sticker-audio.js` convierte un video de 20 s y exige `duración >= 18 s` y `<= 920 KB` (antes fallaba con 15.000 ms).

### Sticker mudo con un MP4 de WhatsApp (v11.7.3, 2026-11-27)
- **Síntoma**: `VID-20261127-WA0786.mp4` (1280x960, 19 s, AAC estéreo) salió como sticker **sin audio**. No era el tope de duración ni la resolución: era su cabecera de audio.
- **Causa raíz**: el MP4 declara el layout `2 channels (LFE+LFE2)`, que libswresample no soporta; ffmpeg aborta al pasar a mono con `Input channel layout '2 channels (LFE+LFE2)' is not supported`. `prepararAudioParaSticker` devolvía `null` y el comando mandaba el sticker mudo. El aviso del error solo se imprimía si el OGG parcial existía, así que no quedó nada en el log.
- **Fix**: si el primer ffmpeg falla, se reintenta con `pan=mono|c0=0.5*c0+0.5*c1,asetpts=PTS-STARTPTS,aresample=...` (pan mezcla por índice de canal y no consulta el layout). Igual en `extraerAudioSticker`. Ahora el fallo siempre loguea `[STICKER-SONIDO] prepararAudioParaSticker falló: ...` y el comando avisa `[STICKER] Se envía sin sonido ...` cuando termina mandando el sticker mudo.
- **Medido**: ese video saca OGG de 78 KB / 19,09 s en 0,47 s, y el sticker completo sigue saliendo con sonido.
- **Sin cambios para audios normales**: mono/estéreo estándar resuelven en el primer intento, sin tocar el volumen.
- **Test de regresión**: `scripts/test-sticker-audio.js` simula el stderr real de ffmpeg y exige dos llamadas (normal + `pan`), audio válido y waveform; **falla sin el fix**.



### Baileys rc14 + estado de restricción 463 (v11.5.5, 2026-11-26)
- **Upgrade**: `@whiskeysockets/baileys` 7.0.0-rc.9 → 7.0.0-rc14 (la última en npm ese día). La API que usa el bot (`makeWASocket`, `prepareWAMessageMedia`, `getWAUploadToServer`, `proto`, `downloadMediaMessage`, `getMediaKeys`, `Browsers`) sigue existiendo; smoke, anti-ban y sticker-audio pasan.
- **Por qué**: rc14 trae manejo nativo del **Trusted Contact token** y del **reachout timelock (error 463)**: pide/renueva el `tctoken`, lo adjunta en mensajes 1:1 y reemite el token cuando WhatsApp responde 463. rc9 solo guardaba el token que llegaba; nunca lo pedía.
- **Nuevo**: `utils/reachout.js` (`esError463`, `normalizarReachout`). El bot consulta `fetchAccountReachoutTimelock()` al conectar y cada 15 min, y expone `reachout { restringido, tipo, expiraEn, consultadoEn, errores, bloqueos463 }` en `/health`.
- **Cola**: un envío que falle con 463 ya no cae en el reintento genérico: se cuenta en `reachout.bloqueos463`, se marca el chat como lento y se descarta una sola vez (reintentar alarga la restricción).
- **Cómo se probó**: worktree aislado en `HEAD` + estos cambios (el checkout principal tenía trabajo en curso de otro cambio sin commitear). `npm test`, `npm run test-anti-ban` y `npm run test-stickers` verdes; bridge WASM de rc14 ejecutado (`md5` real) para confirmar que carga.
