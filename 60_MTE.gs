/**
 * 60_MTE.gs  |  Cruzamento com o Sistema Mediador do MTE
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  O QUE FOI VERIFICADO EM 14/08/2026 (testado por requisição HTTP real)
 *
 *  1. A busca (ConsultarInstColetivo) tem reCAPTCHA v3 invisível + Cloudflare.
 *  2. O extrato por número (ResumoVisualizar?NrSolicitacao=MRxxxxxx/AAAA)
 *     TAMBÉM responde 403 com cf-mitigated: challenge para cliente sem
 *     fingerprint de navegador. Ele é stateless, mas não é livre.
 *
 *  Consequência: o Apps Script NÃO alcança o Mediador por conta própria, nem
 *  para buscar nem para confirmar um número que já conhecemos. Qualquer via
 *  automatizada passa por um navegador real, fora do Google Workspace.
 *
 *  Por isso este arquivo NÃO tenta contornar a proteção. Ele implementa o lado
 *  de cá: o contrato com um serviço externo, a varredura, a deteccão do caso
 *  🔵 e o alerta. A peça que fala com o Mediador é responsabilidade da Exemplo.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CONTRATO DO SERVIÇO EXTERNO
 *
 *   POST {MTE_API_URL}/consultar     Authorization: Bearer {MTE_API_TOKEN}
 *   body:  { cnpj, razaoSocial, dataInicio, dataFim, uf, nrSolicitacao }
 *          (dd/MM/yyyy; qualquer campo pode vir vazio)
 *
 *   200 →  { "ok": true,
 *            "instrumentos": [
 *              { "nrSolicitacao": "MR012345/2026",
 *                "tipo": "CONVENCAO|ACORDO|TERMO_ADITIVO",
 *                "partes": "texto",
 *                "vigenciaInicio": "2026-05-01",
 *                "vigenciaFim":    "2027-04-30",
 *                "dataRegistro":   "2026-05-20",
 *                "link": "https://mediador.trabalho.gov.br/.../ResumoVisualizar?..." }
 *            ] }
 *   Erro →  { "ok": false, "erro": "texto" }
 *
 * ONDE HOSPEDAR: Google Cloud é bloqueado no Workspace da Exemplo. Render,
 * Railway ou Oracle Cloud Always Free atendem. Ver skill independencia-operacional.
 */

// ---------------------------------------------------------------- conferência de 1 documento

/**
 * Chamada pelo monitor principal quando encontra um documento no site do sindicato.
 * Devolve { status, link, numeroRegistro } para o alerta e para a aba 04_CCTS.
 */
function conferirMte_(gemini, entidades) {
  const nr = normalizarNrSolicitacao_(gemini && gemini.numero_registro_mte);
  const link = nr ? linkExtrato_(nr) : linkBuscaManual_(gemini, entidades);

  if (!CFG.MTE_AUTOMATICO) {
    return {
      status: nr ? '🟡 Registro ' + nr + ' citado no documento — conferir no Mediador'
                 : '🟡 Conferência manual pendente',
      link: link,
      numeroRegistro: nr
    };
  }

  try {
    const r = consultarMediadorViaApi_({
      nrSolicitacao: nr,
      cnpj: cnpjDaEntidade_(entidades),
      razaoSocial: (entidades[0] || {})['Nome completo confirmado'] || '',
      uf: (entidades[0] || {})['UF'] || ''
    });

    if (!r || !r.ok) {
      return { status: '⚪ MTE indisponível — conferir manualmente', link: link, numeroRegistro: nr };
    }

    const achado = (r.instrumentos || [])[0];
    if (!achado) {
      return { status: '🟡 Publicada no sindicato, sem registro no MTE ainda',
               link: link, numeroRegistro: nr };
    }

    const divergencia = divergenciaDeVigencia_(gemini, achado);
    if (divergencia) {
      return { status: '🔴 DIVERGENTE — ' + divergencia,
               link: achado.link || link, numeroRegistro: achado.nrSolicitacao };
    }

    return { status: '🟢 CONFIRMADA no MTE — registro ' + achado.nrSolicitacao,
             link: achado.link || link, numeroRegistro: achado.nrSolicitacao };

  } catch (e) {
    avisarErro_('Consulta ao Mediador falhou', e);
    return { status: '⚪ MTE indisponível — conferir manualmente', link: link, numeroRegistro: nr };
  }
}

// ---------------------------------------------------------------- segundo monitor (caso 🔵)

/**
 * Varre o Mediador por período de registro e encontra instrumentos que foram
 * registrados sem aparecer no site do sindicato — o caso 🔵.
 *
 * É a única via para as entidades sem site. Agendar como gatilho diário,
 * separado do rodarMonitor.
 *
 * Sem o serviço externo configurado, em vez de não fazer nada, monta uma lista
 * de conferência manual no Slack. Silêncio nunca é resposta aceitável aqui.
 */
