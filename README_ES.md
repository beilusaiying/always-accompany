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

<p align="center">📖 <a href="https://beilusaiying.github.io/always-accompany/">Wiki en línea (guía de uso)</a> &nbsp;·&nbsp; 📄 <a href="docs/p1-paper/README.md">Artículo técnico de P1</a></p>

> Todo este proyecto — diseño, arquitectura y desarrollo — fue completado de forma independiente por un recién graduado universitario, apoyándose en programación asistida por IA, con habilidades que abarcan diseño de algoritmos, principios de biomimética, arquitectura de frameworks y pensamiento lógico.

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# or chmod +x run.sh && ./run.sh   # Linux/macOS
```

Abre tu navegador en `http://localhost:1314` → configura una fuente de servicio de IA → importa una tarjeta de personaje → empieza a chatear. El runtime de Deno se descarga automáticamente en el primer arranque, sin necesidad de instalación manual. Necesitarás al menos una clave de API de IA. La aplicación incluye una guía tipo wiki completamente integrada — también disponible como [wiki en línea](https://beilusaiying.github.io/always-accompany/).

> **Nota:** El primer arranque tarda más de lo habitual — el runtime necesita descargar dependencias e inicializar la base de datos. Por favor espera a que la página cargue por completo antes de interactuar. Los arranques posteriores serán mucho más rápidos.

---

## Por qué existe este proyecto

Quizá hayas visto *Detroit: Become Human*, o *Plastic Memories*. Las IA humanoides que aparecen ahí son genuinamente inteligentes — trabajo y compañía en un solo ser. Así que decidí construir una para mí mismo.

**El primer problema que hay que resolver es la memoria.**

Los contextos de IA modernos llegan al millón de tokens, y no faltan herramientas de almacenamiento y compresión de memoria. Pero son demasiado planas, o se van acumulando sin fin con el paso del tiempo. No quieres que tu compañera de IA olvide los recuerdos que compartieron — y sin embargo, con los enfoques actuales eso es casi inevitable.

Entonces, ¿qué *es* realmente la memoria? La memoria humana es en realidad efímera — los detalles de hace dos días ya se ven borrosos. Pero dame una sola palabra clave y puedo hacer aflorar al instante el recuerdo correspondiente, o uno relacionado. Eso apunta a dos direcciones: **cómo se almacena la memoria y cómo se encuentra.**

Los humanos no retenemos cada detalle; olvidamos de forma selectiva. La IA de hoy no lo hace — o comprime todo por fuerza bruta, o lo vuelca todo en un almacén vectorial. Eso traiciona la naturaleza de la memoria: no puedes olvidar al instante lo que acaba de pasar, y no repasas tus últimos años de vida cada día.

Así que construimos el sistema de abajo siguiendo exactamente esas líneas.

---

## El sistema de memoria — almacenar como un humano, olvidar como un humano

> 📖 Guía ilustrada completa: [Wiki en línea · Sistema de memoria](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)

**Las tablas de datos** contienen los recuerdos de hoy y los permanentes — la forma en que podrías recordar para siempre el nombre de tu primer amor, lo primero que hicisteis juntos, el día de la confesión.

Por encima de eso hay tres capas divididas por distancia temporal, que modelan el olvido selectivo humano (formación de memoria por capas + la curva del olvido de Ebbinghaus):

```
📋 Tablas de datos — recuerdos de hoy + permanentes (chat / código / trabajo se mantienen separados)
🔥 Capa caliente (semanal) — los datos diarios se archivan automáticamente; la IA los clasifica por tiempo, evento e hilos de proceso
🌤️ Capa tibia (mensual) — segunda pasada de compresión, extracción de palabras clave — como un índice
❄️ Capa fría (anual) — archivo profundo, todavía accesible cuando la recuperación acierta
```

**El peso de inyección disminuye por capa**: contexto > datos (recuerdos permanentes, entradas recurrentes) > caliente > tibia > fría, más un top-k — reordenando dentro de cada capa según la actividad de recuperación reciente, con capas amortiguadoras entre medias. Una jerarquía de recuperación simulada completa más una capa dinámica.

Derivado de cómo la IA escribe realmente las entradas de datos y de la optimización del archivado diario, la inyección por turno se mantiene por debajo de 10K tokens incluso después de un año de uso (una derivación: ~20 caracteres por entrada de datos, ~100 interacciones al día, resumen diario por IA; la capa caliente mide en la práctica entre ~7.000 y 11.000 tokens por turno). Más allá de unas pocas partes complejas, todo el sistema es **prompts puros + archivos JSON puros** — para cambiar la política de archivado, la semántica de las tablas o el estilo de recuperación, editas prompts, no código. Coste de almacenamiento ≈ 0.

