<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Unirse_a_la_comunidad-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Dale_una_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> | <a href="README_CN.md">中文</a> | <a href="README_TW.md">繁體中文</a> | <a href="README_JA.md">日本語</a> | <a href="README_DE.md">Deutsch</a> | Español</p>

> Todo este proyecto —diseño, arquitectura y desarrollo— fue completado de forma independiente por un recién graduado universitario, apoyándose en programación asistida por IA, con habilidades que abarcan diseño de algoritmos, principios de biomimética, arquitectura de frameworks y pensamiento lógico.

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# o chmod +x run.sh && ./run.sh   # Linux/macOS
```

Abre tu navegador en `http://localhost:1314` → configura una fuente de servicio de IA → importa una tarjeta de personaje → empieza a chatear. El runtime de Deno se descarga solo automáticamente en el primer arranque, sin instalación manual necesaria. Necesitarás al menos una clave de API de IA. La aplicación incluye un tutorial de wiki completo integrado.

> **Nota:** El primer inicio tarda más de lo habitual — el entorno necesita descargar dependencias e inicializar la base de datos. Por favor, espere a que la página cargue completamente antes de interactuar. Los inicios posteriores serán mucho más rápidos.

---

Una memoria recursiva de tres capas (archivado día → mes → año, JSON puro, capacidad de 260 años) + una IA de recuperación anticipada (una IA dedicada que solo busca recuerdos relevantes y entrega lo que encuentra a la IA de respuesta —cada una se mantiene en su propio carril—) + limpieza de contexto por niveles (limpiar algo solo evita que se vuelva a enviar; el texto original permanece intacto y siempre puede restaurarse). Estas tres piezas encajan entre sí para que la IA siga recordando cada palabra que has dicho, sin estar limitada por la ventana de contexto. Sobre esa base, hemos construido chat/rol, modo de programación tipo IDE, modo de trabajo (incluyendo presentaciones hechas por IA), una mascota de escritorio Live2D (conciencia de pantalla + compañía en juegos), entrada de voz, un Bot de Discord e integración de herramientas externas MCP —cada punto de entrada comparte la misma memoria, así que cambiar de ventana no hace que la IA te olvide—. El motor de recuperación autodirigido ya está en producción (algoritmo puro, cero LLM, cero red, a escala de milisegundos, filtrado en tres capas BLQ+NB300+WordNet).

---

## Resumen de funciones

<table>
<tr>
<td width="33%">