function rodarMonitorMte() {
  const entidades = entidadesParaMte_();
  const dias = Number(PropertiesService.getScriptProperties()
                        .getProperty('MTE_JANELA_DIAS') || 15);
  const dataFim = hojeBr_();
  const dataInicio = diasAtras_(dias);

  if (!CFG.MTE_AUTOMATICO) {
    return avisarConferenciaManual_(entidades, dataInicio, dataFim);
  }

  const jaConhecidos = numerosJaRegistrados_();
  var azuis = 0, semCnpj = 0, falhas = 0;

  entidades.forEach(function (e) {
    const cnpj = cnpjDaEntidade_([e]);
    if (!cnpj) { semCnpj++; return; }

    var r;
    try {
      r = consultarMediadorViaApi_({
        cnpj: cnpj, razaoSocial: e['Nome completo confirmado'] || '',
        uf: e['UF'] || '', dataInicio: dataInicio, dataFim: dataFim
      });
    } catch (err) { falhas++; return; }

    if (!r || !r.ok) { falhas++; return; }

    (r.instrumentos || []).forEach(function (inst) {
      const nr = normalizarNrSolicitacao_(inst.nrSolicitacao);
      if (!nr || jaConhecidos[nr]) return;   // o monitor do site já pegou
      registrarCasoAzul_(e, inst);
      jaConhecidos[nr] = true;
      azuis++;
    });

    Utilities.sleep(3000);   // o Mediador não gosta de rajada
  });

  const msg = 'Varredura MTE (' + dataInicio + ' a ' + dataFim + '): ' +
              entidades.length + ' entidade(s), ' + azuis + ' caso(s) 🔵, ' +
              semCnpj + ' sem CNPJ cadastrado, ' + falhas + ' falha(s).';
  Logger.log(msg);
  if (semCnpj) {
    avisarErro_('Entidades sem CNPJ na base',
      semCnpj + ' entidade(s) ficaram de fora da varredura do MTE por não terem ' +
      'CNPJ na coluna "CNPJ" da aba ' + CFG.ABAS.SINDICATOS + '.');
  }
  return msg;
}

/** Instrumento que existe no MTE e nunca apareceu no site: entra na fila como 🔵. */
function registrarCasoAzul_(entidade, inst) {
  const sigla = entidade['Sigla correta'] || entidade['Sigla (base atual)'] || '?';

  const idAlerta = registrarFila_({
    entidade: sigla,
    documento: 'MTE ' + inst.nrSolicitacao,
    parecerGemini: 'Não analisado — origem MTE',
    parecerClaude: 'ORIGEM_MTE',
    divergencia: false
  });

  const bloco = [
    { type: 'header', text: { type: 'plain_text',
      text: '🔵 INSTRUMENTO REGISTRADO NO MTE SEM PUBLICAÇÃO NO SITE' } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*Sindicato:*\n' + sigla },
      { type: 'mrkdwn', text: '*Registro:*\n' + inst.nrSolicitacao },
      { type: 'mrkdwn', text: '*Tipo:*\n' + (inst.tipo || '—') },
      { type: 'mrkdwn', text: '*Vigência:*\n' + (inst.vigenciaInicio || '?') +
                              ' a ' + (inst.vigenciaFim || '?') },
      { type: 'mrkdwn', text: '*Registrado em:*\n' + (inst.dataRegistro || '—') },
      { type: 'mrkdwn', text: '*Partes:*\n' + (inst.partes || '—') }
    ] },
    { type: 'section', text: { type: 'mrkdwn', text:
      'O sindicato registrou no Mediador e não publicou no próprio site. ' +
      'O monitor de sites não teria encontrado.\n<' +
      (inst.link || linkExtrato_(inst.nrSolicitacao)) + '|Abrir extrato no Mediador>' } },
    { type: 'section', text: { type: 'mrkdwn', text:
      mencoes_() + '\n*Valide reagindo nesta mensagem:*  ' +
      ':white_check_mark: confirmar   :x: ignorar   :warning: revisar' } },
    { type: 'context', elements: [{ type: 'mrkdwn',
      text: 'Alerta ' + idAlerta + ' · origem MTE · ' + agora_() }] }
  ];

  const msg = slackApi_('chat.postMessage', {
    channel: CFG.SLACK_CANAL_ID,
    text: mencoes_() + ' Instrumento no MTE sem publicação no site: ' + sigla,
    blocks: bloco
  });

  [CFG.SLACK_EMOJI.confirmar, CFG.SLACK_EMOJI.ignorar, CFG.SLACK_EMOJI.revisar]
    .forEach(function (nome) {
      try { slackApi_('reactions.add',
        { channel: CFG.SLACK_CANAL_ID, timestamp: msg.ts, name: nome }); } catch (e) {}
    });

  if (msg && msg.ts) gravarSlackTs_(idAlerta, msg.ts);
  return idAlerta;
}

/**
 * Sem serviço externo, publica no canal a lista do que precisa ser conferido
 * à mão — priorizando quem não tem site, que é quem depende só do MTE.
 */
