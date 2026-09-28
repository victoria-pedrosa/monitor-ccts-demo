/**
 * 50_Main.gs  |  Orquestrador. É esta função que os gatilhos por tempo chamam.
 *
 * O Apps Script encerra em 6 minutos. A rodada para em 4min30 e guarda um cursor;
 * a execução seguinte retoma exatamente de onde parou. Nenhuma fonte fica órfã.
 */

function rodarMonitor() {
  // MARCO_ZERO_GUARDA - enquanto a adocao do acervo estiver rodando, o monitor
  // fica quieto: o que ja esta nos sites e acervo, nao novidade. O gatilho
  // adotarAcervo se apaga sozinho ao terminar e o monitor volta na hora seguinte.
  if (ScriptApp.getProjectTriggers().some(function (g) {
        return g.getHandlerFunction() === 'adotarAcervo'; })) {
    Logger.log('Adocao do acervo em andamento - monitor pausado nesta rodada.');
    return;
  }

  // Primeiro colhe o que o time decidiu por reacao no Slack desde a ultima rodada.
  try {
    const decididos = coletarDecisoes_();
    if (decididos) Logger.log(decididos + ' decisao(oes) lidas das reacoes do Slack.');
  } catch (e) {
    avisarErro_('Falha ao ler reacoes do Slack', e);
  }

  const inicio = new Date().getTime();
  const props = PropertiesService.getScriptProperties();
  const fontes = carregarFontes_();          // ← lê a aba 02_FONTES da planilha, sempre
  const estado = lerEstado_();

  var cursor = Number(props.getProperty('CURSOR') || 0);
  if (cursor >= fontes.length) cursor = 0;

  var analisados = 0;

  while (cursor < fontes.length) {
    if (new Date().getTime() - inicio > CFG.TEMPO_MAXIMO_MS) break;
    if (analisados >= CFG.MAX_DOCUMENTOS_POR_EXECUCAO) break;

    const fonte = fontes[cursor];
    cursor++;

    if (!deveVerificar_(fonte)) continue;

    try {
      const r = verificarFonte_(fonte, estado);

      if (r.erro) {
        registrarMonitoramento_({ idFonte: fonte['ID Fonte'], entidade: fonte['Entidade'],
          url: fonte['URL monitorada'], http: r.http, alterou: false,
          status: '🔴 FONTE COM FALHA — ' + r.observacao });
        // Site de sindicato cai e volta sozinho (timeout, DNS, 500). Na planilha a falha
        // fica registrada sempre; e-mail so quando insiste: 3 verificacoes seguidas E 24h+.
        // F62 (MTE) e companhia falham por decisao de fora - nunca viram e-mail.
        const queda = contarFalhaFonte_(fonte['ID Fonte']);
        if ((CFG.FONTES_SEM_AVISO_DE_FALHA || []).indexOf(fonte['ID Fonte']) < 0 &&
            queda.vezes >= 3 && queda.horas >= 24) {
          avisarErro_('Fonte com falha: ' + fonte['ID Fonte'] + ' ' + fonte['Entidade'],
            r.observacao + '\n\nFora do ar ha ' + queda.vezes + ' verificacoes seguidas (' +
            Math.round(queda.horas) + 'h). Conferir se o site mudou de endereco.');
        }
        continue;
      }
      zerarFalhaFonte_(fonte['ID Fonte']);   // respondeu: zera a contagem de queda

      if (r.semDocumentos) {
        registrarMonitoramento_({ idFonte: fonte['ID Fonte'], entidade: fonte['Entidade'],
          url: fonte['URL monitorada'], http: 200, hash: r.hashPagina,
          alterou: r.paginaMudou, tipoAlteracao: r.paginaMudou ? 'Página mudou, sem documento' : '-',
          status: r.paginaMudou ? '🟡 Verificar manualmente' : 'Sem alteração' });
        gravarEstado_(fonte['ID Fonte'] + '|PAGINA',
          { urlDocumento: fonte['URL monitorada'], hash: r.hashPagina, bytes: 0, httpStatus: 200 });
        continue;
      }

      if (r.documentos.length === 0) {
        registrarMonitoramento_({ idFonte: fonte['ID Fonte'], entidade: fonte['Entidade'],
          url: fonte['URL monitorada'], http: 200, hash: r.hashPagina,
          alterou: false, status: 'Sem alteração' });
        continue;
      }

      const entidades = entidadesDaFonte_(fonte['ID Fonte']);

      for (var i = 0; i < r.documentos.length; i++) {
        if (analisados >= CFG.MAX_DOCUMENTOS_POR_EXECUCAO) break;
        processarDocumento_(fonte, r.documentos[i], entidades);
        analisados++;
      }
      zerarAdiamento_(fonte['ID Fonte']);   // rodada limpa: zera o contador de adiamentos

    } catch (err) {
      // IA fora do ar (429/503) nao e erro do robo. O documento NAO foi marcado como
      // visto, entao a rodada seguinte tenta de novo sozinha - nenhuma CCT se perde.
      // So vira incidente se a indisponibilidade insistir por 3 rodadas seguidas.
      // Instabilidade passageira do Google (planilha ocupada, servico fora) tem o mesmo
      // tratamento: documento nao foi marcado como visto, a proxima rodada refaz.
      if (err && (err.geminiIndisponivel || /simultaneous invocations|Service .*(failed|timed out|unavailable)|invoked too many times|temporariamente|temporarily/i.test(String(err.message)))) {
        const vezes = contarAdiamento_(fonte['ID Fonte']);
        registrarMonitoramento_({ idFonte: fonte['ID Fonte'], entidade: fonte['Entidade'],
          url: fonte['URL monitorada'], http: 'IA', alterou: false,
          status: '⏳ IA indisponivel — sera reprocessado (rodada ' + vezes + ')' });
        if (vezes >= 3) avisarErro_('IA indisponivel ha ' + vezes + ' rodadas em ' + fonte['ID Fonte'], err);
        continue;
      }
      zerarAdiamento_(fonte['ID Fonte']);
      avisarErro_('Erro em ' + fonte['ID Fonte'], err);
      registrarMonitoramento_({ idFonte: fonte['ID Fonte'], entidade: fonte['Entidade'],
        url: fonte['URL monitorada'], http: 'ERRO', alterou: false,
        status: '🔴 ERRO — ' + err.message });
    }
  }

  props.setProperty('CURSOR', String(cursor));
  props.setProperty('ULTIMA_EXECUCAO', agora_());
}

