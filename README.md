# Demonstração — Monitoramento de convenções coletivas (CCTs)

> Projeto de portfólio de **Victória Pedrosa**. **Demonstração** de monitoramento de convenções coletivas (CCTs) — versão com dados fictícios (nomes, CNPJs, e-mails e IDs internos substituídos).

## Problema de negócio
Acompanhar novas convenções coletivas (CCTs) de todos os sindicatos era manual e arriscado para a folha.

## Antes x depois
| | Antes | Depois |
|---|---|---|
| Como é feito | Consulta periódica manual aos sites e ao Mediador do MTE. | Monitor coleta documentos, classifica com IA (Gemini + auditoria Claude), cruza com o Mediador do MTE e alerta no Slack com validação por reação. |

## Ganho
- Nenhuma CCT nova passa despercebida.

## Tecnologias
APIs REST, Claude API, E-mail automático, Gatilhos agendados, Gemini API, Google Apps Script, Google Drive, Google Sheets, SQLite

## Arquivos
- `00_Config.gs`
- `10_Planilha.gs`
- `20_Coletor.gs`
- `30_IA.gs`
- `40_Slack.gs`
- `50_Main.gs`
- `60_MTE.gs`
- `70_Setup.gs`
- `80_Operacao.gs`
- `90_Acervo.gs`
- `99_Municipios.gs`
- `ARQUITETURA_MONITOR_CCT.md`
- `RUNBOOK.md`

## Como usar
Crie um projeto no Google Apps Script, copie os arquivos `.gs`/`.html` e configure as Propriedades do script indicadas no código.

## Autora
Victória Pedrosa — Product Owner do Time de IA, automação de processos contábeis e fiscais.