**💬 Chat / Rol**
![Interfaz de chat](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ Modo de programación IDE**
![Programación IDE](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Modo de trabajo (presentaciones hechas por IA)**
![Modo trabajo PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Mascota de escritorio Live2D + conciencia de pantalla**
![Mascota de escritorio](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 Puerta de permisos de seis niveles L0–L5**
![Configuración de permisos](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Compresión por niveles × control línea por línea**
![Mecanismo de compresión](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 Memoria de tres capas**: caliente (inyectada cada turno) / templada (recuperada bajo demanda) / fría (archivo profundo), JSON puro + totalmente impulsado por prompts, cero base de datos
- **🎯 Recuperación anticipada P1**: una IA pequeña dedicada busca recuerdos primero y se los entrega a la IA de respuesta, motor dual BM25 + regex, la recuperación puede correr en un modelo gratuito
- **🗜️ Sistema de compresión**: tres niveles (un clic / por tipo / línea por línea) × cuatro granularidades (mensajes de chat / lecturas de archivos / inyecciones del sistema / contenido de proceso) + limpieza autónoma de IA con `<contextClean>`, todo reversible
- **📊 10 tablas de memoria**: almacenamiento estructurado, mantenido automáticamente por la IA vía `<tableEdit>`, logrando aislamiento de información (si el personaje no debería saber algo, simplemente no está en la tabla)
- **👑 Motor de prompts**: estructura de mensajes de 5 segmentos + toma de control de tres rondas de TweakPrompt, variables de macro + inyección dinámica del libro del mundo (modos siempre activo / regex / dinámico)
- **💻 Flujo de trabajo a nivel IDE**: diseño de tres paneles estilo VSCode, la IA lee y escribe archivos directamente, ejecución de comandos aprobada línea por línea
- **🔌 Herramientas externas MCP**: pega un fragmento JSON para conectar; los servidores basados en comandos se bloquean por defecto hasta que el propietario los apruebe, con una lista blanca de variables de entorno para prevenir fugas
- **🐾 Mascota de escritorio + compañía en juegos**: mascota Live2D / paquete de imágenes, tres niveles de privacidad, capturas de pantalla automáticas + intervenciones espontáneas + frecuencia adaptativa
- **🎙️ Entrada de voz**: transcripción con modelo local, separación de hablantes + línea de tiempo, el audio nunca sale del equipo
- **🤖 Bot multiplataforma**: despliegue en Discord, gestión visual + registro de mensajes en tiempo real
- **🧩 22 plugins de funciones** + host de plugins a nivel de usuario + compatibilidad de ecosistema (importa tarjetas de personaje/presets/libros del mundo en múltiples formatos)
- **🛡️ Todos los datos permanecen locales**: las eliminaciones van a una papelera y pueden recuperarse, copia de seguridad automática multicapa + reversión con git
- **🌐 Multilingüe** (chino/inglés/japonés/chino tradicional) · **🔬 Diagnóstico full-stack** (registros de 12 módulos + empaquetado con un clic) · **🎨 Múltiples temas CSS**

---

## Mecanismos detallados

<details>
<summary><strong>🧠 Memoria recursiva de tres capas — Por qué organizarla en capas</strong></summary>

Volcar todo el historial en un solo gran depósito hace que las búsquedas sean lentas —y los datos experimentales lo respaldan ([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)): aunque esté ahí, es posible que el modelo en realidad no lo vea. Basándonos en cómo el hipocampo forma recuerdos y en la curva del olvido de Ebbinghaus, dividimos la información en tres capas según la distancia temporal:

```
🔥 Capa caliente — inyectada automáticamente cada turno: perfil de usuario / memorias permanentes / tareas pendientes / recuerdos recientes
🌤️ Capa templada — recuperada bajo demanda (último mes): resúmenes diarios / archivos temporales / índice mensual
❄️ Capa fría — recuperación profunda (más de un mes): resúmenes mensuales / resúmenes diarios históricos / índice anual
```

La capa caliente cuesta solo ~7.000–11.000 tokens por turno (5–9% de una ventana de 128K). La decadencia de la memoria se inspira en la curva del olvido de Ebbinghaus: `score = weight × (1 / (1 + days × 0.1))`. Totalmente impulsado por prompts —cambia la estrategia de archivado, los significados de las tablas o el estilo de recuperación con solo editar el prompt, sin necesidad de tocar código.

</details>

<details>
<summary><strong>🎯 IA de recuperación anticipada P1 — Por qué dividirlo en dos IAs</strong></summary>

Si la IA de respuesta tuviera que elegir por sí misma las partes relevantes entre cientos de entradas del historial, estaría buscando y respondiendo al mismo tiempo, y su atención se diluiría entre ambas tareas. Así que separamos "encontrar recuerdos" en una IA pequeña dedicada:

```
El usuario envía un mensaje → IA de recuperación P1 (<5K tokens, enfocada solo en recordar) → recuerdos seleccionados + chat actual → IA de respuesta (enfocada solo en responder)
```

Filtrado grueso con BM25 + coincidencia exacta con regex, acierta el objetivo en máximo 3 rondas. La recuperación funciona bien con un modelo ligero gratuito, así que el costo real por conversación es esencialmente el de una sola llamada a la IA de respuesta. P1 también gestiona el cambio automático de presets (con un enfriamiento de 5 turnos para evitar oscilaciones).

</details>

<details>
<summary><strong>🗜️ Gestión de contexto — Granularidad de compresión × niveles × limpieza autónoma de IA</strong></summary>

Mientras la IA trabaja, el contenido de proceso se va acumulando (releer el mismo archivo, resultados de búsqueda obsoletos, salidas antiguas de herramientas). Nuestra limpieza solo oculta cosas —todo puede restaurarse en cualquier momento.

**Limpieza autónoma de IA**: el sistema le da a la IA señales sobre su propio uso de contexto (50% sugerido / 70% advertencia / 85% urgente), y la IA usa comandos `<contextClean>` para recortarse a sí misma de forma autónoma. Escribe las cosas antes de limpiar, así que una mala decisión sigue siendo reversible.

**Control fino del usuario**: tres niveles (limpieza completa con un clic / por tipo / selección manual línea por línea) × cuatro granularidades (mensajes de chat / facturación de tokens por lectura de archivo línea por línea / cinco categorías marcables de inyecciones del sistema / contenido de proceso recortado automáticamente).

Tasa de aciertos de caché medida (Opus + DeepSeek, incluyendo cambio de persona de IA + compresión autónoma): **75%–80%**.

![Panel de compresión](imgs/screenshots/compression-multi.png)

</details>

<details>
<summary><strong>🔬 P1 autodirigido — Un motor de recuperación sin LLM ya en producción</strong></summary>

La IA P1 tiene que disparar una solicitud de API cada turno —eso significa latencia, costo y ningún uso sin conexión. Hemos construido una canalización completamente algorítmica (21 nodos, ~9.000 líneas) que alcanza velocidad de milisegundos, cero dependencia de red y atención a nivel de frase.

**Base de datos**: la [red de asociación china SWOW](https://smallworldofwords.org/) / [vectores de palabras de 300 dimensiones ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (~300.000 palabras) / el grafo de relaciones chino de ConceptNet / THUOCL y otros diccionarios multi-fuente. El léxico se ensambló mediante búsqueda web con IA + 2 días de auto-revisión, a un costo de construcción cercano a cero.

**Canalización**: tokenización → divergencia asociativa SWOW (la difusión de sinónimos está prohibida —habilitarla reduce la calidad medible en un 55–76%) → puntuación paralela de seis ejes (psicológico / informacional / social / lógico / lingüístico / cognitivo) → localización de 47 subdirecciones → confirmación cruzada multi-recurso → ranking por votación espacial (IDW aditivo, no multiplicativo) → divergencia secundaria (5 rutas independientes) → puntuación BLQ (referenciando la fusión aditiva CombSUM, con pesos de dimensión de investigación propia) → selección de palabra-dirección → inyección de contexto. Los 21 nodos son algoritmo puro, cero LLM.

**Experimentos**: 27 iteraciones de versión; la puntuación de divergencia pasó de 2,01 a 4,05 entre v9 y v26 (+101%, sobre 5, juzgado palabra por palabra a mano); tasa de aciertos de recall ~90%; puntuación promedio general ~3,5. La tasa de respuestas genéricas cayó del 74% al 4%.

**Salida real** (registros en bruto de una ejecución por lotes de 200 casos):

| Entrada del usuario | Dirección divergente del sistema | Disciplina alcanzada |
| --- | --- | --- |
| "Apenas puedo aguantar más, ¿por qué es tan difícil estar vivo?" | Conciencia del momento presente / conciencia interoceptiva / **cuál es la naturaleza de lo real** | Psicología → **filosofía existencialista** |
| "Preparándome para una entrevista en una empresa unicornio, ¿cómo se me ocurren preguntas realmente profundas?" | Análisis de causa raíz / **zona de desarrollo próximo** | Gestión → **psicología educativa** |
| "Recuperar usuarios perdidos en operaciones de tráfico propio con presupuesto limitado" | **Activación de la red neuronal por defecto** / **BDNF (factor neurotrófico derivado del cerebro)** | Marketing → **neurociencia cognitiva** |
| "Las consultas a la base de datos son dolorosamente lentas, ¿cómo las optimizo?" | Inmutabilidad y actualizaciones de estado / **SRP (principio de responsabilidad única)** | Operaciones → **metodología de ingeniería de software** |
| "Una historia sobre un espadachín que se encuentra con un enemigo en una montaña nevada" | **El fusil de Chéjov** / arquetipos junguianos | Ficción → **narratología + psicología analítica** |
| Un poema original de un usuario, "Morí antes de que llegara la luz" | **Mundos posibles y universos paralelos** | Poesía → **interpretación de muchos mundos en física** |

Estándar de admisión del léxico: **cualquier palabra que el modelo principal ya pudiera inferir con solo leer la entrada en bruto es una palabra desperdiciada** —el valor de P1 reside en darle al modelo direcciones a las que no llegaría por sí mismo.

</details>

<details>
<summary><strong>👑 Motor de prompts + inyección dinámica del libro del mundo</strong></summary>

**Las tres rondas de TweakPrompt** toman el control de la salida de cada módulo de forma unificada: la Ronda 1 recopila → la Ronda 2 reconstruye la estructura de mensajes de 5 segmentos (beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) + sustitución de macros → la Ronda 3 toma una instantánea.

**El libro del mundo tiene 3 modos de activación**: siempre activo (inyectado cada turno) / regex (activado por palabra clave) / dinámico (activado al leer condiciones numéricas de las tablas de memoria —por ejemplo, afecto > 80 desbloquea un diálogo especial, o el progreso de la misión al llegar al capítulo 3 cambia la descripción de la cosmovisión).

**Sistema de macros**: `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + macros personalizadas.

</details>

<details>
<summary><strong>🏗️ Arquitectura del sistema</strong></summary>

Tres capas: **capa de función** (memoria / compresión / recuperación / presets / libro del mundo / red / operaciones de archivos… una única copia global) → **capa de transporte** (cada ventana tira de su propia línea, aislada por id, de forma natural asíncrona y sin bloquearse entre sí) → **capa de interfaz** (web / Bot / mascota de escritorio / extensión VSCode —cambia la interfaz sin perder ninguna capacidad).

Aislamiento de datos: a nivel de usuario (fuentes de IA / configuración global) / a nivel de tarjeta de personaje (memoria / chat / libro del mundo / regex) / a nivel de conversación (historial de chat / modo / submodo).

Los 22 plugins crecen bajo una especificación unificada, MCP conecta herramientas externas, y el host de plugins a nivel de usuario monta programas Python/Node —las extensiones nunca tocan el código base.

</details>

<details>
<summary><strong>🔭 Sobre la era de las ventanas de contexto gigantes</strong></summary>

Incluso si las ventanas de contexto se expanden a 10M+ tokens, seguimos manteniendo la memoria por capas: ① hay evidencia experimental sólida de que la utilización del contexto decae a medida que aumenta la longitud; ② ~10K tokens de memoria curada llevan la información de 100K+ tokens de historial en bruto, a un costo un orden de magnitud menor; ③ las tablas estructuradas son más fáciles de leer y escribir con precisión por una IA que la información dispersa en una conversación.

</details>

---

## Hoja de ruta

**Completado**: memoria de tres capas · sistema de compresión · recuperación P1 · P1 autodirigido (algoritmo puro, cero LLM, atención a nivel de frase) · motor de prompts · cambio automático de presets · tablas de memoria · inyección dinámica del libro del mundo · mascota de escritorio Live2D · compañía en juegos · entrada de voz · presentaciones hechas por IA · MCP · paralelismo multiventana · puente de extensión VSCode · Bot de Discord · 22 plugins · papelera de reciclaje y reversión de copias de seguridad · diagnóstico full-stack · soporte multilingüe

**Planes a corto plazo**: más plataformas de Bot · ecosistema de plugins · TTS / texto a imagen · motor de juego con IA (en el linaje de juegos "era" —código determinista para el estado numérico + narrativa de LLM + renderizado simbólico) · modo de transmisión en vivo

---

## Stack tecnológico

Runtime fount (Deno) · capa de compatibilidad backend Node.js + enrutamiento estilo Express · frontend JS vanilla (ESM) · recuperación inteligente BM25 + regex (JS puro, sin dependencias) · mascota de escritorio Electron · modelo de transcripción de voz local · multiplataforma discord.js v14 · almacenamiento JSON puro

---

## Comunidad

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Unirse_ahora-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Comparte tarjetas de personaje · publica presets · contribuye libros del mundo · reporta errores · sugiere funciones · contribuye código —¡todos son bienvenidos!

---

## Tecnologías y recursos utilizados

- **Transcripción de voz**: [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize) (despliegue local con diarización de hablantes; el modelo, ~1,8 GB, se descarga automáticamente en el primer uso)
- **Vectores de palabras**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Datos de asociación**: el conjunto de datos de asociación china [SWOW (Small World of Words)](https://smallworldofwords.org/)
- **Tokenización y diccionarios**: THUOCL / CoreNatureDictionary / Chinese-Synonyms y otros recursos públicos
- **Puente de motor de búsqueda**: [ddgs](https://pypi.org/project/ddgs/) (una capa de huella digital TLS en Python que resuelve el problema de que las solicitudes fetch en bruto sean degradadas por los motores de búsqueda)

## Agradecimientos

- **[fount](https://github.com/steve02081504/fount)** — el framework de referencia inicial en los primeros días de este proyecto, que proporcionó infraestructura central como el manejo de mensajes de IA, la gestión de fuentes de servicio y la carga de módulos. El proyecto ha evolucionado desde entonces hacia una arquitectura totalmente independiente, pero fount nos ahorró mucho tiempo de desarrollo de bajo nivel en las primeras etapas y nos dio muchas ideas valiosas de las que partir —un sincero agradecimiento por ello
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — el proyecto pionero en el rol con IA; su formato de presets, especificación de tarjetas de personaje y sistema de libro del mundo se han convertido en estándares de la comunidad, y este proyecto es totalmente compatible con su ecosistema
- **Comunidad de plugins de SillyTavern** — gracias a cada autor de plugins de código abierto por su exploración y aportes en torno a motores de renderizado, extensiones de funciones y más

---

<details>
<summary><strong>📸 Más capturas de pantalla de funciones (haz clic para expandir)</strong></summary>

| | | |
|---|---|---|
| ![Detalle PPT](imgs/screenshots/ppt-detail.png) **Flujo completo de PPT** | ![Configuración de seguridad](imgs/screenshots/security-settings.png) **Seguridad y flujo de tareas** | ![Centro de seguridad](imgs/screenshots/security-center.png) **Centro de seguridad** |
| ![Multilingüe](imgs/screenshots/i18n-support.png) **Soporte multilingüe** | ![Temas CSS](imgs/screenshots/css-themes.png) **Múltiples temas** | ![wiki](imgs/screenshots/wiki-guide.png) **Wiki integrada** |
| ![Submodo](imgs/screenshots/sub-mode-agent.png) **Flujo de trabajo de submodo** | ![Menú](imgs/screenshots/hamburger-menu.png) **Vistazo al contexto** | ![loop](imgs/screenshots/auto-loop.png) **Loop automático/programado** |
| ![Detección de herramientas](imgs/screenshots/tool-detection.png) **Detección de entorno** | ![Capas de memoria](imgs/screenshots/memory-data-layers.png) **Estructura de archivos de memoria** | ![Extensiones](imgs/screenshots/browser-automation.png) **Automatización de navegador** |
| ![Interfaz externa](imgs/screenshots/external-interface.png) **Interfaz externa** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Bot de Discord** | |

</details>
