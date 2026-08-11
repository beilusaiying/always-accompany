<p align="center">
  <img src="imgs/icon.jpg" alt="always-accompany" width="180">
</p>

<h1 align="center">always-accompany</h1>

<p align="center"><strong>Un proyecto multi-IA + Agent centrado en los mecanismos de contexto y atención</strong></p>

<p align="center">Acompañar, chatear, programar y trabajar comparten un mismo marco de memoria y contexto: como esas IA de la ciencia ficción, que te acompañan y también te ayudan a sacar el trabajo adelante.</p>

<p align="center"><strong>Atención dinámica · Inyección fija · Aislamiento por proyecto · Modos especializados</strong></p>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Únete_a_la_comunidad-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Deja_una_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README_CN.md">简体中文</a> · <a href="README_TW.md">繁體中文</a> · <a href="README_JA.md">日本語</a> · <a href="README_KO.md">한국어</a> · <a href="README_RU.md">Русский</a> · <a href="README_DE.md">Deutsch</a> · Español · <a href="README_FR.md">Français</a> · <a href="README_PT.md">Português</a></p>

> [!NOTE]
> **Nota de desarrollo:** La mayor parte de este proyecto fue creada por una sola persona en unos tres meses, seguidos de aproximadamente un mes dedicado a optimizar los algoritmos. Debido al breve ciclo de desarrollo y al amplio alcance funcional, la estructura del proyecto, las funciones básicas y el tratamiento de casos límite aún pueden ser inestables o estar incompletos. Algunas funciones básicas se implementaron con ayuda de IA, mientras que el autor planificó y dirigió personalmente los marcos, algoritmos y diseños clave de las funciones complejas; por ello, la madurez varía entre módulos. Continuarán la revisión manual, los ajustes y la optimización de ingeniería. Si encuentra un error, incluya los pasos para reproducirlo y los registros.
>
> **Próximos pasos:** Se dejarán de añadir nuevos plugins y áreas funcionales. El trabajo se centrará en reducir el núcleo, disminuir el acoplamiento y trasladar gradualmente las funciones separables a la capa de plugins. El proyecto completará un protocolo de plugins detallado y estable antes de emprender la optimización de ingeniería del framework y una refactorización gradual. También se mejorarán las pruebas, la documentación y el proceso de contribución para que más desarrolladores puedan entender, ampliar y participar en el proyecto.

---

## ¿Qué puede hacer directamente?

- Mantener chats de largo plazo y juegos de rol, con importación directa de tarjetas de personaje, presets, worldbooks y otros formatos de la comunidad de SillyTavern;
- Leer y modificar archivos de un proyecto y ejecutar comandos, como una mesa de trabajo de Agent local;
- Extenderse más allá del navegador mediante Live2D / mascotas de escritorio en imagen, percepción de pantalla, compañía en juegos, entrada de voz y un sistema de Bot que cubre 9 plataformas;
- Conservar el material de largo plazo en archivos locales, encontrar automáticamente en cada turno los fragmentos relevantes para la pregunta actual y dejar que el contexto antiguo que ya no hace falta se retire;
- Editar personajes, el contenido y el orden de los prompts, la identidad y la posición de las inyecciones, las reglas de activación condicional, las rutas de recuperación de memoria, los permisos y los plugins, para convertirlo en tu propia IA.

**¿Qué tenemos?** Detrás de todas estas interfaces hay un mismo sistema; la diferencia real se concentra en cuatro cosas:

- **Memoria y contexto por capas** — Data + capas hot / warm / cold conservan el material de largo plazo, y una herramienta que reúne contexto y recupera memoria (P1) recupera antes de cada respuesta los fragmentos pertinentes; la limpieza de contexto opera a nivel de lectura de archivo, es reversible, y la propia IA puede descartar archivos ya leídos que ya no necesita;
- **El comportamiento central se puede revisar y configurar** — personajes, prompts, inyecciones, memoria, rutas de recuperación, permisos y plugins tienen puntos de edición o configuración documentados;
- **Un marco extensible basado en plugins** — las funciones centrales se organizan como plugins, se transmiten a través de una estación de información intermedia, y el frontend se encarga de mostrar y operar; los plugins de usuario pueden escribirse en JS, Python o como programas independientes;
- **Una cadena integrada de herramientas para agent** — proporciona archivos, comandos, integración con el navegador, MCP, múltiples ventanas, aprobación y recuperación bajo un mismo marco de memoria y contexto; la disponibilidad y los resultados dependen del modo, la configuración, el entorno, el modelo y los servicios conectados.

---

## Inicio rápido

Solo hacen falta dos cosas:

- Una API de IA que funcione;
- Saber escribir prompts sencillos.

Con eso ya puedes empezar a probarlo. Conviene aclarar de antemano: los prompts de AIRP y Chat todavía los estamos afinando en detalle; por ahora el foco está en la productividad, y el pulido orientado a la compañía irá llegando poco a poco.

Si solo quieres empezar a chatear, ese es todo el coste. El servicio local de recuperación del P1 autodirigido (con un pico de memoria medido actualmente del orden de unos 2 GiB) se puede apagar por completo; los parámetros de P1, la posición de inyección de los prompts, Code, Work y los plugins son configuraciones para profundizar según haga falta, no una asignatura previa para el primer uso.

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# o chmod +x run.sh && ./run.sh   # Linux / macOS
```

El lanzador descargará automáticamente el runtime si falta Deno y completará la instalación si las dependencias están incompletas. Cuando la página esté lista, el navegador suele abrirse solo; también puedes acceder manualmente a `http://localhost:1314`.

| 1. Elige el idioma de la interfaz | 2. Vincula una fuente de servicio de IA |
|---|---|
| ![Elegir idioma](imgs/screenshots/onboarding-language.png) | ![Vincular API](imgs/screenshots/onboarding-api.png) |