function avisarConferenciaManual_(entidades, dataInicio, dataFim) {
  const semSite = entidades.filter(function (e) {
    return String(e['Classe captura'] || '').toUpperCase() === 'E';
  });
  if (!semSite.length) return 'Nada a conferir manualmente no MTE.';

  const lista = semSite.map(function (e) {
    return '• ' + (e['Sigla correta'] || e['Sigla (base atual)']) +
           (cnpjDaEntidade_([e]) ? ' — CNPJ ' + cnpjDaEntidade_([e]) : ' — _sem CNPJ na base_');
  }).join('\n');

  slackApi_('chat.postMessage', {
    channel: CFG.SLACK_CANAL_ID,
    text: 'Conferência manual no Mediador',
    blocks: [
      { type: 'header', text: { type: 'plain_text',
        text: '📋 CONFERÊNCIA MANUAL NO MEDIADOR' } },
      { type: 'section', text: { type: 'mrkdwn', text:
        'Estas entidades não têm site — o Mediador é a única fonte delas. ' +
        'Consulta automática ainda não está ligada.\n' +
        'Período sugerido: *' + dataInicio + '* a *' + dataFim + '*' } },
      { type: 'section', text: { type: 'mrkdwn', text: lista } },
      { type: 'section', text: { type: 'mrkdwn', text:
        '<' + CFG.MTE_URL_CONSULTA + '|Abrir o Mediador>' } }
    ]
  });

  const msg = semSite.length + ' entidade(s) sem site listada(s) para conferência manual.';
  Logger.log(msg);
  return msg;
}

// ---------------------------------------------------------------- ponte com o serviço externo

/**
 * Único ponto que fala com o serviço que a Exemplo vai construir.
 * Se o endereço não estiver configurado, devolve null — nada quebra.
 */
function consultarMediadorViaApi_(params) {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('MTE_API_URL');
  const token = props.getProperty('MTE_API_TOKEN');
  if (!url) return null;

  const r = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/consultar', {
    method: 'post',
    contentType: 'application/json',
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    payload: JSON.stringify(params),
    muteHttpExceptions: true
  });

  if (r.getResponseCode() !== 200) {
    throw new Error('Serviço MTE respondeu ' + r.getResponseCode() + ': ' +
                    r.getContentText().slice(0, 200));
  }
  return JSON.parse(r.getContentText());
}

// ---------------------------------------------------------------- apoio

/** MR012345/2026 — aceita variações com espaço, minúscula ou sem barra. */
function normalizarNrSolicitacao_(bruto) {
  if (!bruto) return null;
  const m = String(bruto).toUpperCase().replace(/\s/g, '').match(/MR?\s*(\d{4,8})\/?(\d{4})/);
  return m ? 'MR' + m[1] + '/' + m[2] : null;
}

function linkExtrato_(nr) {
  return 'https://mediador.trabalho.gov.br/sistemas/mediador/Resumo/ResumoVisualizar' +
         '?NrSolicitacao=' + encodeURIComponent(nr);
}

function linkBuscaManual_(gemini, entidades) {
  const termo = (gemini && gemini.sindicato_laboral) ||
                ((entidades[0] || {})['Sigla correta']) || '';
  return CFG.MTE_URL_CONSULTA + '#' + encodeURIComponent(termo);
}

function cnpjDaEntidade_(entidades) {
  const e = entidades[0] || {};
  const bruto = String(e['CNPJ'] || '').replace(/\D/g, '');
  return bruto.length === 14 ? bruto : '';
}

/** Entidades a varrer: as sem site primeiro, depois as P1. */
function entidadesParaMte_() {
  const todas = lerAba_(CFG.ABAS.SINDICATOS).filter(function (s) {
    return s['Sigla correta'] && String(s['Sigla correta']).indexOf('MTE') === -1;
  });
  const peso = function (s) {
    if (String(s['Classe captura'] || '').toUpperCase() === 'E') return 0;   // sem site
    if (s['Prioridade'] === 'P1') return 1;
    if (s['Prioridade'] === 'P2') return 2;
    return 3;
  };
  return todas.sort(function (a, b) { return peso(a) - peso(b); });
}

/** Números de registro que o monitor de sites já conhece — evita alerta duplicado. */
function numerosJaRegistrados_() {
  const mapa = {};
  try {
    lerAba_(CFG.ABAS.CCTS).forEach(function (c) {
      const nr = normalizarNrSolicitacao_(c['Nº registro MTE']);
      if (nr) mapa[nr] = true;
    });
  } catch (e) { /* aba ainda vazia */ }
  return mapa;
}

/** Compara a vigência do PDF com a do registro. Devolve o texto da divergência ou null. */
function divergenciaDeVigencia_(gemini, achado) {
  const par = [
    ['início de vigência', gemini.vigencia_inicio, achado.vigenciaInicio],
    ['fim de vigência', gemini.vigencia_fim, achado.vigenciaFim]
  ];
  const difs = par.filter(function (p) {
    return p[1] && p[2] && String(p[1]).slice(0, 10) !== String(p[2]).slice(0, 10);
  }).map(function (p) {
    return p[0] + ': documento diz ' + p[1] + ', MTE diz ' + p[2];
  });
  return difs.length ? difs.join(' · ') : null;
}

function hojeBr_() {
  return Utilities.formatDate(new Date(), CFG.FUSO, 'dd/MM/yyyy');
}

function diasAtras_(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return Utilities.formatDate(d, CFG.FUSO, 'dd/MM/yyyy');
}
