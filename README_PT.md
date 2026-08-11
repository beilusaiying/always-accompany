<p align="center">
  <img src="imgs/icon.jpg" alt="always-accompany" width="180">
</p>

<h1 align="center">always-accompany</h1>

<p align="center"><strong>Um projeto de IA + Agent multifacetado, focado em mecanismos de contexto e atenção</strong></p>

<p align="center">Companhia, conversa, programação e trabalho compartilham a mesma estrutura de memória e contexto — como aquelas IAs das obras de ficção científica, que te fazem companhia e também trabalham ao seu lado.</p>

<p align="center"><strong>Atenção dinâmica · Injeção fixa · Isolamento por projeto · Modos especializados</strong></p>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Entrar_na_comunidade-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Dar_uma_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README_CN.md">简体中文</a> · <a href="README_TW.md">繁體中文</a> · <a href="README_JA.md">日本語</a> · <a href="README_KO.md">한국어</a> · <a href="README_RU.md">Русский</a> · <a href="README_DE.md">Deutsch</a> · <a href="README_ES.md">Español</a> · <a href="README_FR.md">Français</a> · Português</p>

> [!NOTE]
> **Nota de desenvolvimento:** A maior parte deste projeto foi desenvolvida por uma única pessoa em cerca de três meses, seguida de aproximadamente um mês dedicado à otimização dos algoritmos. Devido ao curto ciclo de desenvolvimento e ao amplo escopo de funcionalidades, a estrutura do projeto, os recursos básicos e o tratamento de casos extremos ainda podem estar instáveis ou incompletos. Alguns recursos básicos foram implementados com auxílio de IA, enquanto o autor planejou e orientou pessoalmente os frameworks, algoritmos e principais decisões de design das funções complexas; por isso, a maturidade varia entre os módulos. A revisão manual, os ajustes finos e a otimização de engenharia continuarão. Se encontrar um bug, forneça as etapas de reprodução e os logs.
>
> **Próximos passos:** Novos plugins e áreas funcionais deixarão de ser adicionados. O trabalho se concentrará em reduzir o núcleo, diminuir o acoplamento e transferir gradualmente as funções separáveis para a camada de plugins. O projeto concluirá um protocolo de plugins detalhado e estável antes de iniciar a otimização de engenharia do framework e uma refatoração gradual. Testes, documentação e processos de contribuição também serão aprimorados para que mais desenvolvedores possam compreender, ampliar e participar do projeto.

---

## O que ele já faz de imediato?

- Conduzir conversas de longo prazo e roleplay, com importação direta de formatos da comunidade do SillyTavern, como fichas de personagem, predefinições e world books;
- Ler e modificar arquivos de projeto e executar comandos, como uma bancada de Agent local;
- Estender-se para além do navegador via Live2D / pet de desktop em imagem, percepção de tela, companhia em jogos, entrada de voz e um sistema de Bot que cobre 9 plataformas;
- Guardar material de longo prazo em arquivos locais, encontrar automaticamente a cada turno os trechos relevantes para a pergunta atual e deixar que o contexto antigo, já desnecessário, saia de cena;
- Editar personagens, o conteúdo e a ordem dos prompts, a identidade e a posição das injeções, as regras de disparo condicional, as rotas de recall de memória, as permissões e os plugins — transformando tudo isso na sua própria IA.

**O que temos?** Por trás dessas interfaces está o mesmo sistema; a diferença real se concentra em quatro coisas:

- **Memória e contexto em camadas** — Data + camadas hot / warm / cold guardam material de longo prazo, e uma ferramenta que coleta contexto e recupera memória (P1) traz de volta, antes de cada resposta, os trechos relevantes; a limpeza de contexto opera em nível de leitura de arquivo, é reversível, e a própria IA pode abandonar arquivos já lidos que não precisa mais;
- **O comportamento central pode ser inspecionado e configurado** — personagens, prompts, injeções, memória, rotas de recall, permissões e plugins têm pontos documentados de edição ou configuração;
- **Uma estrutura extensível baseada em plugins** — as funções centrais são organizadas como plugins, transmitidas por uma estação de informação intermediária, e o frontend cuida da exibição e da operação; os plugins de usuário podem ser escritos em JS, Python ou como programas independentes;
- **Uma cadeia integrada de ferramentas para agent** — fornece arquivos, comandos, integração com navegador, MCP, múltiplas janelas, aprovação e recuperação sob a mesma estrutura de memória e contexto; a disponibilidade e os resultados dependem do modo, da configuração, do ambiente, do modelo e dos serviços conectados.

---

## Início rápido

Você só precisa de duas coisas:

- Uma API de IA funcional;
- Saber escrever prompts simples.

Com essas duas, já dá para começar a experimentar na hora. Vale deixar claro: os prompts de AIRP e de Chat ainda estão em refinamento — no estágio atual o foco é a produtividade, e o polimento voltado para companhia virá aos poucos.

Se você só quer começar a conversar, esse é todo o custo. O serviço local de recuperação do P1 autônomo (com pico de memória medido atualmente na ordem de cerca de 2 GiB) pode ser desligado por inteiro; parâmetros do P1, posição de injeção de prompts, Code, Work e plugins são configurações para aprofundar sob demanda, e não um pré-requisito para o primeiro uso.

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# ou chmod +x run.sh && ./run.sh   # Linux / macOS
```

O launcher baixa automaticamente o runtime quando o Deno está ausente e conclui a instalação quando as dependências estão incompletas. Assim que a página fica pronta, o navegador costuma abrir sozinho; também é possível acessar manualmente `http://localhost:1314`.

| 1. Escolher o idioma da interface | 2. Vincular a fonte de serviço de IA |
|---|---|
| ![Escolher idioma](imgs/screenshots/onboarding-language.png) | ![Vincular API](imgs/screenshots/onboarding-api.png) |

