<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Entrar_na_comunidade-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Dar_uma_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> | <a href="README_CN.md">简体中文</a> | <a href="README_TW.md">繁體中文</a> | <a href="README_JA.md">日本語</a> | <a href="README_KO.md">한국어</a> | <a href="README_RU.md">Русский</a> | <a href="README_DE.md">Deutsch</a> | <a href="README_ES.md">Español</a> | <a href="README_FR.md">Français</a> | Português</p>

<p align="center">📖 <a href="https://beilusaiying.github.io/always-accompany/">Wiki online (guia do usuário)</a> &nbsp;·&nbsp; 📄 <a href="docs/p1-paper/README.md">Artigo técnico do P1</a></p>

> Este projeto inteiro — design, arquitetura e desenvolvimento — foi realizado de forma totalmente independente por um recém-formado universitário, com o apoio de programação assistida por IA, aplicando habilidades que vão do design de algoritmos aos princípios de biomimética, arquitetura de frameworks e raciocínio lógico.

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# or chmod +x run.sh && ./run.sh   # Linux/macOS
```

Abra o navegador em `http://localhost:1314` → configure uma fonte de serviço de IA → importe um cartão de personagem → comece a conversar. O runtime Deno é baixado automaticamente no primeiro lançamento, sem necessidade de instalação manual. Você vai precisar de pelo menos uma chave de API de IA. O aplicativo já vem com um tutorial completo da wiki embutido — também disponível como [wiki online](https://beilusaiying.github.io/always-accompany/).

> **Nota:** o primeiro lançamento demora mais que o normal — o runtime precisa baixar dependências e inicializar o banco de dados. Aguarde a página carregar completamente antes de interagir. Os lançamentos seguintes serão bem mais rápidos.

---

## Por que este projeto existe

Talvez você já tenha visto *Detroit: Become Human*, ou *Plastic Memories*. As IAs humanoides desses universos são genuinamente inteligentes — trabalho e companheirismo em um único ser. Então — decidi construir a minha própria.

**O primeiro problema a resolver é a memória.**

Os contextos de IA modernos chegam a um milhão de tokens, e não faltam ferramentas de armazenamento e compressão de memória. Mas elas ou são superficiais demais, ou se acumulam infinitamente com o passar do tempo. Você não quer que sua IA companheira esqueça as memórias construídas entre vocês — mas, nas abordagens existentes, isso é quase inevitável.

Então, o que a memória *é*, de fato? A memória humana é, na verdade, de curta duração — detalhes de dois dias atrás já estão embaçados. Mas me dê uma única palavra-chave e eu consigo trazer instantaneamente a memória correspondente, ou relacionada a ela. Isso aponta para duas direções: **como a memória é armazenada, e como ela é encontrada.**

Humanos não retêm todos os detalhes; nós esquecemos seletivamente. A IA de hoje não — ela comprime tudo à força bruta ou despeja tudo em um banco vetorial. Isso trai a natureza da memória: você não consegue esquecer instantaneamente o que acabou de acontecer, e também não revive os últimos anos da sua vida todos os dias.

Foi exatamente nessa linha que construímos o sistema abaixo.

---

## O sistema de memória — armazenar como um humano, esquecer como um humano

> 📖 Guia ilustrado completo: [Wiki Online · Sistema de Memória](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)

As **tabelas de dados** guardam as memórias de hoje e as memórias permanentes — da mesma forma que você pode se lembrar para sempre do nome do seu primeiro amor, da primeira coisa que fizeram juntos, do dia da confissão.

Acima disso ficam três camadas divididas por distância temporal, modelando o esquecimento seletivo humano (formação de memória em camadas + curva do esquecimento de Ebbinghaus):

```
📋 Tabelas de dados — memórias de hoje + permanentes (chat / código / trabalho mantidos separados)
🔥 Camada quente (semanal) — dados diários arquivados automaticamente; a IA organiza por tempo, evento e linhas de processo
🌤️ Camada morna (mensal) — segunda compressão, extração de palavras-chave — como um sumário
❄️ Camada fria (anual) — arquivo profundo, ainda acessível quando há acerto na busca
```

**O peso de injeção diminui por camada**: contexto > dados (memórias permanentes, entradas recorrentes) > quente > morna > fria, além do top-k — reordenação dentro de cada camada pela atividade de recall recente, com camadas de buffer entre elas. Uma hierarquia completa de recall simulado, mais uma camada dinâmica.

