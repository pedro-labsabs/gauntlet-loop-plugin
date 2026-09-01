# Exemplo de uso do Gauntlet Loop no DSH

## Exemplo de cordis.yml (profile bundle)

Adicione esta linha no `cordis.patch.yml` do seu profile DSH:

```yaml
- id: tool-gauntlet
  name: gauntlet-loop-plugin
```

## Fluxo de uso com o tool `gauntlet_loop`

O lead agent (o modelo) conduz o loop chamando o tool. Exemplo:

### 1. Submit — comando cru

```json
{
  "action": "submit",
  "command": "Crie uma landing page para minha marca de corrida, tema escuro e verde, que pareça viva."
}
```

### 2. Refine — ant-subjetividade + barra

O lead agent detecta `viva`/`alive` como termo subjetivo e propõe:

```json
{
  "action": "refine",
  "refinedCommand": "Crie uma landing page para uma marca de corrida, tema escuro (#0a0a0a) com acentos verdes (#00ff88), que transmita energia e movimento.",
  "bar": {
    "name": "Nike Run Club landing page",
    "fetchHow": "https://www.nike.com/run-club screenshot desktop e mobile",
    "compareHow": "Screenshots lado a lado sem rótulos — o crítico vê ambos e escolhe qual transmite mais energia esportiva",
    "description": "Landing page oficial da Nike Run Club, referência em design esportivo escuro com acentos vivos"
  },
  "subjectiveResolved": [
    {
      "term": "viva",
      "objectiveDefinition": "Uso de gradientes dinâmicos, imagens em movimento/parallax, tipografia ousada e contraste entre fundo escuro e elementos verdes neon",
      "measuredBy": "Comparação cega por screenshots contra a barra (Nike Run Club)"
    }
  ]
}
```

### 3. Split — divisão em peças

```json
{
  "action": "split",
  "pieces": [
    { "id": "hero", "title": "Seção Hero", "description": "Título grande, subtítulo, CTA, imagem de fundo dinâmica" },
    { "id": "features", "title": "Seção de Benefícios", "description": "Grid 3x2 com ícones e descrições" },
    { "id": "testimonials", "title": "Depoimentos", "description": "Carrossel de depoimentos com fotos" },
    { "id": "cta", "title": "Call-to-Action Final", "description": "Seção de inscrição com formulário" }
  ]
}
```

### 4. Build + Critique (loop por peça)

Para cada peça, o lead agent spawna um builder sub-agent via `tool subagent`, depois chama `build`:

```json
{
  "action": "build",
  "pieceIndex": 0,
  "builderSubagentId": "sub-abc123",
  "artifact": {
    "location": "/path/to/hero.html",
    "summary": "Hero section com gradiente escuro, texto branco, CTA verde neon, imagem de fundo com corredor em movimento"
  }
}
```

Depois spawna um critic sub-agent com contexto fresco, que chama `critique`:

```json
{
  "action": "critique",
  "pieceIndex": 0,
  "criticSubagentId": "sub-def456",
  "verdict": {
    "winner": "bar",
    "notes": "A barra (Nike) tem um gradiente mais suave e tipografia mais ousada. O contraste do CTA é melhor na barra."
  }
}
```

Se `"bar"` → o lead agent ajusta e rebuilda. Se `"ours"` → avança para a próxima peça.

### 5. Complete

```json
{
  "action": "complete",
  "summary": {
    "outcome": "Landing page completa com 4 seções, todas venceram a comparação cega contra a Nike Run Club.",
    "lessons": "O gradiente escuro-verde precisou de 3 iterações no hero para igualar a referência. A seção de depoimentos venceu de primeira."
  }
}
```

## Dicas importantes

- **Barra vaga quebra o loop**: o crítico inventa uma comparação e aprova tudo. Sempre exija `name`, `fetchHow` e `compareHow` concretos
- **Builder ≠ Critic**: o crítico precisa de contexto fresco e não pode saber o esforço do builder
- **Sem rounds fixos**: o loop só termina quando o crítico escolhe `"ours"`. Se o lead agent definir um número máximo de tentativas, o gauntlet perde seu propósito
- **Termos subjetivos**: `bonito`, `moderno`, `premium`, `user-friendly`, `rápido`, `intuitivo`, `eficiente`, `robusto`, `escalável`, `clean`, `fluido`, `polished`, `elegante` — todos esses precisam de definição objetiva