# Monitor de CCTs — Runbook

**Exemplo | Time de IA**
Tudo roda dentro do Google Workspace. Sem Google Cloud, sem GitHub, sem servidor externo, sem nada instalado em computador de ninguém.

---

## Onde as coisas ficam

| O quê | Onde |
|---|---|
| Código | Apps Script vinculado à planilha, em **Drive Compartilhado** da Exemplo |
| Base de sindicatos e sites | Planilha `MONITOR_CCT_BASE_EXEMPLO`, abas `01_SINDICATOS` e `02_FONTES` |
| Memória do robô (hashes) | Aba `09_ESTADO` da mesma planilha |
| PDFs baixados | Pasta do Drive Compartilhado definida em `PASTA_DRIVE_ID` |
| Alertas | Canal `#cct-alertas` no Slack |
| Senhas e chaves | Propriedades do Script — nunca no código |

> **Regra:** o projeto tem que estar num **Drive Compartilhado**, não na conta pessoal de ninguém. Se estiver na conta de uma pessoa, ele morre quando essa pessoa sair da empresa.

---

## Instalação (uma vez, ~30 minutos)

**1. Criar o projeto**
Abrir a planilha → Extensões → Apps Script. Colar os 7 arquivos `.gs` na mesma ordem dos nomes.

**2. Cadastrar as credenciais**
Configurações do projeto → Propriedades do script → Adicionar:

| Propriedade | Onde pegar |
|---|---|
| `GEMINI_API_KEY` | aistudio.google.com → Get API key |
| `CLAUDE_API_KEY` | console.anthropic.com → API Keys |
| `SLACK_WEBHOOK` | api.slack.com → seu app → Incoming Webhooks |

**3. Preencher o `00_Config.gs`**
Só três valores: `PLANILHA_ID`, `PASTA_DRIVE_ID` e `EMAIL_ERROS`.

**4. Rodar `instalar()`**
Autoriza os acessos e cria o gatilho de 1 em 1 hora.

**5. Rodar `testarTodasAsFontes()`**
Este é o teste que decide se o plano funciona. Leva cerca de 1 minuto e devolve a lista de sites que não responderam ao Apps Script. Se a lista vier vazia ou quase, seguir. Se muitos sites falharem, o plano B é Cloudflare Workers para esses casos.

**6. Publicar o Web App (só se quiser os botões no Slack)**
Implantar → Nova implantação → Aplicativo da Web → Executar como: eu → Acesso: qualquer pessoa. Copiar a URL e colar em api.slack.com → Interactivity → Request URL.

---

## Operação do dia a dia

Não tem. O robô roda sozinho de hora em hora e decide, pela prioridade de cada sindicato, quem ele verifica em cada rodada.

O que exige gente:

- **Validar os alertas do Slack.** Clicar em Confirmar, Ignorar ou Revisar. Na fase inicial isso é obrigatório para todos.
- **Olhar o e-mail de erro.** Fonte que quebrou manda aviso para `EMAIL_ERROS`. Silêncio de uma fonte é incidente, não é boa notícia.

---

## Como adicionar ou mudar um sindicato

Não se mexe no código. **Tudo vem da planilha.**

- Sindicato novo → nova linha na aba `01_SINDICATOS`, com prioridade e o ID da fonte
- Site novo ou mudou de endereço → nova linha ou correção na aba `02_FONTES`
- Mudar a frequência → trocar P1, P2 ou P3 na coluna Prioridade

A alteração vale na próxima rodada, sem deploy, sem reinício.

---

## Como reiniciar

Abrir `script.google.com`, entrar no projeto, rodar a função **`reiniciar()`**. Pronto.

Qualquer pessoa com acesso ao Drive Compartilhado consegue fazer isso, sem precisar falar com quem construiu.

Para ver a situação atual: função **`status()`** — mostra a última execução, quantas fontes estão cadastradas e quais gatilhos existem.

---

## Quando alguma coisa quebra

| Sintoma | O que fazer |
|---|---|
| Nenhum alerta há dias | Rodar `status()`. Se `ultimaExecucao` estiver velha, rodar `reiniciar()` |
| E-mail dizendo que uma fonte falhou | Abrir a URL no navegador. Se o site mudou de endereço, corrigir na aba `02_FONTES` |
| Alerta com dados errados | Marcar Revisar no Slack. Os casos de revisão são a matéria-prima do ajuste dos prompts |
| Execução estourando 6 minutos | Baixar `MAX_DOCUMENTOS_POR_EXECUCAO` no config |
| Erro de credencial | Conferir Propriedades do script |

---

## Limites que valem conhecer

| Limite | Valor | Folga |
|---|---|---|
| Tempo por execução | 6 minutos | o script para em 4min30 e retoma depois |
| Requisições externas por dia | 20.000 | usamos algumas centenas |
| Tempo total de gatilhos por dia | 6 horas | usamos bem menos |
| Tamanho de arquivo baixado | 50 MB | o maior PDF encontrado tem 4 MB |

---

## Custo

| Item | Valor |
|---|---|
| Apps Script, Drive, Sheets, Gmail | R$ 0 (já está no Workspace) |
| Slack webhook | R$ 0 |
| API do Gemini | camada gratuita |
| API do Claude | R$ 0 a ~R$ 25/mês, só nos sindicatos P1 |

Para custo zero absoluto: colocar `CLAUDE_SOMENTE_P1: false` e apagar a chave do Claude. A auditoria passa a ser uma segunda passada no Gemini.

---

## O que ainda não está pronto

**Consulta automática ao Mediador do MTE.** O arquivo `60_MTE.gs` está com o espaço reservado e toda a especificação técnica já levantada — endpoints, parâmetros, formato de resposta e os bloqueios (reCAPTCHA v3 e Cloudflare). Quando a função `consultarMediador_()` for implementada, basta virar `CFG.MTE_AUTOMATICO` para `true`. Nada mais no projeto muda.

Enquanto isso, o alerta do Slack já leva o link de consulta pronto e quem valida confere em segundos.

---

## Checklist de independência operacional

- [ ] O projeto está num Drive Compartilhado, não numa conta pessoal
- [ ] Pelo menos duas pessoas têm acesso de edição
- [ ] As chaves estão em Propriedades do Script, não no código
- [ ] `reiniciar()` funciona e alguém além do autor já testou
- [ ] Este runbook está no mesmo Drive Compartilhado