/** Um documento novo: IA lê, auditor confere, MTE cruza, Slack avisa, humano decide. */
function processarDocumento_(fonte, doc, entidades) {
  const entidade = entidades.length ? entidades[0]['Sigla correta'] : fonte['Entidade'];

  const gemini = classificarComGemini_(doc.blob, entidades);

  // Não é instrumento coletivo e a IA está confiante disso: registra e encerra.
  if (!gemini.eh_instrumento_coletivo && gemini.confianca >= CFG.CONFIANCA_MINIMA) {
    gravarEstado_(doc.chave, { urlDocumento: doc.url, hash: doc.hash, bytes: doc.bytes,
      httpStatus: doc.http, observacao: 'Classificado como ' + gemini.tipo });
    registrarMonitoramento_({ idFonte: fonte['ID Fonte'], entidade: entidade, url: fonte['URL monitorada'],
      http: 200, hash: doc.hash, alterou: true, tipoAlteracao: doc.tipoAlteracao,
      urlDocumento: doc.url, parecerGemini: 'Não é CCT (' + gemini.tipo + ')',
      confianca: gemini.confianca, status: 'Ignorado — não é instrumento coletivo' });
    return;
  }

  const auditor = auditar_(doc.blob, gemini, entidades);

  if (auditor.decisao === 'NAO_ALERTAR' && !CFG.ALERTAR_EM_CASO_DE_DUVIDA) {
    gravarEstado_(doc.chave, { urlDocumento: doc.url, hash: doc.hash, bytes: doc.bytes, httpStatus: doc.http });
    registrarMonitoramento_({ idFonte: fonte['ID Fonte'], entidade: entidade, url: fonte['URL monitorada'],
      http: 200, hash: doc.hash, alterou: true, tipoAlteracao: doc.tipoAlteracao, urlDocumento: doc.url,
      parecerGemini: gemini.tipo, confianca: gemini.confianca,
      parecerClaude: 'NAO_ALERTAR', status: 'Descartado pelo auditor' });
    return;
  }

  // ---------- Acervo antigo nao vira alerta ----------
  // O coletor detecta ARQUIVO NOVO NO SITE, nao CCT NOVA. Sindicato que reorganiza
  // a pagina faz o acervo inteiro parecer novidade - foi o que encheu o canal de
  // convencoes de 2024 e 2025. Instrumento com vigencia encerrada fica so no log.
  // Na duvida (documento sem data) o alerta sobe: falso negativo continua sendo pior.
  const antigo = vigenciaVencida_(gemini);
  if (antigo && !CFG.ALERTAR_ACERVO_ANTIGO) {
    gravarEstado_(doc.chave, { urlDocumento: doc.url, hash: doc.hash, bytes: doc.bytes,
      httpStatus: doc.http, observacao: 'Acervo antigo - registrado sem alertar' });
    registrarMonitoramento_({ idFonte: fonte['ID Fonte'], entidade: entidade, url: fonte['URL monitorada'],
      http: 200, hash: doc.hash, alterou: true, tipoAlteracao: doc.tipoAlteracao, urlDocumento: doc.url,
      parecerGemini: gemini.tipo, confianca: gemini.confianca, parecerClaude: auditor.decisao,
      status: 'Acervo antigo - nao alertado (' + String(antigo).replace(/\*/g, '') + ')' });
    return;
  }

  const linkDrive = salvarNoDrive_(doc.blob, entidade, doc.url);
  const mte = conferirMte_(gemini, entidades);   // ver 60_MTE.gs

  const idCct = registrarCct_(Object.assign({}, gemini, {
    urlDocumento: doc.url, linkDrive: linkDrive,
    statusMte: mte.status, numero_registro_mte: mte.numeroRegistro || gemini.numero_registro_mte
  }));

  // Base territorial: CCT so alcanca empresa sediada nos municipios que ela cobre.
  // Sem esse corte o alerta inflava a contagem com empresa de outra cidade.
  const empresas = filtrarPorBaseTerritorial_(empresasImpactadas_(entidades),
                                              gemini.municipios_abrangidos);
  const linkEmpresas = (empresas.notificar.length || empresas.pendentes.length)
    ? planilhaEmpresas_(idCct, (entidades[0] || {})['Sigla correta'] || 'SEM_SIGLA', empresas)
    : '';

  const idAlerta = registrarFila_({
    entidade: entidade, documento: doc.url.split('/').pop(),
    parecerGemini: gemini.tipo + ' (' + gemini.confianca + ')',
    parecerClaude: auditor.decisao,
    divergencia: auditor.concorda_com_gemini === false
  });

  const slackTs = enviarAlerta_({
    idAlerta: idAlerta, idFonte: fonte['ID Fonte'], entidade: entidade,
    tipo: gemini.tipo, tipoAlteracao: doc.tipoAlteracao, gemini: gemini,
    decisao: auditor.decisao, justificativa: auditor.justificativa,
    linkDrive: linkDrive, statusMte: mte.status, linkMte: mte.link,
    empresas: empresas, linkEmpresas: linkEmpresas
  });
  if (slackTs) gravarSlackTs_(idAlerta, slackTs);

  gravarEstado_(doc.chave, { urlDocumento: doc.url, hash: doc.hash, bytes: doc.bytes,
    httpStatus: doc.http, observacao: 'Alerta ' + idAlerta + ' / ' + idCct });

  registrarMonitoramento_({ idFonte: fonte['ID Fonte'], entidade: entidade, url: fonte['URL monitorada'],
    http: 200, hash: doc.hash, alterou: true, tipoAlteracao: doc.tipoAlteracao, urlDocumento: doc.url,
    parecerGemini: gemini.tipo, confianca: gemini.confianca, parecerClaude: auditor.decisao,
    status: '⚠️ Aguardando validação humana', idCct: idCct });
}