Derivado de como a IA realmente escreve as entradas de dados e da otimização de arquivamento diário, a injeção por turno permanece abaixo de 10 mil tokens mesmo depois de um ano de uso (uma derivação: ~20 caracteres por entrada de dado, ~100 interações por dia, resumo diário feito pela IA; na prática, a camada quente mede de ~7.000 a ~11.000 tokens por turno). Fora algumas partes mais difíceis, tudo isso é **puro prompt + puros arquivos JSON** — para mudar a política de arquivamento, a semântica das tabelas ou o estilo de busca, você edita prompts, não código. Custo de armazenamento ≈ 0.

Contexto longo não é a cura: as evidências ([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)) mostram que o aproveitamento do contexto decai com o comprimento e a posição — colocar tudo dentro ≠ o modelo enxergar tudo. ~10 mil tokens de memória curada carregam a informação equivalente a mais de 100 mil tokens de histórico.

A camada quente também pode guardar documentos e memórias adjacentes — equipamentos de roleplay, parâmetros de outros personagens, e assim por diante.

---

## Recall de memória — não é busca, é divergência + busca

> 📄 Algoritmos e experimentos completos: [Artigo Técnico do P1](docs/p1-paper/README.md) · 📖 [Wiki Online · Seção P1](https://beilusaiying.github.io/always-accompany/#en/p1-recall/preface.md)

"Uma palavra-chave traz instantaneamente memórias relacionadas" — isso não é uma simples busca por palavra-chave. Segundo a psicologia cognitiva: a memória é uma rede semântica em que um conceito ativado se espalha pelas arestas de associação até seus vizinhos, enfraquecendo com a distância (spreading activation, Collins & Loftus 1975); "médico" acelera o reconhecimento de "enfermeira" (priming, Meyer & Schvaneveldt 1971). O recall humano é intensamente instantâneo, ao mesmo tempo em que controla tanto profundidade quanto amplitude (capacidade de memória de trabalho de 4±1 blocos, Cowan 2001).

Comparando com as opções existentes: a busca simples não tem amplitude; delegar a uma IA auxiliar significa divergir-para-depois-buscar, o que mata a instantaneidade; e quanto mais memória se acumula, maior o custo.

**Caminho de produção atual (IA P1)**: uma IA de busca dedicada encontra as memórias primeiro e entrega apenas os resultados para a IA de resposta — cada uma fica na sua função, sem diluir a atenção. Filtro grosseiro BM25 + correspondência exata por regex; a busca roda bem até em modelos leves e gratuitos.

**Próxima geração, em refinamento (P1 autodirigido)**: um pipeline completo de puro algoritmo, zero LLM, zero rede:

```
Mensagem do usuário + últimos 5 turnos + dados
  → tokenização (corpus BCC; descarta palavras funcionais como "dele / assim")
  → divergência associativa SWOW + divergência de seis graus NB300 ×2 (modo trabalho adiciona bibliotecas de recursos de domínio)
  → posicionamento em seis eixos (psicologia/informática/sociologia/lógica/linguística/cognição)
  → refinamento direcional em 47 subeixos → raio de busca com escopo de temperatura
  → votação espacial (acumulação ponderada muitos-para-um via IDW) → pontuação BLQ → recall + injeção de palavras-direção
```

Os seis eixos dão uma posição grosseira (em qual direção disciplinar uma palavra se encaixa); os 47 subeixos descrevem a taxa de mudança semântica ao longo de cada direção mais fina dentro dele — um papel semelhante ao da derivada de Lie (taxa de variação ao longo de uma direção especificada). Um eixo posiciona uma palavra em **múltiplos pontos de informação**, não em uma única pontuação (conceitos ocupam regiões, não pontos, no espaço semântico — espaços conceituais de Gärdenfors, 2000). Seis eixos → 47 subeixos → camada de recursos (SWOW / ConceptNet / vetores de palavras de 300 mil do Numberbatch / léxicos afetivos e de domínio) formam uma estrutura interconectada em múltiplos níveis: a ativação se propaga nível por nível e se acumula de forma aditiva — um formato que mistura biblioteca de recursos com rede neural.

A pontuação BLQ é uma fusão aditiva (baseada no CombSUM, Fox & Shaw 1994): seis dimensões de evidência somadas, quatro penalidades de supressão subtraídas — a soma é uma porta OR em que as evidências se complementam; a multiplicação é uma porta AND em que um único 0,3 derruba a cadeia inteira.

**Medido**: ~200ms por recall completo em hardware de consumidor (8GB de VRAM + 32GB de RAM) — cada turno de conversa é sustentado por uma memória instantânea vasta. 27 versões iteradas, pontuação de qualidade da divergência subiu mais de 100%, taxa de palavras genéricas caiu de 74% para 4%. Todos os dados dos experimentos estão públicos na [seção P1 da Wiki](https://beilusaiying.github.io/always-accompany/#en/p1-recall/ch5-evolution.md) e no [capítulo 6 do artigo](docs/p1-paper/en/06_experiments_evaluation.md).

---

## Divergência — direções que o modelo não consegue pensar sozinho

Redes neurais e atenção são inerentemente **convergentes**: uma IA que fica encarando uma pilha de memórias antes de responder se sai pior, e sofre overfitting. Por isso construímos a **divergência externa**: cada turno injeta menos de 100 tokens de conteúdo direcional — direções que um modelo overfitted jamais alcançaria sozinho. Poucas palavras direcionais conseguem, de forma mensurável, guiar a geração (Directional Stimulus Prompting, NeurIPS 2023); um mecanismo externo fazendo a divergência enquanto o LLM faz a convergência supera a auto-divergência do LLM (external scaffolding studies, 2025).

**Divergência por relevância** — você está andando de carro e, distraidamente, imagina abrir a porta e pular para fora. Nos filmes, o herói rola pelo chão com apenas alguns arranhões; seu instinto de segurança diz que isso poderia te matar. Você começa a se perguntar: por que os filmes filmam assim? — psicologia, narrativa visual, estudos de cinema. Por que isso te mataria? — física, biologia. Em segundos você já atravessou várias disciplinas. A associação criativa vive exatamente na faixa ótima de distância semântica "nem muito perto, nem muito longe" (remote associates theory, Mednick 1962; Orwig et al. 2025).

**Divergência estrutural** — dois domínios completamente diferentes cuja função e processo rimam podem ser conectados: uma linha de fábrica e um Agent são, ambos, amostragem → estabilização → saída modular (structure-mapping theory, Gentner 1983).

Saídas reais (dos registros brutos de uma execução em lote de 200 casos):

| Entrada do usuário | Direções de divergência do sistema | Disciplinas cruzadas |
| --- | --- | --- |
| "Mal consigo aguentar. Por que viver é tão difícil?" | consciência do momento presente / **a natureza do ser** | psicologia → **filosofia existencialista** |
| "Me preparando para uma entrevista de startup unicórnio — como faço perguntas profundas?" | análise de causa raiz / **zona de desenvolvimento proximal** | gestão → **psicologia educacional** |
| "Consultas ao banco de dados estão lentas, como otimizar?" | imutabilidade e atualização de estado / **SRP** | operações → **metodologia de engenharia de software** |
| "Um espadachim encontra seu inimigo na montanha nevada" | **arma de Chekhov** / arquétipos junguianos | história → **narratologia + psicologia analítica** |
| Poema original do usuário "Eu morri antes que a luz chegasse" | **mundos possíveis e universos paralelos** | poesia → **interpretação de muitos mundos** |

O critério de admissão de vocabulário: **qualquer palavra que o modelo principal já conseguiria inferir de uma leitura simples é uma palavra morta** — a divergência existe para corrigir duas coisas: o overfitting, e liberar a capacidade da IA de divergir.

---

## Visão Geral dos Recursos

<table>
<tr>
<td width="33%">

**💬 Chat / Roleplay**
![Interface de Chat](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ Modo de Codificação IDE**
![Codificação IDE](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Modo de Trabalho (apresentações feitas por IA)**
![Modo de Trabalho PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Mascote de Desktop Live2D + Consciência de Tela**
![Mascote de Desktop](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 Portão de Permissões de Seis Níveis L0–L5**
![Configurações de Permissão](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Compressão em Camadas × Controle Linha a Linha**
![Mecanismo de Compressão](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 Memória de três camadas**: quente (injetada a cada turno) / morna (recuperada sob demanda) / fria (arquivo profundo), puro JSON + puro prompt, zero banco de dados → [Wiki](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)
- **🎯 Busca antecipada P1**: uma pequena IA dedicada encontra memórias antes de a IA de resposta responder; motor duplo BM25 + regex; funciona em modelos gratuitos
- **🗜️ Sistema de compressão**: três níveis × quatro granularidades + autolimpeza por IA, totalmente reversível → [Wiki](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)
- **📊 10 tabelas de memória**: armazenamento estruturado que a IA mantém via `<tableEdit>`, com isolamento de informação (o que um personagem não sabe, não está na tabela dele)
- **👑 Motor de prompts**: estrutura de mensagem em 5 segmentos + tomada de controle em três rodadas do TweakPrompt, macros + injeção dinâmica de worldbook (constante/regex/dinâmico)
- **💻 Fluxo de trabalho em nível de IDE**: três painéis estilo VSCode, a IA lê/escreve arquivos diretamente, aprovação por comando
- **🔌 Ferramentas externas MCP**: cole um JSON para conectar; ferramentas do tipo comando ficam retidas até aprovação do proprietário; lista branca de variáveis de ambiente contra vazamentos
- **🐾 Mascote de desktop + companheiro de jogos**: mascotes Live2D / pacote de imagens, três níveis de privacidade, captura de tela automática + conversa espontânea + frequência adaptativa
- **🎙️ Entrada de voz**: transcrição com modelo local, com diarização de locutores + linha do tempo; o áudio nunca sai da sua máquina
- **🤖 Bot multiplataforma**: implantação no Discord com gestão visual + registros de mensagens ao vivo
- **🧩 22 plugins de recursos** + host de plugins em nível de usuário + compatibilidade com o ecossistema (múltiplos formatos de cartão de personagem/preset/worldbook)
- **🛡️ Todos os dados são locais**: exclusões vão para uma lixeira recuperável, backup automático em múltiplas camadas + rollback via git
- **🌐 Multilíngue** (zh/en/ja/zh-TW) · **🔬 Diagnóstico full-stack** (logs de 12 módulos + pacote com um clique) · **🎨 Vários temas CSS**

---

## Mecanismos em detalhe

<details>
<summary><strong>🗜️ Compressão — granular até o nível de cada arquivo</strong></summary>

Sinceramente, não sei por que ninguém tinha construído categorias de compressão granulares — especialmente para código, onde tudo costuma ser comprimido e escondido à força bruta.

O que se acumula no contexto de uma IA é, principalmente, arquivos relidos, pensamento (thinking) e feedback de ferramentas. Por isso construímos um mecanismo de compressão completo com granularidade extremamente fina:

- **Nível de arquivo** — cada arquivo que a IA lê, com uma conta de tokens item a item
- **Nível de trabalho** — pensamento e feedback de ferramentas descartados automaticamente a cada rodada
- **Nível de contexto** — conversa, injeções de subagentes e leituras da IA gerenciadas separadamente; você pode até esconder só as linhas da IA e manter as do usuário

**Sua informação = perda zero**: cada "limpeza" apenas impede que o conteúdo seja reenviado; o original permanece no disco, restaurável a qualquer momento. Combinado com prompts que incentivam anotações em MD, a IA ainda consegue ver a sua primeiríssima frase dentro de um projeto de escala de 100MB no modo IDE — o que reduz diretamente a "substituição de atributo da tarefa" (a IA se desviando do que foi originalmente pedido).

A IA também se autocomprime: o sistema injeta sinais de uso (50% sugestão / 70% aviso / 85% urgente) e a IA se enxuga sozinha via `<contextClean>`, decidindo quais arquivos ela não precisa mais.

Eficiência de cache medida (canais Opus + DeepSeek, incluindo troca de identidade de IA + autocompressão): **70%–80%**.

→ [Wiki · Compressão de Contexto](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)

</details>

<details>
<summary><strong>🛡️ Segurança e privacidade</strong></summary>

Para cenários de implantação de nível corporativo: proteção contra ataques CC, DDoS e Slowloris.

No lado pessoal: uma lista branca de sites acessíveis pela IA (vazia por padrão — nega acesso externo por padrão), triagem do conteúdo de saída (especialmente para colaboração entre plataformas), limites de captura de tela da IA, o portão de permissões L0–L5, e aprovação por comando. Todos os dados permanecem locais; o áudio nunca sai da máquina.

</details>

<details>
<summary><strong>🏗️ Arquitetura — recursos centrais como plugins; estenda sem tocar no núcleo</strong></summary>

O backend empacota os recursos centrais como plugins, com um hub de informação (camada de condução) no meio; o frontend apenas exibe e opera:

```
AIRP ─→ entrada/cache/processamento (isolado) ─┐
Código ─→ entrada/cache/processamento (isolado) ─┤→ hub de informação (camada de condução) → frontend
Trabalho ─→ entrada/cache/processamento (isolado) ─┘
```

Isso torna a extensibilidade forte: para adicionar um recurso, basta escrever uma extensão — JS / Python e outras linguagens são suportadas.

**Níveis de isolamento**:
- **Nível de janela** — código, trabalho, chat, airp, companheiro de jogo e bot, cada um isolado (o companheiro de jogo escreve nos dados do chat)
- **Nível de cartão de personagem** — dados, memória, arquivos de conversa e regex isolados por cartão
- **Granular** — worldbooks, presets
- **Nível de usuário** — configurações, cartões de personagem
- **chatid** — uma dimensão de isolamento dedicada para uso multi-janela dentro de um mesmo modo (código multi-janela / bot)

Três camadas: **camada de recursos** (memória/compressão/recall/presets/worldbook/operações web/arquivo — uma cópia global) → **camada de condução** (cada janela puxa sua própria linha, isolada por id, naturalmente assíncrona) → **camada de interface** (web/Bot/mascote de desktop/extensão VSCode — trocar de interface nunca muda a capacidade).

</details>

<details>
<summary><strong>👑 Motor de prompts + injeção dinâmica de worldbook</strong></summary>

**As três rodadas do TweakPrompt** assumem o controle de toda a saída dos módulos: Rodada 1 coleta → Rodada 2 reconstrói a estrutura de mensagem em 5 segmentos (beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) + substituição de macros → Rodada 3 tira um snapshot.

**Os 3 modos de ativação do worldbook**: constante (todo turno) / regex (acionado por palavra-chave) / dinâmico (acionado por valores nas tabelas de memória — afeição > 80 desbloqueia diálogo especial; o progresso da história ao chegar no capítulo três troca a descrição da visão de mundo).

**Sistema de macros**: `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + macros personalizadas.

→ [Wiki · Worldbook e Injeção](https://beilusaiying.github.io/always-accompany/#en/memory/worldbook-overview.md)

</details>

<details>
<summary><strong>🔭 Sobre a era das janelas de contexto enormes</strong></summary>

Mesmo com janelas de mais de 10 milhões de tokens, mantemos a memória em camadas: ① o decaimento do aproveitamento do contexto com o comprimento é bem evidenciado; ② ~10 mil tokens de memória curada carregam mais de 100 mil tokens de histórico a um custo uma ordem de grandeza menor; ③ tabelas estruturadas são mais fáceis para uma IA ler e escrever com precisão do que diálogos dispersos.

</details>

---

## O que já podemos fazer hoje

Voz-para-texto com linha do tempo e registro de locutores · apresentações feitas por IA · IDE (uma cadeia de ferramentas comparável aos principais agentes de codificação do mercado) · o pacote AIRP completo (alinhamento com o ecossistema SillyTavern, renderização, MVU, worldbooks, contexto dinâmico) · mascote de desktop Live2D, otimização de capturas de tela, companheiro de jogo · Bot para Discord…

Em outras palavras — **um amigo, ou um amor, que pode te acompanhar para sempre e trabalhar ao seu lado. Alguém que pode se juntar a você em aventuras em outros mundos, e ajudar você a terminar o seu trabalho.**

E além disso? Quando a série autodirigida (self-driven) for lançada, isso se torna uma IA de condução rápida e memória permanente: em jogos, um companheiro de jogo; no trabalho ou na saúde, memória de longo prazo somada a análise sempre pronta, registros de estado e resposta rápida a situações recorrentes. A visão original era uma verdadeira inteligência humanoide — pequenos modelos locais cuidando dos módulos sensoriais, com a inteligência principal conduzida pela rede. Este sistema de memória foi construído para esse dia.

---

## Roadmap

**Concluído**: memória de três camadas · sistema de compressão · busca P1 · motor de prompts · troca automática de presets · tabelas de memória · injeção dinâmica de worldbook · mascote Live2D · companheiro de jogo · entrada de voz · apresentações feitas por IA · MCP · paralelismo multi-janela · ponte de extensão VSCode · Bot para Discord · 22 plugins · lixeira e rollback de backup · diagnóstico full-stack · multilíngue

**Curto prazo**: P1 autodirigido (puro algoritmo, zero LLM, atenção em nível de frase) · mais plataformas de Bot · ecossistema de plugins · TTS / texto-para-imagem · motor de jogo com IA (linhagem de era: código numérico determinístico + narração por LLM + renderização por símbolos) · modo streaming

---

## Stack Tecnológica

Runtime fount (Deno) · camada de compatibilidade Node.js no backend + roteamento Express · frontend vanilla JS (ESM) · busca inteligente BM25 + regex (JS puro, zero dependências) · mascote de desktop Electron · modelo local de transcrição de voz · discord.js v14 multiplataforma · armazenamento em JSON puro

---

## Comunidade

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Entrar_Agora-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Compartilhe cartões de personagem · publique presets · contribua com worldbooks · relate bugs · faça sugestões · contribua com código — seja bem-vindo(a) a bordo!

---

## Tecnologias e Recursos Utilizados

- **Transcrição de voz**: [MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize) (implantação local com diarização de locutores; modelo de ~1,8GB baixado automaticamente no primeiro uso)
- **Vetores de palavras**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Dados de associação**: [SWOW (Small World of Words)](https://smallworldofwords.org/), conjunto de dados de associação em chinês
- **Tokenização e léxicos**: corpus BCC / THUOCL / CoreNatureDictionary / Chinese-Synonyms e outros recursos públicos
- **Ponte de mecanismo de busca**: [ddgs](https://pypi.org/project/ddgs/) (camada de fingerprint TLS em Python, corrigindo o downgrade que mecanismos de busca aplicam a requisições fetch simples)

Referências teóricas (todas as 56 no [capítulo 1 do artigo](docs/p1-paper/en/01_introduction_related_work.md)): spreading activation (Collins & Loftus 1975) · priming (Meyer & Schvaneveldt 1971) · remote associates (Mednick 1962) · SWOW (De Deyne et al. 2019) · conceptual spaces (Gärdenfors 2000) · CombSUM (Fox & Shaw 1994) · BM25 (Robertson et al. 1995) · IDW (Shepard 1968) · Hough voting (Hough 1962) · RRF (Cormack et al. 2009)

## Agradecimentos

- **[fount](https://github.com/steve02081504/fount)** — o framework fundacional nos primeiros dias do projeto, fornecendo a referência inicial para I/O de mensagens de IA, gestão de fontes de serviço e carregamento de módulos. Desde então, o projeto evoluiu para uma arquitetura totalmente independente, mas o fount nos poupou um tempo enorme de desenvolvimento de baixo nível no início e ofereceu muitas ideias valiosas — pelas quais somos muito gratos
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — o pioneiro do roleplay com IA; seu formato de preset, especificação de cartão de personagem e sistema de worldbook se tornaram padrões da comunidade, e este projeto é totalmente compatível com o seu ecossistema
- **A comunidade de plugins do SillyTavern** — agradecemos a todos os autores de plugins open-source pela exploração e compartilhamento em motores de renderização e extensões de recursos

---

<details>
<summary><strong>📸 Mais capturas de tela (clique para expandir)</strong></summary>

| | | |
|---|---|---|
| ![Detalhe do PPT](imgs/screenshots/ppt-detail.png) **Fluxo completo de PPT** | ![Configurações de segurança](imgs/screenshots/security-settings.png) **Segurança e fluxo de tarefas** | ![Centro de segurança](imgs/screenshots/security-center.png) **Centro de segurança** |
| ![i18n](imgs/screenshots/i18n-support.png) **Multilíngue** | ![Temas CSS](imgs/screenshots/css-themes.png) **Temas** | ![wiki](imgs/screenshots/wiki-guide.png) **Wiki embutida** |
| ![Sub-modos](imgs/screenshots/sub-mode-agent.png) **Fluxos de sub-modo** | ![Menu](imgs/screenshots/hamburger-menu.png) **Visão geral do contexto** | ![loop](imgs/screenshots/auto-loop.png) **Loops automáticos/agendados** |
| ![Detecção de ferramentas](imgs/screenshots/tool-detection.png) **Detecção de ambiente** | ![Camadas de memória](imgs/screenshots/memory-data-layers.png) **Estrutura de arquivos de memória** | ![Extensão](imgs/screenshots/browser-automation.png) **Automação de navegador** |
| ![Interface externa](imgs/screenshots/external-interface.png) **Interfaces externas** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Bot para Discord** | |

</details>

---

## Links

- 📖 Wiki Online (guia do usuário + seção P1 + dados de experimentos): https://beilusaiying.github.io/always-accompany/
- 📄 Artigo Técnico do P1 (7 capítulos, zh + en): [docs/p1-paper](docs/p1-paper/README.md)
- 💬 Comunidade no Discord: https://discord.gg/agHeDq9bqU
