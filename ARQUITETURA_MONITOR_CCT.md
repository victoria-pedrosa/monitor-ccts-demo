# Monitor de Instrumentos Coletivos — Arquitetura Técnica

**Exemplo | Time de IA | v2 — 13/08/2026**
Escopo: 54 entidades da base + MTE · 64 fontes mapeadas e testadas por HTTP real

> v2 substitui a versão anterior, que propunha Google Cloud Run. GCP é bloqueado no Workspace da Exemplo e a empresa não usa GitHub. A solução roda inteira em Google Apps Script.

---

## 1. Achado que definiu o desenho

Não é preciso raspar 55 sites de sindicatos laborais. **9 fontes patronais agregadoras** concentram a maior parte dos documentos, em PDF direto:

| Fonte | Cobre | Classe |
|---|---|---|
| SINDHOSBA `/convencoes-e-pautas/` | SINDSAUDE, SEEB, SINDIMAGEM, SASB, SINDIFARMA, SINDNUT | A |
| SINDUSCON-BA `/convencoes/` | SINTRACOM, SINDTICCC, SITICCAN, SINTRACAP, SINTICESB, SITTICOM | A |
| FECOMERCIO-BA `/convencoes-coletivas/` | comércio e serviços BA | A |
| FECOMERCIÁRIO-BA `/convecoes-coletivas/` | federação laboral do comércio BA | A |
| SINDILOJAS-BA (endpoint AJAX) | 96 PDFs de lojistas por cidade numa requisição | A |
| SECOVI-BA `/convencoes-coletivas` | SINDECOND, SERCONSCECS, FETTHEBASA e mais 6 | A |
| SEAC-BA (Joomla/Phoca) | SINTRAL/SIEMACO, SINDILIMP, SINDIBOMBEIROS e mais | A |
| SINEPE-BA `/Escolas` | SINPRO-BA + SAAEBA | A |
| SHRBS Salvador | hotelaria, bares e restaurantes (já com aditivo 2026) | A |

### O caso Sindisaúde

O SINDSAUDE **não publica CCT no próprio site** — só notícias e minutas. Quem publica é o SINDHOSBA, com o nome `SINDISAUDE-2026.pdf` (grafia diferente da sigla usada internamente). Um monitor apontado para o site laboral teria falhado de novo. Arquivo confirmado, 4,1 MB:
`https://sindhosba.org.br/wp-content/uploads/2026/05/SINDISAUDE-2026.pdf`

---

## 2. Arquitetura

```
        ┌────────────────────────────────────────────┐
        │  GOOGLE SHEETS — base mestre               │
        │  01_SINDICATOS · 02_FONTES · 09_ESTADO     │
        │  Sindicato novo = linha nova. Sem deploy.  │
        └───────────────────┬────────────────────────┘
                            │ lida a cada rodada
        ┌───────────────────▼────────────────────────┐
        │  GOOGLE APPS SCRIPT                        │
        │  gatilho por tempo, 1x/hora                │
        │                                            │
        │  20_Coletor  UrlFetchApp + SHA-256         │
        │              mudou o hash?                 │
        └───────────────────┬────────────────────────┘
                            │ só quando mudou
        ┌───────────────────▼────────────┐
        │  30_IA — GEMINI                │  PDF → JSON estruturado
        │  é instrumento coletivo?       │
        └───────────────────┬────────────┘
                            │ sim
        ┌───────────────────▼────────────┐
        │  30_IA — CLAUDE (auditor)      │  VALIDAR / NÃO ALERTAR / ESCALAR
        └───────────────────┬────────────┘
                            │
        ┌───────────────────▼────────────┐
        │  60_MTE — cruzamento           │  🟢 🟡 🔵 🔴
        └───────────────────┬────────────┘
                            │
     ┌──────────────────────▼──────────────────────┐
     │ 40_Slack #cct-alertas + botões de validação │
     │ Drive (PDF original) + Sheets (log)         │
     └─────────────────────────────────────────────┘
```

### Stack e custo

| Etapa | Tecnologia | Custo |
|---|---|---|
| Coleta, agendamento, hash | Apps Script (`UrlFetchApp`, `Utilities.computeDigest`) | R$ 0 |
| Banco de dados | Google Sheets | R$ 0 |
| Armazenamento dos PDFs | Drive Compartilhado | R$ 0 |
| Classificação | API Gemini via `UrlFetchApp` | camada gratuita |
| Auditoria | API Claude (só P1) ou 2ª passada no Gemini | R$ 0 a ~25/mês |
| Alerta e botões | Slack Incoming Webhook + Web App (`doPost`) | R$ 0 |
| Aviso de falha | MailApp | R$ 0 |