Preencha o endereço do serviço, a API Key e o modelo; depois de salvar, escolha ou importe uma ficha de personagem e já dá para começar a conversar. É preciso ao menos uma API de IA funcional; a capacidade do modelo e o custo dependem do serviço que você vincular. O aplicativo traz um [Wiki](site/wiki/getting-started/overview.md) integrado, e também há uma [versão online](https://beilusaiying.github.io/always-accompany/).

> O primeiro arranque costuma demorar mais: o runtime precisa baixar dependências e inicializar os dados locais. Aguarde a página aparecer por completo antes de interagir; os arranques seguintes serão mais rápidos. Capacidades opcionais como voz e pet de desktop podem ter seus próprios downloads iniciais ou requisitos de ambiente.

---

## Panorama de recursos

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

**📊 Modo Work e PPT**
![Modo Work PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Pet de desktop Live2D + percepção de tela**
![Pet de desktop](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 Seis modelos de permissão + regras por ferramenta**
![Configurações de permissão](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Compressão em camadas × controle item a item**
![Mecanismo de compressão](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧭 Quatro modos principais + visões auxiliares**: Smart (totalmente inteligente), Chat (conversa / roleplay), Code (programação) e Work (trabalho) têm cada um sua própria tabela de memória e rota P1; há ainda visões auxiliares como gerenciamento de Bot, companhia em jogos, gerenciamento de memória e adaptação ao ST;
- **🧠 Data (tabela de memória estruturada e editável) + memória em três camadas**: Data e os arquivos JSON / MD comuns de `hot / warm / cold` recebem, respectivamente, os fatos atuais, o material recente e o arquivamento; o conteúdo pode ser consultado e editado;
- **🎯 P1 (recall antecipado de memória)**: antes de a IA principal responder, busca primeiro trechos relevantes no material de longo prazo permitido para o personagem e o modo atuais. Chat / Code / Work usam atualmente, por padrão, a rota de algoritmo local; os modos Smart / Bot mantêm uma rota de recuperação por IA independente; as duas rotas são mutuamente exclusivas e também podem ser desligadas;
- **🗜️ Gerenciamento de contexto**: visualize a ocupação por mensagem, leitura de arquivo, resultado de ferramenta e injeção de sistema; a limpeza comum apenas oculta o conteúdo e para de enviá-lo à IA, mas o registro permanece em disco e pode ser restaurado;
- **📊 Tabelas de memória por modo**: Chat tem as tabelas #0–#9, Code e Work usam suas próprias tabelas e diretórios privados, sem amontoar todos os cenários numa única tabela;
- **👑 As principais entradas de prompt são editáveis**: definições de personagem, predefinições, entradas INJ, instruções de modo, slots de dados de memória e guias de ferramentas oferecem os controles compatíveis com seu editor para conteúdo, ordem, ativação, papel, posição de injeção ou condições; os wrappers de segurança do framework e as transformações específicas do provedor continuam sob controle do código;
- **💻 Fluxo de trabalho em nível de IDE**: layout de três painéis, leitura e edição de arquivos, execução de comandos, lista de tarefas, múltiplas janelas e ponte de extensão para o VS Code;
- **🔌 MCP (protocolo de conexão de ferramentas externas)**: cole um JSON para conectar ferramentas externas; serviços do tipo comando passam por portões de segurança como o do owner e a lista de permissões de variáveis de ambiente;
- **🐾 Pet de desktop e companhia em jogos**: Live2D / pacote de imagens, três formas de percepção de tela, comentários espontâneos, laço independente de companhia em jogos e frequência adaptativa;
- **🎙️ Entrada de voz local**: transcrição local com MOSS-Transcribe-Diarize, com suporte a separação de locutores e marcação de tempo; por ora só faz voz-para-texto, sem leitura em voz alta pela IA;
- **🤖 Bot em 9 plataformas**: o código-fonte atual inclui os shells de Discord, Telegram, Slack, LINE, Feishu, DingTalk, WeChat, WeCom e da plataforma X; cada plataforma ainda exige configurar Token, Webhook ou ponte de terceiros conforme suas próprias exigências;
- **🔎 Recuperação vetorial semântica opcional**: traz o beilu-vectordb integrado (baseado em Orama, com suporte a busca por texto completo / vetorial / híbrida), desligado por padrão, ativável após configurar um endpoint de embedding próprio; complementa o P1 autônomo, em vez de ser uma escolha entre um ou outro;
- **🧩 Sistema de plugins**: o código-fonte atual tem 23 diretórios de plugins integrados, e o modelo para novos usuários lista 14 por padrão; ainda dá para escrever plugins de usuário em Python, Node ou como programas independentes;
- **🛡️ Dados locais e recuperação**: os dados do aplicativo ficam na máquina, com suporte a ocultar e restaurar, lixeira e cadeia de backup; o que é enviado a uma IA remota ou a um serviço de embedding remoto continua sujeito à política de dados do serviço que você escolher;
- **🌐 Multilíngue · 🔬 Diagnóstico caixa-branca · 🎨 Vários temas**: além das interfaces centrais em chinês / inglês / japonês / chinês tradicional, há outras traduções da comunidade, e alguns idiomas de baixos recursos podem estar incompletos.

---

## O que exatamente pretendemos resolver?

Guardar memória, em si, não tem nada de místico. Data é uma tabela onde se escreve; `hot / warm / cold`, no fundo, é você criar três pastas por "tempo + evento" e ir anotando md dentro delas; INJ (entradas editáveis de injeção de prompt) e as predefinições também dão continuidade ao modo de orquestrar prompts que frontends de personagem como o SillyTavern vêm explorando há muito tempo.

Combinar tudo isso com o P1 (uma ferramenta que coleta contexto e recupera memória) forma um fluxo configurável de "vetor + injeção dinâmica + memória que acompanha a tarefa atual"; a limpeza de contexto em nível de leitura de arquivo faz parte da mesma cadeia. Os resultados de recall e compressão dependem do modo, da configuração, do material e do modelo.

Na verdade, no começo pretendíamos fazer do P1 uma pequena IA implantada à parte. Mas o problema de verdade aparece depois de guardar: a memória vai acumulando cada vez mais — se a cada turno for preciso acionar uma segunda IA só para vasculhar, a velocidade e o custo ainda se sustentam? Será que a IA pequena consegue mesmo achar tudo? Será que é obrigatório usar uma IA paga? Quanto mais ela lembra, mais lenta fica?

No dia a dia, isso se traduz em algumas cenas familiares: num projeto grande, você pede que a IA veja primeiro as rotas, a estrutura e os MDs antes de dar a tarefa a ela, e no meio do caminho os tokens já estão quase no limite — uma compressão e é preciso reler tudo de novo; quando vários agents rodam juntos, o contexto vira um desastre; numa tarefa longa, a IA relê repetidamente o mesmo arquivo que só mudou em algumas linhas, o contexto vai empilhando até estourar, e você não consegue apagá-lo; às vezes você queria abrir um projeto novo, mas a IA ancora de cabeça na memória de um projeto antigo.

Nada disso é hipótese solta:

- [Issue #6](https://github.com/beilusaiying/always-accompany/issues/6)
- [Codex #35226](https://github.com/openai/codex/issues/35226) · [Claude Code #34556](https://github.com/anthropics/claude-code/issues/34556);
- [Discussão da comunidade](https://www.reddit.com/r/SillyTavernAI/comments/1q7p33c/how_longterm_memory_works_in_sillytavernai/);
- Usuários de produtos de chat na web também levantam a questão da transparência da memória de projeto e da interferência entre projetos: [pedido de transparência de recuperação](https://community.openai.com/t/feature-request-make-project-memory-transparent-searchable-and-user-controlled/1385159) · [pedido de memória por projeto](https://community.openai.com/t/project-specific-memory-in-chatgpt/1140856).

### Depois de guardar, como entregar à IA

Por meio do nosso próprio **recall antecipado de memória P1**: ele primeiro expande as pistas de busca em torno da conversa atual do usuário e depois encontra, no material de longo prazo permitido para o personagem e o modo atuais, o texto original relevante, entregando-o à IA principal. Dá para entendê-lo como um mecanismo de atenção dinâmica que roda fora do modelo — a pergunta atual decide o que buscar, o material de longo prazo oferece os candidatos, e só os trechos selecionados neste turno entram na resposta.

Na prática, isso significa: você não precisa repetir a frase original; uma frase relacionada, ainda que não idêntica, também pode trazer o assunto antigo de volta; e, depois do recall, a interface mostra quais memórias foram de fato usadas neste turno — o que você verifica é o registro em si, e não um simples "eu me lembro" da IA.

---

## Mecanismos detalhados

<details>
<summary><strong>🧠 Data e a memória recursiva em três camadas — por que ainda estratificar</strong></summary>

`hot / warm / cold` são, antes de tudo, diretórios de ciclo de vida legíveis e graváveis, não um banco de dados misterioso:

```text
🔥 hot  — material recente, de alta frequência, em uso agora
🌤️ warm — material de organização e arquivamento por etapas
❄️ cold — material histórico de mais longo prazo
📊 Data — fatos estruturados, editáveis e verificáveis no modo atual
```

A estratificação faz com que injeção fixa, recall sob demanda e arquivamento profundo tenham custos e finalidades distintos. O material bruto fica em JSON / MD comuns, que o usuário pode inspecionar e corrigir diretamente; o P1 então decide, a cada turno, de quais camadas trazer os trechos de volta.

A pesquisa sobre contexto longo já observou viés de posição e queda de aproveitamento quando a tarefa fica mais complexa: [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) · [RULER](https://arxiv.org/abs/2404.06654) · [Found in the Middle](https://aclanthology.org/2024.findings-acl.890/). Esses artigos mostram que "conseguir colocar dentro" e "conseguir usar de forma estável" não são a mesma coisa, mas não provam diretamente que a solução deste projeto seja melhor.

</details>

<details>
<summary><strong>🗜️ Gerenciamento de contexto — da compressão de blocos inteiros à limpeza em nível de leitura de arquivo</strong></summary>

Ao executar tarefas reais, a IA gera muito conteúdo de processo: arquivos relidos repetidamente, resultados antigos de ferramentas, tags de instrução já consumidas e mensagens obsoletas. always-accompany oferece ao mesmo tempo compressão automática, limpeza por tipo e seleção item a item; a limpeza padrão usa a marcação `_hidden`, deixando o registro em disco, mas parando de enviá-lo à IA.

A IA também pode emitir `<contextClean>` para solicitar limpeza; o sistema protege as palavras originais do usuário e permite definir um limiar mínimo de token, evitando quebrar o cache de prompt com frequência quando o contexto ainda é pequeno. Operações permanentes ou de alto risco não devem ser misturadas com a ocultação comum.

| Compressão multicamada e granularidade | Limpeza em nível de leitura de arquivo |
|---|---|
| ![Painel de compressão multicamada](imgs/screenshots/compression-multi.png) | ![Limpeza em nível de leitura de arquivo](imgs/screenshots/context-file-cleanup.png) |

O usuário comum só precisa escolher as leituras de arquivo ou mensagens que não precisa mais; quem quiser controle mais aprofundado pode então consultar a conta de tokens, o tipo, o tempo e a origem.

</details>

<details>
<summary><strong>🔬 P1 autônomo — a cadeia de atenção dinâmica de memória fora do modelo</strong></summary>

A cadeia de produção atual é Node0–4, e não a descrição de 21 nós da documentação antiga:

```text
Node0  entrada atual + mensagens recentes do usuário + Data do modo atual
  ↓
Node1  tokenização, classe gramatical, tempo, nomes próprios e âncoras de frase
  ↓
Node2  expansão associativa por SWOW / ConceptNet / Cilin / ATOMIC / léxicos de domínio, etc.
  ↓
Node3  filtragem por sinais de múltiplas evidências, como BLQ (algoritmo próprio) / NB300 / WordNet
  ↓
Node4  volta a Data, hot / warm / cold e aos registros do modo, com ranqueamento combinando BM25, tempo, camada, Top, importance, etc.
  ↓
recalledRecords + directionWords + trace
```

Palavras associadas não são fatos de memória; os candidatos precisam voltar à camada de registro real para se tornarem o resultado final de recall. O painel caixa-branca mostra as unidades de entrada, os candidatos de cada nó e o motivo de exclusão, o estado do índice, a origem final e os erros, facilitando distinguir se um "não teve recall" foi ausência de correspondência, degradação de recurso ou falha na cadeia.

![Teste caixa-branca do P1 autônomo](imgs/screenshots/p1-self-driven-diagnostics.png)

O painel caixa-branca prova que cada nó e cada origem real podem ser inspecionados; a qualidade do recall ainda precisa ser avaliada sobre o mesmo corpus, a mesma tarefa e dados com respostas de referência. Para os limites completos de execução, veja o [contrato de produção atual do P1](site/wiki/p1-recall/ch7-current-runtime.md).

</details>

<details>
<summary><strong>👑 As principais entradas de prompt são editáveis — utilizáveis por padrão e configuráveis para seu fluxo</strong></summary>

As principais entradas de prompt — definições de personagem, predefinições, entradas INJ, instruções de modo, slots de dados de memória e guias de ferramentas — podem ser editadas na interface. Cada entrada permite os ajustes realmente oferecidos por seu editor; os wrappers de segurança do framework e as transformações específicas do provedor continuam sob controle do código:

- o texto em si
- a ordem
- se está ativo
- se é enviado como identidade system, user ou assistant;
- em que posição do histórico de chat é inserido;
- se só vale em Chat, Code, Work, Bot ou sob condições específicas.

</details>

<details>
<summary><strong>🔒 A IA pode agir, mas cada tipo de operação tem seu próprio limite</strong></summary>

A escrita de arquivos recebe `deny / ask / allow` conforme a ferramenta, o caminho e regras de três estados; comandos ainda passam por lista negra, lista cinza e lista branca remota; sob implantação em server, configurações sensíveis e capacidades de subprocesso exigem que o owner as habilite.

L0–L5 é um conjunto de modelos rápidos que vão do controle estrito à liberação total, e o usuário ainda pode subdividir até ferramentas e caminhos específicos. L5 pula a aprovação, sendo uma escolha claramente de alto risco; a cerca do workspace, o modo de implantação e o portão de segurança próprio de cada plugin ainda devem ser compreendidos de forma independente.

![Subdivisão de permissões de edição da IA](imgs/screenshots/ai-permission-rules.png)

</details>

<details>
<summary><strong>🏗️ Arquitetura do sistema e limites de isolamento</strong></summary>

always-accompany roda com backend Deno e frontend Web nativo, organizando suas capacidades por meio de Shell, Plugin, Service Generator e a camada funcional yonban. Chamadas de interface, roteamento de modos, execução de arquivos / ferramentas, persistência e resultados assíncronos têm cada um pontos de entrada bem definidos.

| Limite | Função atual |
|---|---|
| Usuário | limite raiz de persistência em cenários multiusuário / server |
| Ficha de personagem | personagens, relações, clientes ou projetos diferentes usam raízes de memória, definições e conversas diferentes |
| Modo | Chat / Code / Work usam tabelas, diretórios privados, registros de predefinição e rotas P1 diferentes; o material de longo prazo comum da mesma ficha de personagem ainda pode ser compartilhado |
| Janela | restringe a entrada do turno, os candidatos e resultados do P1, o workspace e o retorno assíncrono |

</details>

<details>
<summary><strong>🔭 Sobre janelas de contexto de 1M, 2M e ainda maiores</strong></summary>

Janelas maiores são muito valiosas, mas capacidade, atenção, custo e estado da tarefa não são a mesma coisa. always-accompany faz estratificação e recall principalmente para elevar a atenção e otimizar a forma de armazenar dentro do contexto, sobretudo mirando os grandes projetos de código de hoje e as conversas de longo prazo.

Talvez você já tenha vivido isto: quanto mais longa a conversa e maior a memória, mais coisas a IA recebe, e sua reação e sua memória, em vez de melhorar, começam a se confundir e a ficar lentas; no código, é assim — mesmo com 1M de contexto, um projeto grande logo esbarra no limite.

</details>

---

## Roteiro

**Pontos de entrada e implementações que o repositório atual já possui**: Data + memória em três camadas · gerenciamento de contexto · P1 autônomo / P1 por IA · edição de entradas de prompt e troca de predefinições · tabelas de memória por modo · injeção dinâmica de conhecimento condicional · pet de desktop Live2D / em imagem · percepção de tela e companhia em jogos · entrada de voz local · geração de PPT · MCP · múltiplas janelas · ponte de extensão para o VS Code · Bot em 9 plataformas · 23 diretórios de plugins integrados · host de plugins de usuário · cadeia de lixeira / backup · diagnóstico caixa-branca · multilíngue e temas.

**Direções recentes**: mais plataformas de Bot · ecossistema e exemplos de plugins · TTS / texto-para-imagem · motor de jogo com IA (estado numérico determinístico + narrativa por LLM + renderização simbólica)

---

## Stack tecnológico

Runtime Deno (compatível com Node.js) · roteamento estilo Express · frontend em JavaScript nativo / ESM · WebSocket · armazenamento local em JSON / MD · pet de desktop Electron · serviços opcionais em Python (recursos do P1, STT, PPT) · discord.js v14 · ponte de extensão para o VS Code.

Para a descrição da arquitetura, veja [Arquitetura do sistema](site/wiki/developer/architecture.md); para as cadeias de mensagem, ferramentas e permissões, veja [Sistema de ferramentas YonBan](site/wiki/yonban/tools.md) e [Mecanismo de aprovação](site/wiki/yonban/approval.md).

---

## Comunidade

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Entrar_agora-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Compartilhe fichas de personagem · publique predefinições e conhecimento condicional · contribua com plugins · reporte bugs · proponha casos de uso reais · participe de benchmarks · contribua com código.

---

## Tecnologias e recursos utilizados

- **Transcrição de voz**: [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize) (implantação local, modelo de ~1,8 GB, baixado à parte no primeiro uso)
- **Vetores de palavras**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Dados de associação**: dados de associação em chinês do [SWOW (Small World of Words)](https://smallworldofwords.org/)
- **Tokenização e dicionários**: THUOCL, CoreNatureDictionary, Chinese-Synonyms e outros recursos públicos
- **Ponte de mecanismo de busca**: [ddgs](https://pypi.org/project/ddgs/) (usado para requisições de busca e obtenção de resultados)

## Agradecimentos

- **[fount](https://github.com/steve02081504/fount)** — o framework de referência nos primórdios do projeto, que ofereceu ideias de infraestrutura como processamento de mensagens de IA, gerenciamento de fontes de serviço e carregamento de módulos, poupando muito tempo de desenvolvimento de baixo nível;
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — um precursor importante do ecossistema de roleplay com IA e de prompts. always-accompany suporta a importação de seus formatos de comunidade, como fichas de personagem, predefinições e world books;
- **A comunidade de plugins do SillyTavern e todos os autores de recursos de código aberto** — obrigado pela exploração e pelo compartilhamento em renderização, personagens, extensões, recuperação e cadeia de ferramentas.

## Por que fazer este projeto

> O design, a arquitetura e o desenvolvimento deste projeto foram feitos por um desempregado enfurnado em casa em busca de emprego (é brincadeira, mais ou menos), com o apoio da programação assistida por IA, combinando design de algoritmos, ideias de biomimética, arquitetura de frameworks e raciocínio lógico.

always-accompany não foi feito para enfiar recursos da moda num mesmo menu — no começo era só o autor que queria usar :). Ele inclui um sistema de plugins e framework, além de vários idiomas de interface; a cobertura real varia conforme o plugin e os recursos de tradução disponíveis.

---

<details>
<summary><strong>📸 Mais capturas de tela de recursos (clique para expandir)</strong></summary>

| | | |
|---|---|---|
| ![Detalhe do PPT](imgs/screenshots/ppt-detail.png) **Fluxo completo de PPT** | ![Configurações de segurança](imgs/screenshots/security-settings.png) **Segurança e fluxo de tarefas** | ![Central de segurança](imgs/screenshots/security-center.png) **Central de proteção de segurança** |
| ![Multilíngue](imgs/screenshots/i18n-support.png) **Suporte multilíngue** | ![Temas CSS](imgs/screenshots/css-themes.png) **Vários temas** | ![Wiki](imgs/screenshots/wiki-guide.png) **Wiki integrado** |
| ![Submodo](imgs/screenshots/sub-mode-agent.png) **Fluxo de submodo** | ![Menu](imgs/screenshots/hamburger-menu.png) **Visão geral do contexto** | ![Loop](imgs/screenshots/auto-loop.png) **Loop automático / agendado** |
| ![Detecção de ferramentas](imgs/screenshots/tool-detection.png) **Detecção de ambiente** | ![Camadas de memória](imgs/screenshots/memory-data-layers.png) **Estrutura de arquivos de memória** | ![Extensão](imgs/screenshots/browser-automation.png) **Automação de navegador** |
| ![Interface externa](imgs/screenshots/external-interface.png) **Interface externa** | | |

</details>
