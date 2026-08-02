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

> Este projeto foi inteiramente projetado, arquitetado e desenvolvido de forma independente por um recém-formado universitário, com o apoio de programação assistida por IA, combinando habilidades em design de algoritmos, princípios de biomimética, arquitetura de frameworks e raciocínio lógico.

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# ou chmod +x run.sh && ./run.sh   # Linux/macOS
```

Abra o navegador em `http://localhost:1314` → configure uma fonte de serviço de IA → importe uma ficha de personagem → comece a conversar. O runtime Deno é baixado automaticamente na primeira inicialização, sem necessidade de instalação manual. É necessária pelo menos uma chave de API de IA. O aplicativo já vem com um wiki completo integrado.

> **Nota:** O primeiro arranque demora mais — o ambiente precisa descarregar dependências e inicializar a base de dados. Por favor, aguarde o carregamento completo da página antes de interagir. Os arranques seguintes serão muito mais rápidos.

---

Uma memória recursiva de três camadas (arquivamento dia → mês → ano, JSON puro, capacidade de 260 anos) + uma IA de recuperação antecipada (uma IA dedicada que só busca memórias relevantes e as repassa para a IA de resposta — cada uma cuida da sua própria tarefa) + limpeza de contexto em camadas (limpar significa apenas parar de reenviar aquilo; o texto original permanece e pode sempre ser restaurado). Essas três peças se encaixam para que a IA continue lembrando de cada palavra que você já disse, sem ficar limitada pela janela de contexto. Sobre essa base, construímos chat/roleplay, modo de programação IDE, modo de trabalho (incluindo apresentações de slides feitas por IA), um pet de desktop Live2D (percepção de tela + companhia em jogos), entrada de voz, um bot do Discord e integração de ferramentas externas via MCP — todos os pontos de entrada compartilham a mesma memória, então trocar de janela nunca faz a IA esquecer você. O motor de recall autônomo já está em produção (algoritmo puro, zero LLM, zero rede, em escala de milissegundos, filtragem em três camadas BLQ+NB300+WordNet).

---

## Visão geral dos recursos

<table>
<tr>
<td width="33%">

