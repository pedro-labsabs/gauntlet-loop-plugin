# Gauntlet Loop Plugin para DSH

Plugin oficial do **Gauntlet Loop** (técnica de [Matt Shumer](https://github.com/mshumer)) para o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Um **lead agent** divide um projeto em partes pequenas e usa **sub-agents críticos separados** para testar o trabalho contra um benchmark de qualidade rigoroso, em loop contínuo.

## Funcionalidades

| Funcionalidade | Descrição |
|---|---|
| 🚫 **Anti-subjetividade** | A fase `refine` detecta ~60 termos subjetivos (`premium`, `bonito`, `moderno`, `user-friendly`, etc.) e **rejeita** o comando até que cada um receba definição objetiva + mensurável |
| 🎯 **Barra de qualidade real** | Exige `name` (nome específico), `fetchHow` (como o crítico acessa a barra), `compareHow` (como a comparação cega é feita) — nunca uma rubric vaga |
| 📦 **Divisão em peças** | O lead agent divide o trabalho em partes pequenas e independentes |
| 👷 **Builder sub-agent separado** | Cada peça é construída por um sub-agent dedicado |
| 🔍 **Critic sub-agent cego** | Crítico em contexto **fresco** que abre o artefato + a barra, compara **sem rótulos** (`blind`), e devolve veredito binário (`"ours"` ou `"bar"`) |
| 🔄 **Loop até vencer** | Se o crítico escolher a barra → **rebuild obrigatório**. Nunca rounds fixos. O loop só termina quando o trabalho do builder vence a comparação cega |
| 📝 **Rastreamento de sub-agents** | Cada round registra o `builderSubagentId` e `criticSubagentId` para auditoria |

## Como o fluxo funciona

1. **`submit`** — você dá o comando cru
2. **`refine`** — o lead agent propõe um comando refinado + uma barra real. Termos subjetivos são detectados e exigem resolução objetiva. Barra vaga é rejeitada
3. **`split`** — o trabalho é dividido em peças pequenas
4. **`build`** — para cada peça, o lead agent spawna um **builder sub-agent** (tool `subagent`) que produz o artefato
5. **`critique`** — o lead agent spawna um **critic sub-agent** em contexto fresco, que abre o artefato e a barra, compara cegamente, e devolve `"ours"` (nosso é melhor) ou `"bar"` (a barra é melhor)
6. Se `"bar"` → volta ao passo 4 (rebuild). Se `"ours"` → próxima peça
7. **`complete`** — todas as peças venceram, resumo final

## Instalação no DSH

### Método 1: Instalação global (recomendado)

```bash
# Na raiz do seu checkout do DSH
cd /caminho/para/deepseek-harness
pnpm add ./caminho/para/gauntlet-loop-plugin
```

### Método 2: Como bundle no profile

Adicione no `cordis.patch.yml` do seu profile:

```yaml
- id: tool-gauntlet
  name: '@deepseek-ai/dsh-tool-gauntlet'
```

E adicione `@deepseek-ai/dsh-tool-gauntlet` como dependência no `package.json` do seu profile.

### Método 3: Como plugin dinâmico (sessão única)

Use o tool `cordis_define` para criar um plugin temporário com o código-fonte deste pacote.

## Pré-requisitos

- DeepSeek Harness (DSH) instalado e rodando
- Pacotes `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-session`, `@deepseek-ai/cordis`

## Parâmetros do tool `gauntlet_loop`

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `action` | string | ✅ | `submit`, `refine`, `split`, `build`, `critique`, `complete`, `status`, `reset` |
| `command` | string | no submit | Comando cru do usuário |
| `refinedCommand` | string | no refine | Comando refinado |
| `bar` | json | no refine | `{name, fetchHow, compareHow, description}` |
| `subjectiveResolved` | json | no refine | `[{term, objectiveDefinition, measuredBy}]` |
| `pieces` | json | no split | `[{id, title, description}]` |
| `pieceIndex` | integer | no build/critique | Índice 0-based da peça |
| `builderSubagentId` | string | no build | ID do sub-agent builder |
| `artifact` | json | no build | `{location, summary}` |
| `criticSubagentId` | string | no critique | ID do sub-agent critic |
| `verdict` | json | no critique | `{winner: "ours"|"bar", notes}` |
| `summary` | json | no complete | `{outcome, lessons}` |

## Créditos

- **Técnica Gauntlet Loop**: [Matt Shumer](https://github.com/mshumer) — [Claude of Duty](https://github.com/mshumer/Claude-of-Duty)
- **Skill original**: [RoboNuggets/gauntlet-loop](https://github.com/robonuggets/gauntlet-loop)
- **Plugin DSH**: [RenyEnnos](https://github.com/RenyEnnos)

## Licença

MIT