### Independência operacional

- Projeto no **Drive Compartilhado `Servidor IA > 2. Automações > Monitor CCTs`** — não pertence a conta pessoal nenhuma
- Versionamento: histórico nativo do Apps Script (a empresa não usa GitHub)
- Credenciais em Propriedades do Script, nunca no código
- Reinício: função `reiniciar()`, acessível a qualquer pessoa com acesso ao Drive
- Situação atual: função `status()`
- Runbook de 1 página na mesma pasta

---

## 3. Lógica de detecção

Comparar só a URL é insuficiente: SINDHOSBA e SINDHOSPES substituem o PDF mantendo o nome quando sai a versão assinada. A chave é composta — URL, nome, `last-modified`, tamanho e **SHA-256 do binário**, que é o critério decisivo.

Regras que vieram de casos reais encontrados na varredura:

| Regra | Motivo |
|---|---|
| Validar `content-type`, nunca só o HTTP 200 | SINDUSCON-BA e SINTRACOM devolvem 404 com o corpo completo do site (soft-404) |
| Rejeitar resposta cujo host final saia do domínio esperado | `seeb.org.br/convencoes/` está comprometida e redireciona para site de spam |
| Allowlist de domínio + conferir a UF dentro do PDF | `sindicarga.org.br` é RJ, `sindimagem.org.br` é GO, `sindhobar.com.br` é DF, `sindimont.org.br` é PR |
| "Página existe e está vazia" é estado próprio, não erro | SINTRAPAN publicou `/convencoes/` sem documento — geraria falso negativo permanente |
| Nunca usar SESCAP-BA como sinal de "sem novidade" | Títulos são `<span>` sem link e a página está congelada desde 25/09/2020 |
| Converter link do Drive para download | SEEB entrega `drive.google.com/file/d/<id>/view`, que devolve HTML |
| Versionar por hash quando o nome é aleatório | SINFITO e SINDECOBE usam hash no nome do arquivo |
| Detectar por ID sequencial, sem parsear HTML | SEAC-BA (`?download=<ID>`), SIMMEB (`/documents/<id>/`), FETIM-BA (API) |
| Tolerar TLS quebrado em fonte específica | SINDECOND tem cadeia de certificado inválida |

Implementação: `20_Coletor.gs`, funções `hostPermitido_()`, `extrairDocumentos_()` e `verificarFonte_()`.

---

## 4. Prompts

Os prompts de produção estão em `30_IA.gs` — fonte única, para não divergirem desta documentação.

**Gemini (classificador).** Recebe o PDF e o cadastro da entidade. Saída estruturada obrigatória via `responseSchema`, temperatura 0. Campo não encontrado = `null`, nunca inventar. Minuta, pauta e comunicado não são instrumento coletivo. Confiança abaixo de 0,80 quando o documento estiver ilegível ou for minuta.

**Claude (auditor).** Recebe o PDF, a saída do Gemini e o histórico da entidade. Decide entre `VALIDAR_ALERTA`, `NAO_ALERTAR` e `ESCALAR_HUMANO`.

Critério assimétrico obrigatório: **deixar passar uma CCT real é muito pior do que gerar alerta desnecessário.** Na dúvida entre não alertar e escalar, escala. Se o auditor estiver indisponível, o alerta sobe assim mesmo.

---

## 5. Cruzamento com o MTE

URL no ar em 13/08/2026 (a antiga `www3.mte.gov.br` está fora do ar):
`https://mediador.trabalho.gov.br/sistemas/mediador/ConsultarInstColetivo`

Busca é POST AJAX em `/getConsultaAvancada`, protegida por reCAPTCHA v3 invisível e Cloudflare. Não existe API oficial nem dataset aberto. Especificação completa — endpoints, campos do formulário, payload e link estável por documento — está em `60_MTE.gs`.

**A automação da consulta será desenvolvida internamente pela Exemplo.** Enquanto `CFG.MTE_AUTOMATICO` for `false`, o monitor roda completo e o alerta leva o link de conferência manual. Para ligar depois, basta implementar `consultarMediador_()` e virar a flag — nada mais no projeto muda.

| Situação | Status |
|---|---|
| Publicado no sindicato e registrado no MTE | 🟢 CONFIRMADA |
| Publicado no sindicato, sem registro ainda | 🟡 AGUARDANDO REGISTRO |
| Registrado no MTE sem publicação no site | 🔵 SÓ NO MTE |
| Dados divergentes | 🔴 DIVERGENTE — escalar |