**💬 Chat / Roleplay**
![Interface de chat](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ Modo de programação IDE**
![Programação IDE](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Modo de trabalho (slides feitos por IA)**
![Modo de trabalho PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Pet de desktop Live2D + percepção de tela**
![Pet de desktop](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 Portão de permissões de seis níveis L0–L5**
![Configurações de permissão](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Compressão em camadas × controle linha a linha**
![Mecanismo de compressão](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 Memória em três camadas**: quente (injetada a cada turno) / morna (recuperada sob demanda) / fria (arquivo profundo), JSON puro + totalmente orientado por prompt, zero banco de dados
- **🎯 Recuperação antecipada P1**: uma pequena IA dedicada busca memórias primeiro e as repassa à IA de resposta, motor duplo BM25 + regex, a recuperação pode rodar em um modelo gratuito
- **🗜️ Sistema de compressão**: três níveis (um clique / por tipo / linha a linha) × quatro granularidades (mensagens de chat / leituras de arquivo / injeções de sistema / conteúdo de processo) + limpeza autônoma `<contextClean>` pela IA, tudo reversível
- **📊 10 tabelas de memória**: armazenamento estruturado, mantido automaticamente pela IA via `<tableEdit>`, garantindo isolamento de informação (o que o personagem não sabe simplesmente não está na tabela)
- **👑 Motor de prompts**: estrutura de mensagem em 5 segmentos + retomada de três rodadas pelo TweakPrompt, variáveis de macro + injeção dinâmica do world book (modos sempre ativo / regex / dinâmico)
- **💻 Fluxo de trabalho em nível de IDE**: layout de três painéis estilo VSCode, a IA lê e escreve arquivos diretamente, execução de comandos aprovada linha a linha
- **🔌 Ferramentas externas MCP**: cole um JSON para conectar; servidores do tipo comando ficam bloqueados por padrão até o dono aprovar, com lista de permissões de variáveis de ambiente para evitar vazamentos
- **🐾 Pet de desktop + companhia em jogos**: pet Live2D / pacote de imagens, três níveis de privacidade, captura de tela automática + fala espontânea + frequência adaptativa
- **🎙️ Entrada de voz**: transcrição por modelo local, separação de locutores + linha do tempo, o áudio nunca sai da máquina
- **🤖 Bot multiplataforma**: implantação no Discord, gerenciamento visual + log de mensagens em tempo real
- **🧩 22 plugins de recursos** + host de plugins em nível de usuário + compatibilidade de ecossistema (importação de fichas de personagem/predefinições/world books em múltiplos formatos)
- **🛡️ Todos os dados ficam locais**: exclusões vão para a lixeira e podem ser recuperadas, backup automático em múltiplas camadas + rollback via git
- **🌐 Multilíngue** (chinês/inglês/japonês/chinês tradicional) · **🔬 Diagnóstico full-stack** (logs de 12 módulos + empacotamento em um clique) · **🎨 Vários temas CSS**

---

## Mecanismos detalhados

<details>
<summary><strong>🧠 Memória recursiva de três camadas — por que estratificar</strong></summary>

Jogar todo o histórico em um único grande reservatório torna a busca lenta — e os dados experimentais confirmam isso ([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)): mesmo estando lá dentro, o modelo pode não enxergar de fato. Inspirados em como o hipocampo forma memórias e na curva de esquecimento de Ebbinghaus, dividimos a informação em três camadas por distância temporal:

```
🔥 Camada quente — auto-injetada a cada turno: perfil do usuário / memórias permanentes / tarefas pendentes / memórias recentes
🌤️ Camada morna — recuperada sob demanda (último mês): resumos diários / arquivos temporários / índice mensal
❄️ Camada fria — recuperação profunda (mais de um mês): resumos mensais / resumos diários históricos / índice anual
```

A camada quente custa apenas cerca de 7.000–11.000 tokens por turno (5–9% de uma janela de 128K). O decaimento da memória toma emprestada a curva de esquecimento de Ebbinghaus: `score = weight × (1 / (1 + days × 0.1))`. Totalmente orientado por prompt — mudar a estratégia de arquivamento, o significado das tabelas ou o estilo de recuperação basta editar o prompt, sem tocar no código.

</details>

<details>
<summary><strong>🎯 IA de recuperação antecipada P1 — por que dividir em duas IAs</strong></summary>

Se a IA de resposta tivesse que escolher sozinha os trechos relevantes entre centenas de entradas de histórico, ela estaria buscando e respondendo ao mesmo tempo, e sua atenção ficaria diluída entre as duas tarefas. Por isso, separamos "buscar memórias" em uma pequena IA dedicada:

```
Usuário envia uma mensagem → IA de recuperação P1 (< 5K tokens, focada apenas em buscar) → memórias selecionadas + conversa atual → IA de resposta (focada apenas em responder)
```

Filtragem grosseira por BM25 + correspondência exata por regex, atinge o alvo em no máximo 3 rodadas. A recuperação roda bem em um modelo leve gratuito, então o custo real por conversa equivale, na prática, a apenas uma chamada da IA de resposta. O P1 também cuida da troca automática de predefinições (com um cooldown de 5 turnos para evitar oscilação).

</details>

<details>
<summary><strong>🗜️ Gerenciamento de contexto — granularidade de compressão × níveis × limpeza autônoma pela IA</strong></summary>

Enquanto a IA trabalha, conteúdo de processo vai se acumulando sem parar (reler o mesmo arquivo, resultados de busca obsoletos, resultados antigos de ferramentas). Nossa limpeza sempre apenas oculta — tudo pode ser restaurado a qualquer momento.

**Limpeza autônoma pela IA**: o sistema fornece à IA sinais sobre seu próprio uso de contexto (50% sugerido / 70% aviso / 85% urgente), e a IA usa comandos `<contextClean>` para se enxugar de forma autônoma. Ela registra antes de limpar, então um erro ainda é reversível.

**Controle fino pelo usuário**: três níveis (limpeza completa em um clique / por tipo / seleção linha a linha) × quatro granularidades (mensagens de chat / cobrança de tokens por leitura de arquivo / cinco categorias marcáveis de injeções de sistema / conteúdo de processo enxugado automaticamente).

Taxa de acerto de cache medida (Opus + DeepSeek, incluindo troca de persona de IA + compressão autônoma): **75%–80%**.

![Painel de compressão](imgs/screenshots/compression-multi.png)

</details>

<details>
<summary><strong>🔬 P1 autônomo — um motor de recuperação zero-LLM já em produção</strong></summary>

A IA P1 precisa disparar uma requisição de API a cada turno — o que significa latência, custo e impossibilidade de uso offline. Construímos um pipeline totalmente algorítmico (21 nós, ~9.000 linhas) que alcança velocidade em escala de milissegundos, zero dependência de rede e atenção em nível de frase.

**Base de dados**: a [rede de associação chinesa SWOW](https://smallworldofwords.org/) / os [vetores de palavras de 300 dimensões do ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (~300 mil palavras) / o grafo de relações em chinês do ConceptNet / THUOCL e outros dicionários multi-fonte. O léxico foi montado por meio de busca na web feita por IA + 2 dias de autorrevisão, com custo de construção próximo de zero.

**Pipeline**: tokenização → divergência associativa SWOW (a difusão de sinônimos é proibida — habilitá-la reduz mensuravelmente a qualidade em 55–76%) → pontuação paralela em seis eixos (psicológico / informacional / social / lógico / linguístico / cognitivo) → localização em 47 subdireções → confirmação cruzada multi-recurso → ranking por votação espacial (IDW aditivo, não multiplicativo) → divergência secundária (5 caminhos independentes) → pontuação BLQ (referenciando a fusão aditiva CombSUM, com pesos de dimensão desenvolvidos internamente) → seleção da palavra-direção → injeção no contexto. Os 21 nós são todos puramente algorítmicos, zero LLM.

**Experimentos**: 27 iterações de versão; a pontuação de divergência foi de 2,01 para 4,05 entre v9 e v26 (+101%, de um total de 5, julgado palavra por palavra manualmente); taxa de recall ~90%; pontuação média geral ~3,5. A taxa de respostas genéricas caiu de 74% para 4%.

**Saída real** (registros brutos de um lote de teste com 200 casos):

| Entrada do usuário | Direção divergente do sistema | Disciplina alcançada |
| --- | --- | --- |
| "Não aguento mais, por que viver é tão difícil?" | Consciência do momento presente / consciência interoceptiva / **qual é a natureza do real** | Psicologia → **filosofia existencialista** |
| "Me preparando para entrevista em uma empresa unicórnio, como formular perguntas realmente profundas?" | Análise de causa raiz / **zona de desenvolvimento proximal** | Gestão → **psicologia educacional** |
| "Recuperar usuários perdidos em tráfego próprio com orçamento limitado" | **Ativação da rede de modo padrão** / **BDNF (fator neurotrófico derivado do cérebro)** | Marketing → **neurociência cognitiva** |
| "Consultas de banco de dados extremamente lentas, como otimizar" | Imutabilidade e atualizações de estado / **SRP (princípio da responsabilidade única)** | Operações → **metodologia de engenharia de software** |
| "Um espadachim que encontra um inimigo em uma montanha nevada" | **Arma de Tchekhov** / arquétipos junguianos | Ficção → **narratologia + psicologia analítica** |
| Poema original de um usuário, "Eu morri antes da luz chegar" | **Mundos possíveis e universos paralelos** | Poesia → **interpretação de muitos mundos na física** |

Critério de admissão no léxico: **qualquer palavra que o modelo principal já conseguiria inferir apenas lendo a entrada bruta é uma palavra inútil** — o valor do P1 está em dar ao modelo direções que ele não encontraria sozinho.

</details>

<details>
<summary><strong>👑 Motor de prompts + injeção dinâmica de world book</strong></summary>

**As três rodadas do TweakPrompt** assumem de forma unificada a saída de todos os módulos: Round 1 coleta → Round 2 reconstrói a estrutura de mensagem em 5 segmentos (beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) + substituição de macros → Round 3 snapshot.

**O world book tem 3 modos de ativação**: sempre ativo (injetado a cada turno) / regex (acionado por palavra-chave) / dinâmico (acionado ao ler condições numéricas das tabelas de memória — por ex., afeição > 80 desbloqueia um diálogo especial, ou o progresso da missão chegando ao capítulo 3 troca a descrição do universo).

**Sistema de macros**: `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + macros personalizadas.

</details>

<details>
<summary><strong>🏗️ Arquitetura do sistema</strong></summary>

Três camadas: **camada funcional** (memória / compressão / recall / predefinições / world book / rede / operações de arquivo… uma única cópia global) → **camada de transporte** (cada janela puxa sua própria linha, isolada por id, naturalmente assíncrona e não bloqueante) → **camada de interface** (web / bot / pet de desktop / extensão VSCode — troque de interface sem perder nenhuma capacidade).

Isolamento de dados: nível de usuário (fontes de IA / configurações globais) / nível de ficha de personagem (memória / chat / world book / regex) / nível de conversa (histórico de chat / modo / submodo).

Os 22 plugins crescem todos sob uma especificação unificada, o MCP conecta ferramentas externas, e o host de plugins em nível de usuário monta programas Python/Node — as extensões nunca tocam no código do núcleo.

</details>

<details>
<summary><strong>🔭 Sobre a era das janelas de contexto gigantes</strong></summary>

Mesmo que as janelas de contexto se expandam para 10M+ tokens, ainda mantemos a memória em camadas: ① há evidência experimental sólida de que a utilização do contexto decai à medida que o comprimento aumenta; ② ~10K tokens de memória selecionada carregam a informação de 100K+ tokens de histórico bruto, a um custo uma ordem de grandeza menor; ③ tabelas estruturadas são mais fáceis de ler e escrever com precisão por uma IA do que informação espalhada em uma conversa.

</details>

---

## Roteiro

**Concluído**: memória em três camadas · sistema de compressão · recuperação P1 · P1 autônomo (algoritmo puro, zero LLM, atenção em nível de frase) · motor de prompts · troca automática de predefinições · tabelas de memória · injeção dinâmica de world book · pet de desktop Live2D · companhia em jogos · entrada de voz · slides feitos por IA · MCP · paralelismo multi-janela · ponte de extensão VSCode · Discord Bot · 22 plugins · lixeira e rollback de backup · diagnóstico full-stack · multilíngue

**Planos de curto prazo**: mais plataformas de bot · ecossistema de plugins · TTS / texto-para-imagem · motor de jogo com IA (na linhagem de jogos "era" — código determinístico para estado numérico + narrativa por LLM + renderização simbólica) · modo de transmissão ao vivo

---

## Stack tecnológico

Runtime fount (Deno) · Camada de compatibilidade Node.js no backend + roteamento estilo Express · Frontend em JS nativo (ESM) · Recuperação inteligente BM25 + regex (JS puro, zero dependências) · Pet de desktop Electron · Modelo de transcrição de voz local · discord.js v14 multiplataforma · Armazenamento em JSON puro

---

## Comunidade

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Entrar_agora-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Compartilhe fichas de personagem · publique predefinições · contribua com world books · relate bugs · sugira ideias · contribua com código — todos são bem-vindos!

---

## Tecnologias e recursos utilizados

- **Transcrição de voz**: [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize) (implantação local com separação de locutores; o modelo, ~1,8GB, é baixado automaticamente no primeiro uso)
- **Vetores de palavras**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Dados de associação**: o conjunto de dados de associação em chinês [SWOW (Small World of Words)](https://smallworldofwords.org/)
- **Tokenização e dicionários**: THUOCL / CoreNatureDictionary / Chinese-Synonyms e outros recursos públicos
- **Ponte de mecanismo de busca**: [ddgs](https://pypi.org/project/ddgs/) (uma camada de fingerprint TLS em Python que resolve o problema de requisições fetch cruas sendo rebaixadas por mecanismos de busca)

## Agradecimentos

- **[fount](https://github.com/steve02081504/fount)** — o framework de referência inicial nos primeiros dias deste projeto, fornecendo infraestrutura central como manuseio de mensagens de IA, gerenciamento de fontes de serviço e carregamento de módulos. O projeto desde então evoluiu para uma arquitetura totalmente independente, mas o fount nos poupou muito tempo de desenvolvimento de baixo nível no início e nos deu muitas ideias valiosas para nos inspirarmos — nosso sincero agradecimento por isso
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — o projeto pioneiro em roleplay com IA; seu formato de predefinições, especificação de ficha de personagem e sistema de world book se tornaram padrões da comunidade, e este projeto é totalmente compatível com seu ecossistema
- **Comunidade de plugins do SillyTavern** — obrigado a todos os autores de plugins de código aberto por sua exploração e compartilhamento em torno de motores de renderização, extensões de recursos e mais

---

<details>
<summary><strong>📸 Mais capturas de tela de recursos (clique para expandir)</strong></summary>

| | | |
|---|---|---|
| ![Detalhe do PPT](imgs/screenshots/ppt-detail.png) **Fluxo completo de PPT** | ![Configurações de segurança](imgs/screenshots/security-settings.png) **Segurança e fluxo de tarefas** | ![Central de segurança](imgs/screenshots/security-center.png) **Central de proteção de segurança** |
| ![Multilíngue](imgs/screenshots/i18n-support.png) **Suporte multilíngue** | ![Temas CSS](imgs/screenshots/css-themes.png) **Vários temas** | ![wiki](imgs/screenshots/wiki-guide.png) **Wiki integrado** |
| ![Submodo](imgs/screenshots/sub-mode-agent.png) **Fluxo de submodo** | ![Menu](imgs/screenshots/hamburger-menu.png) **Visão geral do contexto** | ![loop](imgs/screenshots/auto-loop.png) **Loop automático/agendado** |
| ![Detecção de ferramentas](imgs/screenshots/tool-detection.png) **Detecção de ambiente** | ![Camadas de memória](imgs/screenshots/memory-data-layers.png) **Estrutura de arquivos de memória** | ![Extensão](imgs/screenshots/browser-automation.png) **Automação de navegador** |
| ![Interface externa](imgs/screenshots/external-interface.png) **Interface externa** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord Bot** | |

</details>