Introduce la dirección del servicio, la API Key y el modelo; tras guardar, elige o importa una tarjeta de personaje y ya puedes empezar a chatear. Se necesita al menos una API de IA que funcione; la capacidad del modelo y el coste dependen del servicio que vincules. La aplicación incluye una [Wiki](site/wiki/getting-started/overview.md), y también puedes visitar la [versión en línea](https://beilusaiying.github.io/always-accompany/).

> El primer arranque suele tardar más: el runtime necesita descargar dependencias e inicializar los datos locales. Espera a que la página aparezca por completo antes de operar; los arranques posteriores serán más rápidos. Capacidades opcionales como la voz o la mascota de escritorio pueden tener su propia descarga inicial o requisitos de entorno.

---

## Funciones de un vistazo

<table>
<tr>
<td width="33%">

**💬 Chat / juego de rol**
![Interfaz de chat](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ Modo de programación tipo IDE**
![Programación IDE](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Modo Work y PPT**
![Modo Work PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Mascota de escritorio Live2D + percepción de pantalla**
![Mascota de escritorio](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 Seis plantillas de permisos + reglas por herramienta**
![Configuración de permisos](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Compresión por capas × control uno a uno**
![Mecanismo de compresión](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧭 Cuatro modos principales + vistas auxiliares**: Smart totalmente inteligente, Chat / juego de rol, Code programación y Work trabajo tienen cada uno su propia tabla de memoria y ruta P1; además hay vistas auxiliares de gestión de Bot, compañía en juegos, gestión de memoria, adaptación a ST, etc.;
- **🧠 Data (tabla de memoria estructurada y editable) + memoria en tres capas**: Data y los archivos JSON / MD normales `hot / warm / cold` se encargan respectivamente de los hechos actuales, el material reciente y el archivo; el contenido es consultable y editable;
- **🎯 P1 (recuperación previa de memoria)**: antes de que la IA principal responda, busca primero fragmentos relevantes en el material de largo plazo que el personaje y el modo actuales permiten leer. Chat / Code / Work usan actualmente por defecto la ruta de algoritmo local; los modos Smart / Bot conservan una ruta de recuperación por IA independiente; las dos rutas son mutuamente excluyentes, y también se pueden apagar;
- **🗜️ Gestión de contexto**: consulta el consumo por mensaje, lectura de archivo, resultado de herramienta e inyección del sistema; la limpieza normal solo oculta el contenido y deja de enviarlo a la IA, pero el registro permanece en disco y es recuperable;
- **📊 Tablas de memoria por modo**: Chat tiene las tablas #0–#9, Code y Work usan sus propias tablas y directorios privados, sin amontonar todos los escenarios en una sola tabla;
- **👑 Las entradas principales de prompt son editables**: definiciones de personaje, presets, entradas INJ, instrucciones de modo, ranuras de datos de memoria y guías de herramientas ofrecen los controles que admita su editor para contenido, orden, activación, rol, posición de inyección o condiciones; los envoltorios de seguridad del marco y las transformaciones específicas del proveedor siguen gestionados por código;
- **💻 Flujo de trabajo de nivel IDE**: diseño de tres columnas, lectura y edición de archivos, ejecución de comandos, lista de tareas, múltiples ventanas y puente de extensión para VS Code;
- **🔌 MCP (protocolo de conexión de herramientas externas)**: pega un JSON para integrar herramientas externas; los servicios de tipo comando deben pasar por puertas de seguridad como el owner y la lista blanca de variables de entorno;
- **🐾 Mascota de escritorio y compañía en juegos**: Live2D / packs de imágenes, tres formas de percepción de pantalla, comentarios proactivos, un bucle de compañía en juegos independiente y frecuencia adaptativa;
- **🎙️ Entrada de voz local**: transcripción local con MOSS-Transcribe-Diarize, con separación de hablantes y marcas de tiempo; por ahora solo hace voz a texto, no incluye lectura en voz por IA;
- **🤖 Bot en 9 plataformas**: el código fuente actual incluye las carcasas de Discord, Telegram, Slack, LINE, Feishu, DingTalk, WeChat, WeCom y la plataforma X; cada plataforma aún requiere configurar Token, Webhook o puentes de terceros según sus propios requisitos;
- **🔎 Búsqueda vectorial semántica opcional**: incluye beilu-vectordb (basado en Orama, con búsqueda de texto completo / vectorial / híbrida), apagada por defecto, requiere configurar un endpoint de embedding para activarla; complementa al P1 autodirigido, no es una elección entre uno u otro;
- **🧩 Sistema de plugins**: el código fuente actual tiene 23 directorios de plugins integrados, y la plantilla de usuario nuevo enumera 14 por defecto; además puedes escribir plugins de usuario en Python, Node o como programas independientes;
- **🛡️ Datos locales y recuperación**: los datos de la aplicación se guardan en tu equipo, con soporte para ocultar-recuperar, papelera y cadena de copias de seguridad; el contenido que se envía a una IA remota o a un servicio de embedding remoto sigue estando sujeto a la política de datos del servicio que elijas;
- **🌐 Multilingüe · 🔬 diagnóstico de caja blanca · 🎨 varios temas**: además de las interfaces centrales en chino / inglés / japonés / chino tradicional, se ofrecen otras traducciones de la comunidad; algunos idiomas de pocos recursos pueden estar incompletos.

---

## ¿Qué pretendemos resolver en realidad?

Guardar la memoria no tiene en sí nada de misterioso. Data es una tabla que se puede escribir; `hot / warm / cold` no es más que crear tú tres carpetas por “tiempo + evento” y anotar md dentro; INJ (entradas editables de inyección de prompt) y los presets también prolongan la forma de orquestar prompts que frontends de personaje como SillyTavern llevan mucho tiempo explorando.

Al combinarlos con P1 (una herramienta que reúne contexto y recupera memoria), se forma un flujo configurable de “vector + inyección dinámica + memoria que sigue a la tarea actual”; la limpieza de contexto a nivel de lectura de archivo forma parte de la misma cadena. Los resultados de recuperación y compresión dependen del modo, la configuración, el material y el modelo.

En realidad, al principio pensábamos hacer de P1 una pequeña IA desplegada por separado. Pero el verdadero problema aparece después de guardar: cuanta más memoria se acumula, si en cada turno hay que arrancar expresamente una segunda IA para rebuscar, ¿aguantarán la velocidad y el coste? ¿De verdad esa pequeña IA lo encontrará todo? ¿Hay que usar por fuerza una IA de pago? ¿Cuanto más recuerde, más lenta será la respuesta?

Bajado al día a día, son unos cuantos escenarios conocidos: en un proyecto grande, le pides a la IA que primero mire la cadena, el marco y los MD antes de darle la tarea, y a medio camino los tokens ya están casi llenos; en cuanto comprimes hay que volver a leerlo todo, y cuando varios agents corren a la vez, el contexto es un desastre aún mayor; en tareas largas la IA lee una y otra vez el mismo archivo del que solo cambiaron unas líneas, el contexto se amontona hasta reventar y tú no puedes borrarlo; a veces querías abrir un proyecto nuevo, pero la IA se ancla de golpe a la memoria de un proyecto viejo anterior.

Esto no son suposiciones sacadas de la nada:

- [Issue #6](https://github.com/beilusaiying/always-accompany/issues/6)
- [Codex #35226](https://github.com/openai/codex/issues/35226) · [Claude Code #34556](https://github.com/anthropics/claude-code/issues/34556);
- [Discusión de la comunidad](https://www.reddit.com/r/SillyTavernAI/comments/1q7p33c/how_longterm_memory_works_in_sillytavernai/);
- Los usuarios de los productos de chat web también plantean la transparencia de la memoria de proyecto y la interferencia entre proyectos: [petición de transparencia en la recuperación](https://community.openai.com/t/feature-request-make-project-memory-transparent-searchable-and-user-controlled/1385159) · [petición de memoria específica por proyecto](https://community.openai.com/t/project-specific-memory-in-chatgpt/1140856).

### Tras guardar, ¿cómo se entrega a la IA?

Mediante la **recuperación previa de memoria P1** de desarrollo propio: primero amplía las pistas de búsqueda en torno a la conversación actual del usuario, luego encuentra el texto original relevante dentro del material de largo plazo que el personaje y el modo actuales permiten leer, y se lo entrega a la IA principal. Puedes entenderlo como un mecanismo de atención dinámica que corre fuera del modelo: la pregunta actual decide qué buscar, el material de largo plazo aporta candidatos, y solo los fragmentos seleccionados en este turno entran en la respuesta.

En la práctica esto significa: no tienes que repetir la frase original, una frase relacionada pero no exactamente igual también puede traer de vuelta lo antiguo; tras la recuperación, la interfaz muestra qué memorias se usaron realmente en este turno; lo que verificas es el registro en sí, no un “lo recuerdo” de la IA.

---

## Mecanismos en detalle

<details>
<summary><strong>🧠 Data y la memoria recursiva en tres capas — por qué seguir estratificando</strong></summary>

`hot / warm / cold` son ante todo directorios de ciclo de vida legibles y escribibles, no una base de datos misteriosa:

```text
🔥 hot  — material reciente, de alta frecuencia, en uso ahora mismo
🌤️ warm — material de organización y archivo por etapas
❄️ cold — material histórico de más largo plazo
📊 Data — hechos estructurados, editables y verificables del modo actual
```

Estratificar da a la inyección fija, la recuperación bajo demanda y el archivo profundo costes y usos distintos. El material original queda en JSON / MD normal, que el usuario puede inspeccionar y corregir directamente; luego P1 decide de qué capas recuperar fragmentos en este turno.

La investigación sobre contexto largo ya ha observado el sesgo de posición y la caída de aprovechamiento cuando la tarea se vuelve más compleja: [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) · [RULER](https://arxiv.org/abs/2404.06654) · [Found in the Middle](https://aclanthology.org/2024.findings-acl.890/). Estos trabajos muestran que “poder meterlo dentro” y “usarlo de forma estable” no son lo mismo, pero no prueban directamente que la solución de este proyecto sea mejor.

</details>

<details>
<summary><strong>🗜️ Gestión de contexto — de comprimir bloques enteros a la limpieza a nivel de lectura de archivo</strong></summary>

Cuando la IA ejecuta tareas reales genera gran cantidad de contenido de proceso: archivos leídos una y otra vez, resultados de herramientas antiguos, etiquetas de instrucción ya consumidas y mensajes obsoletos. always-accompany ofrece a la vez compresión automática, limpieza por tipo y selección uno a uno; la limpieza por defecto usa la marca `_hidden`, que deja el registro en disco pero deja de enviarlo a la IA.

La IA también puede emitir `<contextClean>` para solicitar una limpieza; el sistema protege las palabras originales del usuario y permite fijar un umbral mínimo de tokens, para evitar romper con frecuencia la caché de prompts cuando el contexto todavía es pequeño. Las operaciones permanentes o de alto riesgo no deben mezclarse con el ocultado normal.

| Compresión multicapa y granularidad | Limpieza a nivel de lectura de archivo |
|---|---|
| ![Panel de compresión multicapa](imgs/screenshots/compression-multi.png) | ![Limpieza a nivel de lectura de archivo](imgs/screenshots/context-file-cleanup.png) |

El usuario común solo tiene que elegir las lecturas de archivo o los mensajes que ya no necesita; cuando quiera un control más profundo, puede consultar la factura de tokens, el tipo, el tiempo y el origen.

</details>

<details>
<summary><strong>🔬 P1 autodirigido — la cadena de atención de memoria dinámica fuera del modelo</strong></summary>

La cadena de producción actual es Node0–4, y no la descripción de 21 nodos de la documentación antigua:

```text
Node0  entrada actual + mensajes de usuario recientes + Data del modo actual
  ↓
Node1  segmentación, categoría gramatical, tiempo, nombres propios y anclas de frase
  ↓
Node2  expansión asociativa con SWOW / ConceptNet / Cilin / ATOMIC / léxicos de dominio, etc.
  ↓
Node3  filtrado de señales multi-evidencia con BLQ (algoritmo propio) / NB300 / WordNet, etc.
  ↓
Node4  vuelta a Data, hot / warm / cold y los registros del modo, con ordenación por BM25, tiempo, capa, Top, importance, etc.
  ↓
recalledRecords + directionWords + trace
```

Las palabras asociadas no son hechos de memoria; los candidatos deben volver a la capa de registro real para convertirse en el resultado final de la recuperación. El panel de caja blanca muestra las unidades de entrada, los candidatos de cada nodo y los motivos de eliminación, el estado del índice, el origen final y los errores, para poder juzgar si un “no se recuperó” se debe a que no hubo coincidencia, a una degradación de recursos o a un fallo de la cadena.

![Prueba de caja blanca del P1 autodirigido](imgs/screenshots/p1-self-driven-diagnostics.png)

El panel de caja blanca demuestra que cada nodo y cada origen real pueden inspeccionarse; la calidad de la recuperación aún debe evaluarse sobre el mismo corpus, la misma tarea y datos con respuestas de referencia. Para los límites completos de ejecución, consulta el [contrato de producción actual de P1](site/wiki/p1-recall/ch7-current-runtime.md).

</details>

<details>
<summary><strong>👑 Las entradas principales de prompt son editables — usables por defecto y configurables para tu flujo</strong></summary>

Las entradas principales de prompt —definiciones de personaje, presets, entradas INJ, instrucciones de modo, ranuras de datos de memoria y guías de herramientas— se pueden editar en la interfaz. Cada entrada permite los ajustes que ofrece realmente su editor; los envoltorios de seguridad del marco y las transformaciones específicas del proveedor siguen gestionados por código:

- el texto real
- el orden
- si está activada
- si se envía con identidad system, user o assistant;
- en qué posición del historial de chat se inserta;
- que solo tenga efecto en Chat, Code, Work, Bot o bajo condiciones específicas.

</details>

<details>
<summary><strong>🔒 La IA puede actuar, pero cada tipo de operación tiene su propio límite</strong></summary>

La escritura de archivos obtiene `deny / ask / allow` según la herramienta, la ruta y una regla de tres estados; los comandos, además, pasan por listas negra, gris y blanca remota; en despliegue de servidor, la configuración sensible y las capacidades de subproceso requieren que el owner las active.

L0–L5 es un conjunto de plantillas rápidas que van del control estricto a la apertura total, y el usuario aún puede subdividir hasta herramientas y rutas concretas. L5 salta la aprobación y es una elección de alto riesgo explícita; la valla del workspace, el modo de despliegue y las puertas de seguridad propias de cada plugin deben entenderse igualmente por separado.

![Subdivisión de permisos de edición de la IA](imgs/screenshots/ai-permission-rules.png)

</details>

<details>
<summary><strong>🏗️ Arquitectura del sistema y límites de aislamiento</strong></summary>

always-accompany funciona con un backend Deno y un frontend web nativo, y organiza las capacidades a través de Shell, Plugin, Service Generator y la capa de funciones yonban. Las llamadas de interfaz, el enrutamiento de modos, la ejecución de archivos / herramientas, la persistencia y los resultados asíncronos tienen cada uno un punto de entrada claro.

| Límite | Función actual |
|---|---|
| Usuario | El límite raíz de persistencia en escenarios multiusuario / servidor |
| Tarjeta de personaje | Distintos personajes, relaciones, clientes o proyectos usan distintas raíces de memoria, configuraciones y conversaciones |
| Modo | Chat / Code / Work usan tablas distintas, directorios privados, registros de preset y rutas P1; el material de largo plazo común de una misma tarjeta de personaje aún puede compartirse |
| Ventana | Acota la entrada de este turno, los candidatos y resultados de P1, el workspace y el retorno asíncrono |

</details>

<details>
<summary><strong>🔭 Sobre las ventanas de contexto de 1M, 2M y más grandes</strong></summary>

Las ventanas más grandes son muy valiosas, pero capacidad, atención, coste y estado de la tarea no son lo mismo. always-accompany hace estratificación y recuperación sobre todo para elevar la atención y optimizar la forma de almacenar dentro del contexto, especialmente de cara a los grandes proyectos de código y los chats de largo plazo de hoy.

Quizá te haya pasado: cuanto más largo el chat y más memoria, más recibe la IA, y su respuesta y su memoria empiezan en cambio a confundirse y a ralentizarse; y al programar es que, aunque te den 1M de contexto, un proyecto grande puede chocar de inmediato contra el límite.

</details>

---

## Hoja de ruta

**Puntos de entrada e implementaciones que el repositorio ya tiene**: Data + memoria en tres capas · gestión de contexto · P1 autodirigido / AI P1 · edición de entradas de prompt y cambio de preset · tablas de memoria por modo · inyección dinámica de conocimiento condicional · mascota de escritorio Live2D / imagen · percepción de pantalla y compañía en juegos · entrada de voz local · generación de PPT · MCP · múltiples ventanas · puente de extensión para VS Code · Bot en 9 plataformas · 23 directorios de plugins integrados · anfitrión de plugins de usuario · cadena de papelera / copia de seguridad · diagnóstico de caja blanca · múltiples idiomas y temas.

**Direcciones próximas**: más plataformas de Bot · ecosistema de plugins y ejemplos · TTS / texto a imagen · motor de juegos con IA (estado numérico determinista + narrativa LLM + renderizado simbólico)

---

## Stack tecnológico

Runtime Deno (compatible con Node.js) · enrutamiento estilo Express · frontend en JavaScript / ESM nativo · WebSocket · almacenamiento local en JSON / MD · mascota de escritorio Electron · servicios opcionales en Python (recursos de P1, STT, PPT) · discord.js v14 · puente de extensión para VS Code.

Para la explicación de la arquitectura, consulta [Arquitectura del sistema](site/wiki/developer/architecture.md); para las cadenas de mensajes, herramientas y permisos, consulta el [sistema de herramientas YonBan](site/wiki/yonban/tools.md) y el [mecanismo de aprobación](site/wiki/yonban/approval.md).

---

## Comunidad

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Únete_ya-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Comparte tarjetas de personaje · publica presets y conocimiento condicional · aporta plugins · reporta bugs · propón casos de uso reales · participa en el benchmark · contribuye código.

---

## Tecnologías y recursos utilizados

- **Transcripción de voz**: [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize) (despliegue local, modelo de unos 1,8 GB, se descarga por separado en el primer uso)
- **Vectores de palabras**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Datos asociativos**: datos de asociación en chino de [SWOW (Small World of Words)](https://smallworldofwords.org/)
- **Segmentación y diccionarios**: THUOCL, CoreNatureDictionary, Chinese-Synonyms y otros recursos públicos
- **Puente de motor de búsqueda**: [ddgs](https://pypi.org/project/ddgs/) (para las solicitudes de búsqueda y la obtención de resultados)

## Agradecimientos

- **[fount](https://github.com/steve02081504/fount)** — el marco de referencia en los inicios del proyecto, que aportó ideas de infraestructura como el procesamiento de mensajes de IA, la gestión de fuentes de servicio y la carga de módulos, y ahorró mucho tiempo de desarrollo de base;
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — un pionero importante del ecosistema de juego de rol con IA y de prompts. always-accompany admite importar sus tarjetas de personaje, presets, worldbooks y otros formatos de la comunidad;
- **La comunidad de plugins de SillyTavern y todos los autores de recursos de código abierto** — gracias por la exploración y por compartir en renderizado, personajes, extensiones, recuperación y cadenas de herramientas.

## Por qué hago este proyecto

> El diseño, la arquitectura y el desarrollo de este proyecto los ha hecho un ni-ni que quiere encontrar trabajo (es broma, más o menos), con la ayuda de la programación asistida por IA, combinando diseño de algoritmos, ideas de biónica, arquitectura de marco y razonamiento lógico.

always-accompany no busca embutir funciones de moda en un mismo menú: al principio solo era que el autor quería usarlo él mismo :). Incluye un sistema de plugins y marco, además de varios idiomas de interfaz; la cobertura real varía según el plugin y los recursos de traducción disponibles.

---

<details>
<summary><strong>📸 Más capturas de funciones (haz clic para ver)</strong></summary>

| | | |
|---|---|---|
| ![PPT detallado](imgs/screenshots/ppt-detail.png) **Flujo completo de PPT** | ![Configuración de seguridad](imgs/screenshots/security-settings.png) **Seguridad y flujo de tareas** | ![Centro de seguridad](imgs/screenshots/security-center.png) **Centro de protección de seguridad** |
| ![Multilingüe](imgs/screenshots/i18n-support.png) **Soporte multilingüe** | ![Temas CSS](imgs/screenshots/css-themes.png) **Varios temas** | ![Wiki](imgs/screenshots/wiki-guide.png) **Wiki integrada** |
| ![Submodo](imgs/screenshots/sub-mode-agent.png) **Flujo de submodos** | ![Menú](imgs/screenshots/hamburger-menu.png) **Vista rápida del contexto** | ![Loop](imgs/screenshots/auto-loop.png) **Loop automático / programado** |
| ![Detección de herramientas](imgs/screenshots/tool-detection.png) **Detección del entorno** | ![Capas de memoria](imgs/screenshots/memory-data-layers.png) **Estructura de archivos de memoria** | ![Extensión](imgs/screenshots/browser-automation.png) **Automatización del navegador** |
| ![Interfaz externa](imgs/screenshots/external-interface.png) **Interfaz externa** | | |

</details>