O Mediador é a **única via** para 11 entidades sem site: SINDMOTO-BA, FETTHEBASA, SERCONSCECS, SINDILIVRE, SINDELIVRE-BA, SINPEF-BA, SERTEB, ALFAIATES-BA, SINDIMONT-SE, SINTICOMTI-MA e SIRCEB.

---

## 6. Frequência

| Prioridade | Frequência |
|---|---|
| P1 | toda rodada (1x/hora) |
| P2 | 1x/dia, de manhã |
| P3 | terças e sextas |
| MTE | diário, quando a consulta estiver automatizada |

**Janela de data-base:** nos 60 dias que antecedem a data-base, P2 e P3 sobem para P1. A base concentra data-base em janeiro, março e maio; fora da janela o sindicato quase nunca publica, dentro dela publica de uma hora para outra. Implementado em `dentroDaJanelaDataBase_()`.

---

## 7. Execução em Scrum (sprints de 4 semanas)

### Sprint 1 — Fundação e prova contra caso real
- Corrigir as 18 divergências da base e preencher o nº de clientes por entidade
- Rodar `testarTodasAsFontes()` — spike que confirma se os sites respondem ao Apps Script
- Crawler das 9 agregadoras + detecção por hash + PDFs no Drive
- Gemini classificando, Claude auditando, alerta no Slack, fila de validação
- **Teste retroativo** (`testeRetroativo()`): rodar contra as CCTs de 2026 que a base registra como publicadas
- **DoD:** 0 falso negativo nas entidades P1, incluindo Sindisaúde

### Sprint 2 — MTE e fontes difíceis
- Consulta ao Mediador (desenvolvimento interno) e cruzamento
- Fontes classe B: SINFITO, SEEB, SECOVI, SINDECOBE, FENAC
- Levantar CNPJ das 11 entidades sem site

### Sprint 3 — Comparação e integração
- Diff automático "o que mudou nesta CCT", cláusula a cláusula
- Vínculo sindicato → clientes impactados → responsável
- Painel de status por entidade

### Sprint 4 — Confiabilidade
- Métricas de falso positivo e negativo a partir da fila de validação
- Ajuste das regras nos casos em que Gemini e Claude divergiram
- Redução da validação humana obrigatória, mantendo P1

### Critério de aceite

> Monitor em produção cobrindo 100% das entidades P1 + MTE, com detecção automática de instrumento coletivo novo, extração dos metadados principais, armazenamento do documento original e alerta ao time. Todos os alertas passam por validação humana na fase inicial. O monitor é considerado confiável após validação contra o conjunto de casos reais de 2026, **incluindo o Sindisaúde**, com **meta de falso negativo = 0 nas entidades P1** e sem perda de publicação relevante durante um ciclo completo de data-base.

---

## 8. Riscos

| Risco | Mitigação |
|---|---|
| Sites bloquearem a faixa de IP do Google | Spike no dia 1. Plano B: Cloudflare Workers para as fontes afetadas |
| reCAPTCHA/Cloudflare no Mediador | Fica manual até a solução interna ficar pronta; o monitor dos sindicatos funciona sozinho |
| Site muda de plataforma e quebra o parser | 3 sites migraram para Next.js em 2026. Fonte quebrada dispara e-mail e é tratada como incidente |
| CCT atrás de formulário ou login | Confirmado em 6 fontes: SINTEPAV, SINTRACON-SP, SINSTAL, SINAENCO, SINDVEST, SINDSUPER. Verificação manual agendada + Mediador |
| Sindicato publica primeiro no Instagram | SINPEF, SINDIMONT-SE e ALFAIATES dependem de rede social — verificação manual na janela da data-base |
| Categoria errada no cadastro (SINTRAPET) | Risco de aplicar CCT de pet shop em cliente de posto. **Validar antes de codificar** |
| Execução estourar 6 minutos | Cursor de retomada + `MAX_DOCUMENTOS_POR_EXECUCAO` |

---

## 9. Pendências com a Exemplo

1. Preencher o **nº de clientes por entidade** (coluna L da aba `01_SINDICATOS`) — fecha a classificação P1/P2/P3
2. Confirmar se **SINTRAPET** é pet shop ou posto de combustível (SINPOSBA)
3. Definir quem valida cada grupo de alertas (Fiscal, DP, GRTS)
4. Gerar as chaves de API do Gemini e do Claude
5. Criar o Incoming Webhook do canal `#cct-alertas`

**Resolvido em 13/08/2026:** SINTESI é o sindicato da saúde de Itabuna e Região; as duas linhas do SINDTICCC são CCTs distintas (área de construção e área industrial).