/**
 * Frequência por prioridade, lida da planilha.
 * P1 de 4 em 4h · P2 1x/dia · P3 2x/semana.
 * Na janela de 60 dias antes da data-base, tudo vira P1 — é quando o sindicato publica.
 */
function deveVerificar_(fonte) {
  const entidades = entidadesDaFonte_(fonte['ID Fonte']);
  if (!entidades.length) return true;

  const emJanela = entidades.some(function (e) { return dentroDaJanelaDataBase_(e['Data-base']); });
  if (emJanela) return true;

  const prioridade = entidades.reduce(function (max, e) {
    const ordem = { P1: 3, P2: 2, P3: 1 };
    return Math.max(max, ordem[e['Prioridade']] || 1);
  }, 1);

  const hora = Number(Utilities.formatDate(new Date(), CFG.FUSO, 'H'));
  const diaSemana = Number(Utilities.formatDate(new Date(), CFG.FUSO, 'u'));  // 1=seg

  if (prioridade === 3) return true;                       // P1: toda rodada
  if (prioridade === 2) return hora >= 8 && hora < 12;     // P2: 1x por dia, de manhã
  return (diaSemana === 2 || diaSemana === 5) && hora >= 8 && hora < 12;  // P3: ter e sex
}

function dentroDaJanelaDataBase_(dataBase) {
  if (!dataBase) return false;
  const meses = { jan:1, fev:2, mar:3, abr:4, mai:5, jun:6, jul:7, ago:8, set:9, out:10, nov:11, dez:12 };
  const m = String(dataBase).toLowerCase().match(/(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/);
  if (!m) return false;
  const hoje = new Date();
  const alvo = new Date(hoje.getFullYear(), meses[m[1]] - 1, 1);
  if (alvo < hoje) alvo.setFullYear(alvo.getFullYear() + 1);
  const dias = (alvo - hoje) / 86400000;
  return dias >= 0 && dias <= 60;
}

/**
 * Contador de rodadas seguidas em que a IA nao respondeu para uma fonte.
 * Serve para separar 'pico de demanda passageiro' de 'esta fora do ar de verdade'.
 */
function contarAdiamento_(idFonte) {
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty('ADIADO|' + idFonte) || 0) + 1;
  props.setProperty('ADIADO|' + idFonte, String(n));
  return n;
}

function zerarAdiamento_(idFonte) {
  PropertiesService.getScriptProperties().deleteProperty('ADIADO|' + idFonte);
}

function contarFalhaFonte_(idFonte) {
  const props = PropertiesService.getScriptProperties();
  const chave = 'FALHA|' + idFonte;
  const q = JSON.parse(props.getProperty(chave) || 'null') || { vezes: 0, desde: Date.now() };
  q.vezes++;
  props.setProperty(chave, JSON.stringify(q));
  return { vezes: q.vezes, horas: (Date.now() - q.desde) / 3600000 };
}

function zerarFalhaFonte_(idFonte) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('FALHA|' + idFonte)) props.deleteProperty('FALHA|' + idFonte);
}