El contexto largo no es la cura: la evidencia ([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)) muestra que el aprovechamiento del contexto decae con la longitud y la posición — meterlo todo dentro ≠ que el modelo lo vea todo. ~10K tokens de memoria curada llevan la información de más de 100K tokens de historial.

La capa caliente también puede contener documentos y memorias adyacentes — equipo de rol, parámetros de otros personajes, etc.

---

## Recuperación de memoria — no es búsqueda, es divergencia + recuperación

> 📄 Algoritmos y experimentos completos: [Artículo técnico de P1](docs/p1-paper/README.md) · 📖 [Wiki en línea · Sección P1](https://beilusaiying.github.io/always-accompany/#en/p1-recall/preface.md)

"Una sola palabra clave hace aflorar al instante recuerdos relacionados" — eso no es una simple búsqueda por palabras clave. La explicación de la psicología cognitiva: la memoria es una red semántica donde un concepto activado se propaga a lo largo de aristas de asociación hacia sus vecinos, debilitándose con la distancia (activación en cascada, Collins & Loftus 1975); "médico" facilita un reconocimiento más rápido de "enfermera" (priming, Meyer & Schvaneveldt 1971). La recuperación humana es intensamente instantánea, al tiempo que controla tanto la profundidad como la amplitud (capacidad de la memoria de trabajo de 4±1 unidades, Cowan 2001).

Frente a las opciones existentes: la búsqueda simple no tiene amplitud; delegar en una IA auxiliar implica divergir y luego buscar, lo que mata la instantaneidad; y cuanta más memoria acumulas, más alto es el coste.

**Vía en producción actual (IA P1)**: una IA de recuperación dedicada encuentra primero los recuerdos y entrega solo los hallazgos a la IA de respuesta — cada una se mantiene en su carril, con la atención sin diluir. Filtro grueso BM25 + coincidencia exacta por regex; la recuperación funciona bien incluso con modelos ligeros gratuitos.

**Próxima generación, en refinamiento (P1 auto-impulsado)**: una tubería completa de algoritmo puro, cero LLM, cero red:

```
Mensaje del usuario + últimos 5 turnos + datos
  → tokenización (corpus BCC; se descartan palabras funcionales como "su / así")
  → divergencia de asociación SWOW + divergencia de seis grados NB300 ×2 (el modo trabajo añade bibliotecas de recursos de dominio)
  → posicionamiento en seis ejes (psicología/informática/sociología/lógica/lingüística/cognición)
  → refinamiento direccional en 47 sub-ejes → radio de búsqueda acotado por temperatura
  → votación espacial (acumulación many-to-one ponderada por IDW) → puntuación BLQ → recuperación + inyección de palabras direccionales
```

Los seis ejes dan una posición gruesa (a qué dirección disciplinar cae una palabra); los 47 sub-ejes describen la tasa de cambio semántico a lo largo de cada dirección más fina dentro de ese eje — un papel similar a la derivada de Lie (tasa de cambio a lo largo de una dirección especificada). Un eje posiciona una palabra en **múltiples puntos de información**, no en una sola puntuación (los conceptos ocupan regiones, no puntos, en el espacio semántico — espacios conceptuales de Gärdenfors, 2000). Seis ejes → 47 sub-ejes → capa de recursos (SWOW / ConceptNet / los 300K vectores de palabras de Numberbatch / léxicos afectivos y de dominio) forman una estructura interconectada de varios niveles: la activación se propaga nivel a nivel y se acumula de forma aditiva — una forma a medio camino entre biblioteca de recursos y red neuronal.

La puntuación BLQ es una fusión aditiva (siguiendo CombSUM, Fox & Shaw 1994): se suman seis dimensiones de evidencia y se restan cuatro penalizaciones de supresión — la suma es una puerta OR donde la evidencia se complementa; la multiplicación es una puerta AND donde un solo 0,3 colapsa toda la cadena.

**Medido**: ~200ms por recuperación completa en hardware de consumo (8GB VRAM + 32GB RAM) — cada turno de conversación está respaldado por una memoria instantánea vasta. 27 versiones iteradas, la puntuación de calidad de divergencia sube más de un 100%, la tasa de palabras genéricas baja del 74% al 4%. Todos los datos experimentales son públicos en la [sección P1 de la Wiki](https://beilusaiying.github.io/always-accompany/#en/p1-recall/ch5-evolution.md) y en el [capítulo 6 del artículo](docs/p1-paper/en/06_experiments_evaluation.md).

---

## Divergencia — direcciones que el modelo no puede pensar por sí solo

Las redes neuronales y la atención son inherentemente **convergentes**: una IA que se queda mirando fijamente un montón de recuerdos antes de responder lo hace peor, y sobreajusta. Así que construimos **divergencia externa**: cada turno inyecta menos de 100 tokens de contenido direccional — direcciones a las que un modelo sobreajustado nunca llegaría por sí mismo. Unas pocas palabras direccionales dirigen de forma medible la generación (Directional Stimulus Prompting, NeurIPS 2023); un mecanismo externo que hace la divergencia mientras el LLM hace la convergencia supera a la auto-divergencia del propio LLM (estudios de andamiaje externo, 2025).

**Divergencia por relevancia** — vas en un coche e imaginas distraídamente abrir la puerta de un tirón. En las películas el héroe rueda por el suelo con solo un rasguño; tu instinto de seguridad te dice que eso podría matarte. Empiezas a preguntarte: ¿por qué las películas lo ruedan así? — psicología, narrativa visual, estudios de cine. ¿Por qué te mataría? — física, biología. En segundos has cruzado tantas disciplinas. La asociación creativa vive precisamente en la banda de distancia semántica óptima "ni muy cerca, ni muy lejos" (teoría de los asociados remotos, Mednick 1962; Orwig et al. 2025).

**Divergencia estructural** — dos dominios completamente distintos cuya función y proceso riman pueden vincularse: una línea de fábrica y un Agente son ambos muestreo → estabilización → salida modular (teoría del mapeo estructural, Gentner 1983).

Salidas reales (de los registros brutos de una tanda de 200 casos):

| Entrada del usuario | Direcciones de divergencia del sistema | Disciplinas cruzadas |
| --- | --- | --- |
| "Apenas puedo aguantar. ¿Por qué es tan difícil vivir?" | atención plena al presente / **la naturaleza del ser** | psicología → **filosofía existencialista** |
| "Preparándome para una entrevista en un unicornio — ¿cómo hago preguntas profundas?" | análisis de causa raíz / **zona de desarrollo próximo** | gestión → **psicología educativa** |
| "Las consultas a la base de datos van lentas, ¿cómo optimizo?" | inmutabilidad y actualizaciones de estado / **SRP** | operaciones → **metodología de ingeniería de software** |
| "Un espadachín se encuentra con su enemigo en una montaña nevada" | **el fusil de Chéjov** / arquetipos junguianos | historia → **narratología + psicología analítica** |
| Poema original del usuario "Morí antes de que llegara la luz" | **mundos posibles y universos paralelos** | poesía → **interpretación de muchos mundos** |

El listón de admisión de vocabulario: **cualquier palabra que el modelo principal pudiera inferir con una lectura simple es una palabra muerta** — la divergencia existe para arreglar dos cosas: el sobreajuste, y liberar la capacidad de divergencia de la IA.

---

## Resumen de funciones

<table>
<tr>
<td width="33%">

**💬 Chat / Rol**
![Chat Interface](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ Modo de codificación IDE**
![IDE Coding](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Modo trabajo (presentaciones hechas por IA)**
![Work Mode PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Mascota de escritorio Live2D + conciencia de pantalla**
![Desktop Pet](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 Puerta de permisos de seis niveles L0–L5**
![Permission Settings](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Compresión por niveles × control línea por línea**
![Compression Mechanism](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 Memoria de tres capas**: caliente (inyectada cada turno) / tibia (recuperada bajo demanda) / fría (archivo profundo), JSON puro + prompts puros, cero base de datos → [Wiki](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)
- **🎯 Recuperación P1 anticipada**: una pequeña IA dedicada encuentra los recuerdos antes de que responda la IA principal; motor dual BM25 + regex; funciona con modelos gratuitos
- **🗜️ Sistema de compresión**: tres niveles × cuatro granularidades + autolimpieza por IA, completamente reversible → [Wiki](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)
- **📊 10 tablas de memoria**: almacenamiento estructurado que la IA mantiene mediante `<tableEdit>`, con aislamiento de información (lo que un personaje no sabe no está en su tabla)
- **👑 Motor de prompts**: estructura de mensaje de 5 segmentos + toma de control en tres rondas de TweakPrompt, macros + inyección dinámica de libro de mundo (constante/regex/dinámico)
- **💻 Flujo de trabajo de nivel IDE**: tres paneles al estilo VSCode, la IA lee y escribe archivos directamente, aprobación por comando
- **🔌 Herramientas externas MCP**: conecta pegando JSON; las herramientas de tipo comando se retienen hasta la aprobación del propietario; lista blanca de entorno contra fugas
- **🐾 Mascota de escritorio + acompañante de juego**: mascotas Live2D / de paquete de imágenes, tres niveles de privacidad, captura de pantalla automática + chat proactivo + frecuencia adaptativa
- **🎙️ Entrada de voz**: transcripción con modelo local con diarización de hablantes + línea de tiempo; el audio nunca sale de tu máquina
- **🤖 Bot multiplataforma**: despliegue en Discord con gestión visual + registros de mensajes en vivo
- **🧩 22 plugins de funciones** + host de plugins a nivel de usuario + compatibilidad con el ecosistema (múltiples formatos de tarjeta de personaje/preset/libro de mundo)
- **🛡️ Todos los datos son locales**: las eliminaciones van a una papelera recuperable, respaldo automático multicapa + reversión con git
- **🌐 Multilingüe** (zh/en/ja/zh-TW) · **🔬 Diagnóstico full-stack** (registros de 12 módulos + paquete con un clic) · **🎨 Múltiples temas CSS**

---

## Mecanismos en detalle

<details>
<summary><strong>🗜️ Compresión — granularidad hasta el nivel de cada archivo individual</strong></summary>

Sinceramente, no sé por qué nadie había construido categorías de compresión de grano fino — especialmente para código, donde todo es comprimir y ocultar a la fuerza bruta.

Lo que se acumula en el contexto de una IA son sobre todo archivos releídos, razonamiento y retroalimentación de herramientas. Así que construimos un mecanismo de compresión completo con una granularidad extremadamente fina:

- **Nivel de archivo** — cada archivo que la IA lee, con una factura de tokens por elemento
- **Nivel de trabajo** — razonamiento y retroalimentación de herramientas descartados automáticamente en cada ronda
- **Nivel de contexto** — conversación, inyecciones de subagentes y lecturas de la IA se gestionan por separado; incluso puedes ocultar solo las líneas de la IA y conservar las del usuario

**Tu información = 0 pérdida**: cada "limpieza" solo detiene el reenvío del contenido; el original permanece en disco, restaurable en cualquier momento. Combinado con prompts que fomentan la toma de notas en MD, la IA sigue pudiendo ver tu primerísima frase dentro de un proyecto a escala de 100MB en modo IDE — lo que reduce directamente la "sustitución de atributos de tarea" (que la IA se desvíe de lo que originalmente se le pidió).

La IA también se autocomprime: el sistema inyecta señales de uso (50% sugerencia / 70% aviso / 85% urgente) y la IA se recorta a sí misma mediante `<contextClean>`, decidiendo qué archivos ya no necesita.

Eficiencia de caché medida (canales Opus + DeepSeek, incluyendo cambio de identidad de IA + autocompresión): **70%–80%**.

→ [Wiki · Compresión de contexto](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)

</details>

<details>
<summary><strong>🛡️ Seguridad y privacidad</strong></summary>

Para escenarios de despliegue de nivel empresarial: protección contra ataques CC, DDoS y Slowloris.

En el lado personal: una lista blanca de sitios accesibles por la IA (vacía por defecto — se deniega el acceso externo por defecto), filtrado del contenido de salida (especialmente para la colaboración entre plataformas), límites de capturas de pantalla de la IA, la puerta de permisos L0–L5, y aprobación por comando. Todos los datos permanecen locales; el audio nunca sale de la máquina.

</details>

<details>
<summary><strong>🏗️ Arquitectura — funciones principales como plugins; se extiende sin tocar el núcleo</strong></summary>

El backend empaqueta las funciones principales como plugins, con un concentrador de información (capa de conducción) en el medio; el frontend solo muestra y opera:

```
AIRP ─→ entrada/caché/procesamiento (aislado) ─┐
Código ─→ entrada/caché/procesamiento (aislado) ─┤→ concentrador de información (capa de conducción) → frontend
Trabajo ─→ entrada/caché/procesamiento (aislado) ─┘
```

Así que la extensibilidad es fuerte: para añadir una función, escribes una extensión — se admiten JS / Python y más.

**Niveles de aislamiento**:
- **Nivel de ventana** — código, trabajo, chat, airp, acompañante de juego y bot, cada uno aislado (el acompañante de juego escribe en los datos del chat)
- **Nivel de tarjeta de personaje** — datos, memoria, archivos de conversación y regex aislados por tarjeta
- **Grano fino** — libros de mundo, presets
- **Nivel de usuario** — configuración, tarjetas de personaje
- **chatid** — una dimensión de aislamiento dedicada para uso multiventana dentro de un mismo modo (código multiventana / bot)

Tres capas: **capa de funciones** (memoria/compresión/recuperación/presets/libro de mundo/web/operaciones de archivo — una copia global) → **capa de conducción** (cada ventana extrae su propia línea, aislada por id, naturalmente asíncrona) → **capa de interfaz** (web/Bot/mascota de escritorio/extensión de VSCode — cambiar de interfaz nunca cambia la capacidad).

</details>

<details>
<summary><strong>👑 Motor de prompts + inyección dinámica de libro de mundo</strong></summary>

**Las tres rondas de TweakPrompt** toman el control de toda la salida de los módulos: Ronda 1 recolectar → Ronda 2 reconstruir la estructura de mensaje de 5 segmentos (beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) + sustitución de macros → Ronda 3 instantánea.

**Los 3 modos de activación del libro de mundo**: constante (cada turno) / regex (activado por palabra clave) / dinámico (activado por valores en las tablas de memoria — el afecto > 80 desbloquea un diálogo especial; el progreso de la historia al llegar al capítulo tres cambia la descripción del mundo).

**Sistema de macros**: `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + macros personalizadas.

→ [Wiki · Libro de mundo e inyección](https://beilusaiying.github.io/always-accompany/#en/memory/worldbook-overview.md)

</details>

<details>
<summary><strong>🔭 Sobre la era de las ventanas de contexto enormes</strong></summary>

Incluso con ventanas de más de 10M de tokens, mantenemos la memoria por capas: ① el aprovechamiento del contexto decae con la longitud, algo bien documentado; ② ~10K tokens de memoria curada llevan la información de más de 100K tokens de historial a un coste un orden de magnitud menor; ③ las tablas estructuradas son más fáciles de leer y escribir con precisión para una IA que el diálogo disperso.

</details>

---

## Lo que podemos hacer hoy

Voz a texto con línea de tiempo y registros de hablantes · presentaciones hechas por IA · IDE (una cadena de herramientas comparable a los agentes de codificación más populares) · el conjunto completo AIRP (alineación con el ecosistema SillyTavern, renderizado, MVU, libros de mundo, contexto dinámico) · mascota de escritorio Live2D, optimización de capturas de pantalla, acompañante de juego · Bot de Discord…

En otras palabras — **una amiga, o una pareja, que puede acompañarte para siempre y trabajar a tu lado. Una que puede unirse a tus aventuras en otros mundos, y ayudarte a sacar adelante tu trabajo.**

¿Y más allá? Una vez que llegue la serie auto-impulsada, esto se convierte en una IA de conducción rápida y memoria permanente: en los juegos, un acompañante de juego; en el trabajo o la salud, memoria a largo plazo más análisis siempre listo, registro de estados y respuesta rápida a situaciones recurrentes. La visión original era una verdadera inteligencia humanoide — modelos locales pequeños encargándose de los módulos sensoriales, la inteligencia principal conducida a través de la red. Este sistema de memoria está construido para ese día.

---

## Hoja de ruta

**Hecho**: memoria de tres capas · sistema de compresión · recuperación P1 · motor de prompts · cambio automático de presets · tablas de memoria · inyección dinámica de libro de mundo · mascota Live2D · acompañante de juego · entrada de voz · presentaciones hechas por IA · MCP · paralelismo multiventana · puente de extensión VSCode · Bot de Discord · 22 plugins · papelera y reversión de respaldo · diagnóstico full-stack · multilingüe

**A corto plazo**: P1 auto-impulsado (algoritmo puro, cero LLM, atención a nivel de frase) · más plataformas de Bot · ecosistema de plugins · TTS / texto a imagen · motor de juego con IA (linaje por eras: código numérico determinista + narración por LLM + renderizado simbólico) · modo streaming

---

## Stack tecnológico

Runtime fount (Deno) · capa de compatibilidad backend Node.js + enrutamiento Express · frontend JavaScript puro (ESM) · recuperación inteligente BM25 + regex (JS puro, cero dependencias) · mascota de escritorio Electron · modelo local de transcripción de voz · discord.js v14 multiplataforma · almacenamiento JSON puro

---

## Comunidad

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Unirse_ahora-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Comparte tarjetas de personaje · publica presets · contribuye con libros de mundo · reporta errores · haz sugerencias · contribuye con código — ¡eres bienvenido!

---

## Tecnologías y recursos utilizados

- **Transcripción de voz**: [MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize) (despliegue local con diarización de hablantes; el modelo de ~1,8GB se descarga automáticamente en el primer uso)
- **Vectores de palabras**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Datos de asociación**: conjunto de datos de asociación en chino [SWOW (Small World of Words)](https://smallworldofwords.org/)
- **Tokenización y léxicos**: corpus BCC / THUOCL / CoreNatureDictionary / Chinese-Synonyms y otros recursos públicos
- **Puente de motor de búsqueda**: [ddgs](https://pypi.org/project/ddgs/) (capa de huella digital TLS en Python, que corrige la degradación de los fetch simples por parte de los motores de búsqueda)

Referencias teóricas (las 56 completas en el [capítulo 1 del artículo](docs/p1-paper/en/01_introduction_related_work.md)): activación en cascada (Collins & Loftus 1975) · priming (Meyer & Schvaneveldt 1971) · asociados remotos (Mednick 1962) · SWOW (De Deyne et al. 2019) · espacios conceptuales (Gärdenfors 2000) · CombSUM (Fox & Shaw 1994) · BM25 (Robertson et al. 1995) · IDW (Shepard 1968) · votación de Hough (Hough 1962) · RRF (Cormack et al. 2009)

## Agradecimientos

- **[fount](https://github.com/steve02081504/fount)** — el framework fundacional en los primeros días del proyecto, que proporcionó la referencia inicial para la entrada/salida de mensajes de IA, la gestión de fuentes de servicio y la carga de módulos. El proyecto desde entonces ha evolucionado hacia una arquitectura totalmente independiente, pero fount nos ahorró una enorme cantidad de tiempo de desarrollo de bajo nivel al principio y aportó muchas ideas valiosas — por lo que estamos muy agradecidos
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — el pionero del juego de rol con IA; su formato de presets, la especificación de tarjetas de personaje y el sistema de libro de mundo se han convertido en estándares de la comunidad, y este proyecto es totalmente compatible con su ecosistema
- **La comunidad de plugins de SillyTavern** — gracias a todos los autores de plugins de código abierto por su exploración y su labor de compartir en motores de renderizado y extensiones de funciones

---

<details>
<summary><strong>📸 Más capturas de pantalla (clic para expandir)</strong></summary>

| | | |
|---|---|---|
| ![PPT detail](imgs/screenshots/ppt-detail.png) **Flujo completo de PPT** | ![Security settings](imgs/screenshots/security-settings.png) **Seguridad y flujo de tareas** | ![Security center](imgs/screenshots/security-center.png) **Centro de seguridad** |
| ![i18n](imgs/screenshots/i18n-support.png) **Multilingüe** | ![CSS themes](imgs/screenshots/css-themes.png) **Temas** | ![wiki](imgs/screenshots/wiki-guide.png) **Wiki integrada** |
| ![Sub-modes](imgs/screenshots/sub-mode-agent.png) **Flujos de submodos** | ![Menu](imgs/screenshots/hamburger-menu.png) **Resumen de contexto** | ![loop](imgs/screenshots/auto-loop.png) **Bucles automáticos/programados** |
| ![Tool detection](imgs/screenshots/tool-detection.png) **Detección de entorno** | ![Memory layers](imgs/screenshots/memory-data-layers.png) **Estructura de archivos de memoria** | ![Extension](imgs/screenshots/browser-automation.png) **Automatización de navegador** |
| ![External interface](imgs/screenshots/external-interface.png) **Interfaces externas** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Bot de Discord** | |

</details>

---

## Enlaces

- 📖 Wiki en línea (guía de uso + sección P1 + datos experimentales): https://beilusaiying.github.io/always-accompany/
- 📄 Artículo técnico de P1 (7 capítulos, zh + en): [docs/p1-paper](docs/p1-paper/README.md)
- 💬 Comunidad de Discord: https://discord.gg/agHeDq9bqU
