/**
 * 40_Slack.gs  |  Alerta no canal + validacao por reacao.

 *
 * NAO existe endpoint publico neste projeto. O admin do Workspace bloqueia
 * App da Web anonimo e o Slack nao consegue autenticar como usuario da Exemplo.
 * Em vez do Slack chamar a gente, invertemos o sentido: todo o trafego e de
 * saida e o robo LE as reacoes na rodada seguinte.
 *
 * Quem valida clica no emoji da propria mensagem do alerta:
 *   :white_check_mark:  Confirmar
 *   :x:                 Ignorar
 *   :warning:           Revisar
 *
 * Credencial: SLACK_BOT_TOKEN (xoxb-...) nas Propriedades do script.
 * Escopos do bot: chat:write, reactions:read, reactions:write, channels:history, users:read.
 * Sem token, cai no SLACK_WEBHOOK: posta igual, so nao le reacao.
 */

function temTokenSlack_() {
  return !!PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
}

/** POST autenticado na API do Slack. */
function slackApi_(metodo, corpo) {
  const r = UrlFetchApp.fetch('https://slack.com/api/' + metodo, {
    method: 'post', contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + segredo_('SLACK_BOT_TOKEN') },
    payload: JSON.stringify(corpo), muteHttpExceptions: true
  });
  const resp = JSON.parse(r.getContentText());
  if (!resp.ok) throw new Error('Slack ' + metodo + ': ' + resp.error);
  return resp;
}

/** GET autenticado na API do Slack. */
function slackGet_(metodo, params) {
  const q = Object.keys(params).map(function (k) {
    return k + '=' + encodeURIComponent(params[k]);
  }).join('&');
  const r = UrlFetchApp.fetch('https://slack.com/api/' + metodo + '?' + q, {
    headers: { Authorization: 'Bearer ' + segredo_('SLACK_BOT_TOKEN') },
    muteHttpExceptions: true
  });
  return JSON.parse(r.getContentText());
}

// ---------------------------------------------------------------- alerta

/** dd/mm/aaaa a partir de aaaa-mm-dd. Devolve o proprio texto se nao reconhecer. */
function dataBr_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + '/' + m[2] + '/' + m[1] : (s || '');
}

/** 7.5 -> "7,5"   1519 -> "1.519,00" */
function numBr_(n, casas) {
  if (n == null || n === '') return '';
  const v = Number(n);
  if (isNaN(v)) return String(n);
  const p = v.toFixed(casas == null ? 2 : casas).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return p.join(',').replace(/,00$/, casas === 0 ? '' : ',00');
}

/** Vigencia em uma linha, sem "? a ?". */
function vigenciaTexto_(g) {
  const i = dataBr_(g.vigencia_inicio), f = dataBr_(g.vigencia_fim);
  if (i && f) return 'vigência ' + i + ' a ' + f;
  if (i)      return 'vigência a partir de ' + i + ' (fim não informado)';
  if (f)      return 'vigência até ' + f + ' (início não informado)';
  return 'vigência não informada';
}

/**
 * Documento antigo nao e novidade.
 *
 * O robo detecta ARQUIVO NOVO NO SITE, nao CCT NOVA. Sindicato que reorganiza a
 * pagina faz o acervo inteiro parecer novidade - foi o caso do SINDPAD/BA, uma
 * CCT de janeiro de 2025 chegando como alerta em agosto de 2026. Sem este aviso
 * a pessoa aplica reajuste vencido na folha.
 */
function vigenciaVencida_(g) {
  const hoje = new Date();
  if (g.vigencia_fim) {
    const f = new Date(String(g.vigencia_fim) + 'T12:00:00');
    if (!isNaN(f) && f < hoje) {
      return 'A vigência terminou em *' + dataBr_(g.vigencia_fim) + '*. ' +
             'Provavelmente já existe instrumento mais recente.';
    }
    return null;
  }
  if (g.vigencia_inicio) {
    const i = new Date(String(g.vigencia_inicio) + 'T12:00:00');
    if (isNaN(i)) return null;
    const meses = (hoje - i) / 2629800000;
    if (meses > 14) {
      return 'A vigência começou em *' + dataBr_(g.vigencia_inicio) + '* e o documento não ' +
             'informa o fim. Convenção costuma valer 12 meses, então esta já deve ter sido ' +
             'substituída. Procure a versão do ano corrente antes de usar.';
    }
  }
  return null;
}

/** Pisos por funcao. Quase nenhuma CCT tem piso unico - mostrar um so engana. */
function pisosTexto_(g) {
  const p = (g.pisos || []).filter(function (x) { return x && (x.funcao || x.valor != null); });
  if (!p.length) return null;
  return p.map(function (x) {
    const v = x.valor != null ? 'R$ ' + numBr_(x.valor) : (x.observacao || 'livre negociação');
    return '·  ' + (x.funcao || 'função não especificada') + ':  *' + v + '*';
  }).join('\n');
}

/** O que o documento NAO trouxe. Falta de dado e informacao, nao e espaco em branco. */
function lacunas_(g) {
  const faltas = [];
  const temPisos = (g.pisos || []).length > 0;
  if (!g.sindicato_patronal) faltas.push('sindicato patronal');
  if (!g.vigencia_inicio)    faltas.push('início da vigência');
  if (!g.vigencia_fim)       faltas.push('fim da vigência');
  if (g.reajuste_percentual == null) faltas.push('reajuste');
  if (g.piso_salarial == null && !temPisos) faltas.push('piso salarial');
  if (g.documento_assinado === false) faltas.push('assinatura das partes');
  return faltas;
}

/**
 * Monta a mensagem do alerta.
 *
 * Regra de leitura: a PRIMEIRA coisa que a pessoa ve tem que ser QUAL convencao
 * saiu, lida do proprio documento - nunca a sigla do cadastro. Depois vem, nesta
 * ordem, o que impede de usar o documento (vigencia vencida, divergencia de
 * cadastro, dado faltando) e so entao a leitura da IA.
 */
function blocosAlerta_(dados) {
  const g = dados.gemini || {};
  const bloco = [];
  const noDoc = g.sindicato_laboral || dados.entidade;
  const vencida = vigenciaVencida_(g);
  const limpo = !g.divergencia_cadastro && !vencida;

  bloco.push({ type: 'header', text: { type: 'plain_text',
    text: (limpo ? ':rotating_light: NOVA ' + (g.tipo || dados.tipo || 'CCT') + ' — '
                 : ':mag: CONFERIR — ') + String(noDoc).slice(0, 60) } });

  // ---------- 1. O que o documento diz (a resposta para "qual CCT saiu?")
  const partes = noDoc + (g.sindicato_patronal ? '  ×  ' + g.sindicato_patronal
                                               : '  ×  _patronal não identificado_');
  const linha2 = [ (g.tipo || 'CCT'), vigenciaTexto_(g),
                   g.data_base ? 'data-base ' + g.data_base : null ].filter(Boolean).join('  ·  ');
  const pisos = pisosTexto_(g);
  const linha3 = [ g.reajuste_percentual != null ? 'Reajuste *' + numBr_(g.reajuste_percentual, 1) + '%*' : null,
                   (!pisos && g.piso_salarial != null) ? 'Piso *R$ ' + numBr_(g.piso_salarial) + '*' : null
                 ].filter(Boolean).join('  ·  ');

  bloco.push({ type: 'section', text: { type: 'mrkdwn',
    text: '*O documento é de:*\n' + partes + '\n' + linha2 + (linha3 ? '\n' + linha3 : '') } });

  if (pisos) {
    bloco.push({ type: 'section', text: { type: 'mrkdwn',
      text: '*Pisos por função*\n' + pisos } });
  }

  // ---------- 2. Vigencia vencida: o erro mais caro e aplicar reajuste velho
  if (vencida) {
    bloco.push({ type: 'section', text: { type: 'mrkdwn',
      text: ':hourglass: *Atenção: este documento não é novo*\n' + vencida } });
  }

  // ---------- 3. Divergencia: comparacao lado a lado, nao paragrafo
  if (g.divergencia_cadastro) {
    bloco.push({ type: 'section', text: { type: 'mrkdwn', text:
      ':mag: *Não é o que esperávamos desta fonte*\n' +
      '>*No documento:* ' + noDoc + (g.data_base ? ' · data-base ' + g.data_base : '') + '\n' +
      '>*No cadastro:*  ' + dados.entidade + '\n' +
      '_' + g.divergencia_cadastro + '_\n' +
      'Pode ser convenção de outra categoria ou de outra base territorial publicada no mesmo ' +
      'site, ou o cadastro está desatualizado. O que decide é o município da empresa.' } });
  }

  // ---------- 4. Base territorial
  const mun = (g.municipios_abrangidos || []).filter(String);
  if (mun.length) {
    const amostra = mun.slice(0, 8).join(', ');
    bloco.push({ type: 'section', text: { type: 'mrkdwn',
      text: '*Abrange ' + mun.length + ' município(s):* ' + amostra +
            (mun.length > 8 ? ' … (+' + (mun.length - 8) + ')' : '') +
            '\n_Só vale para empresa sediada em um desses municípios._' } });
  }

  // ---------- 5. O que faltou no documento
  const faltas = lacunas_(g);
  if (faltas.length) {
    bloco.push({ type: 'section', text: { type: 'mrkdwn',
      text: '*O documento não traz:* ' + faltas.join(', ') + '.' } });
  }

  // ---------- 6. Leitura da IA
  const NOME_TIPO = { CCT: 'convenção coletiva', ACT: 'acordo coletivo',
                      TERMO_ADITIVO: 'termo aditivo', MINUTA: 'minuta',
                      PAUTA: 'pauta de reivindicações', COMUNICADO: 'comunicado',
                      INDETERMINADO: 'documento que a IA não conseguiu ler' };
  const NOME_DECISAO = { VALIDAR_ALERTA: 'aprovado para alerta',
                         ESCALAR_HUMANO: 'precisa de olho humano',
                         NAO_ALERTAR:    'o auditor não recomendaria alertar' };
  const pct = Math.round((g.confianca || 0) * 100);

  bloco.push({ type: 'section', text: { type: 'mrkdwn', text:
    '*Leitura da IA:* ' + (g.eh_instrumento_coletivo
        ? 'é uma ' + (NOME_TIPO[g.tipo] || 'instrumento coletivo')
        : 'não parece instrumento coletivo') + ' — ' + pct + '% de confiança\n' +
    '*Conferência:* ' + (NOME_DECISAO[dados.decisao] || dados.decisao) +
    (dados.justificativa ? '\n_' + dados.justificativa + '_' : '') } });

  // ---------- 7. Impacto
  if (dados.empresas) {
    const emp = dados.empresas;
    let txt = '*Empresas impactadas:* ' + emp.notificar.length;
    if (emp.notificar.length) txt += '\n' + porFolha_(emp.notificar);

    // Base territorial: sem esse recorte a contagem engana - CCT nao alcanca
    // empresa de outro municipio, mesmo sendo da mesma categoria.
    if (emp.aplicouFiltro) {
      txt += '\n_Já descontadas as que ficam fora dos ' + emp.municipios + ' município(s) da convenção' +
             (emp.fora && emp.fora.length ? ' — ' + emp.fora.length + ' empresa(s) cortada(s)._' : '._');
    } else {
      txt += '\n:warning: _O documento não trouxe a base territorial, então esta lista NÃO foi ' +
             'filtrada por município. Confira antes de aplicar._';
    }
    if (emp.semMunicipio && emp.semMunicipio.length) {
      txt += '\n:round_pushpin: ' + emp.semMunicipio.length + ' empresa(s) sem município cadastrado — ' +
             'mantidas na lista por precaução, conferir na aba 10_EMPRESAS';
    }

    if (emp.pendentes.length) txt += '\n:warning: ' + emp.pendentes.length +
      ' empresa(s) com de-para pendente - conferir a aba 12_DEPARA';
    if (dados.linkEmpresas) txt += '\n<' + dados.linkEmpresas + '|Baixar a lista com nome e CNPJ>';
    bloco.push({ type: 'section', text: { type: 'mrkdwn', text: txt } });
  }

  bloco.push({ type: 'divider' });

  // ---------- 8. O que fazer, na ordem
  bloco.push({ type: 'section', text: { type: 'mrkdwn', text:
    '*O que fazer*\n' +
    '1. Abrir o documento e confirmar sindicato, base territorial e vigência' +
    (dados.linkDrive ? '  ·  <' + dados.linkDrive + '|Abrir documento>' : '') + '\n' +
    '2. Conferir o registro no MTE — ' + dados.statusMte +
    (dados.linkMte ? '  ·  <' + dados.linkMte + '|Abrir Mediador>' : '') + '\n' +
    '3. Reagir aqui:  :white_check_mark: é CCT válida   ' +
    ':x: não interessa   :warning: ainda em dúvida' } });

  if (!dados.teste) {
    bloco.push({ type: 'section', text: { type: 'mrkdwn', text: mencoes_() } });
  }

  bloco.push({ type: 'context', elements: [{ type: 'mrkdwn',
    text: 'Alerta ' + dados.idAlerta + ' · fonte ' + dados.idFonte + ' ' +
          (dados.tipoAlteracao || '') + ' · aguardando validação humana · ' + agora_() }] });

  return bloco;
}
/**
 * Posta o alerta e semeia os tres emojis. Devolve o ts da mensagem, que e a
 * chave para ler a decisao depois. Sem token, usa o webhook e devolve ''.
 */
/**
 * Quem é marcado quando sai CCT nova.
 * Padrão: ID_SLACK_EXEMPLO (Colaborador 62, líder de Folha).
 * Para mudar ou incluir mais gente, crie a propriedade SLACK_MENCIONAR
 * em Configurações do projeto com os IDs separados por vírgula.
 * Não se edita código para trocar destinatário.
 */
function mencoes_() {
  const bruto = PropertiesService.getScriptProperties()
                  .getProperty('SLACK_MENCIONAR') || 'ID_SLACK_EXEMPLO';
  return bruto.split(',')
    .map(function (id) { return String(id).trim(); })
    .filter(Boolean)
    .map(function (id) { return '<@' + id + '>'; })
    .join(' ');
}

function enviarAlerta_(dados) {
  const blocos = sanitizarBlocos_(blocosAlerta_(dados));
  const resumo = 'Nova CCT detectada: ' + dados.entidade;

  if (!temTokenSlack_()) {
    UrlFetchApp.fetch(segredo_('SLACK_WEBHOOK'), {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ text: (dados.teste ? '' : mencoes_() + ' ') + resumo, blocks: blocos })
    });
    return '';
  }

  var msg;
  try {
    msg = slackApi_('chat.postMessage', {
      channel: CFG.SLACK_CANAL_ID, text: (dados.teste ? '' : mencoes_() + ' ') + resumo, blocks: blocos
    });
  } catch (e) {
    // O Slack recusou o layout. Alerta de CCT nao pode sumir por formatacao:
    // reposta em texto puro, com o link do arquivo, e registra o motivo.
    Logger.log('Slack recusou os blocos: ' + e + ' | blocos=' + blocos.length);
    msg = slackApi_('chat.postMessage', {
      channel: CFG.SLACK_CANAL_ID,
      text: (dados.teste ? '' : mencoes_() + ' ') + resumo + '\n\n' + textoSimples_(dados) +
            '\n_(o layout completo falhou no Slack - conteudo enviado em texto)_'
    });
    avisarErro_('Alerta ' + dados.idAlerta + ' foi postado em texto simples (Slack recusou o layout)', e);
  }

  [CFG.SLACK_EMOJI.confirmar, CFG.SLACK_EMOJI.ignorar, CFG.SLACK_EMOJI.revisar]
    .forEach(function (nome) {
      try {
        slackApi_('reactions.add', { channel: CFG.SLACK_CANAL_ID, timestamp: msg.ts, name: nome });
      } catch (e) {
        // emoji indisponivel ou ja posto nao invalida o alerta
      }
    });

  return msg.ts;
}

// ---------------------------------------------------------------- decisoes

/** Nome de quem reagiu. Cai para o id se users.info falhar. */
function nomeUsuarioSlack_(id) {
  try {
    const u = slackGet_('users.info', { user: id });
    if (!u.ok) return id;
    const p = u.user.profile || {};
    return p.real_name || p.display_name || u.user.name || id;
  } catch (e) {
    return id;
  }
}

/**
 * Le as reacoes dos alertas pendentes e grava a decisao humana na planilha.
 * Roda no inicio de cada ciclo. Ignora a propria reacao do bot (a semente).
 * Devolve quantas decisoes gravou.
 */
function coletarDecisoes_() {
  if (!temTokenSlack_()) return 0;

  const mapa = {};
  mapa[CFG.SLACK_EMOJI.confirmar] = 'Confirmar';
  mapa[CFG.SLACK_EMOJI.ignorar]   = 'Ignorar';
  mapa[CFG.SLACK_EMOJI.revisar]   = 'Revisar';

  var bot = null;
  try {
    bot = slackApi_('auth.test', {}).user_id;
  } catch (e) {
    avisarErro_('Nao consegui autenticar no Slack para ler reacoes', e);
    return 0;
  }

  var gravadas = 0;

  filaPendente_().forEach(function (linha) {
    const ts = String(linha['Slack TS']);
    const resp = slackGet_('reactions.get', { channel: CFG.SLACK_CANAL_ID, timestamp: ts });
    if (!resp.ok || !resp.message || !resp.message.reactions) return;

    var decisao = null, quem = null;
    resp.message.reactions.forEach(function (r) {
      if (decisao || !mapa[r.name]) return;
      const humanos = (r.users || []).filter(function (u) { return u !== bot; });
      if (!humanos.length) return;
      decisao = mapa[r.name];
      quem = nomeUsuarioSlack_(humanos[0]);
    });
    if (!decisao) return;

    decidirFila_(linha['ID Alerta'], decisao, quem);
    gravadas++;

    try {
      slackApi_('chat.postMessage', {
        channel: CFG.SLACK_CANAL_ID, thread_ts: ts,
        text: ':pencil2: *' + decisao + '* registrado por ' + quem +
              ' - alerta ' + linha['ID Alerta'] + ' gravado na aba 05_FILA_VALIDACAO.'
      });
    } catch (e) {
      // a decisao ja esta na planilha; a confirmacao na thread e cosmetica
    }
  });

  return gravadas;
}

// ---------------------------------------------------------------- teste

/**
 * Posta um alerta de exemplo no canal e cria a linha correspondente na fila.
 * Use para conferir o layout e testar o fluxo: reagir -> coletarDecisoes_().
 * Nenhum documento e baixado e nenhuma fonte e acessada.
 */
function testarSlack() {
  const idAlerta = registrarFila_({
    entidade: 'TESTE - SINDSAUDE-BA',
    documento: 'teste_layout.pdf',
    parecerGemini: 'CCT (0.97)',
    parecerClaude: 'VALIDAR_ALERTA',
    divergencia: false
  });

  var empresas = null;
  try {
    empresas = empresasDoSindicato_('S01');
  } catch (e) {
    // se a aba de empresas nao estiver pronta, o alerta sobe sem esse bloco
  }

  const ts = enviarAlerta_({
    teste: true,   // nao marca ninguem em disparo de teste
    idAlerta: idAlerta, idFonte: 'F01', entidade: 'SINDSAUDE-BA',
    tipo: 'CCT', tipoAlteracao: 'TESTE (nada foi baixado)',
    gemini: {
      eh_instrumento_coletivo: true, tipo: 'CCT', sindicato_patronal: 'SINDHOSBA',
      vigencia_inicio: '2026-05-01', vigencia_fim: '2027-04-30', data_base: 'maio',
      reajuste_percentual: 5.2, piso_salarial: 0, confianca: 0.97,
      divergencia_cadastro: null
    },
    decisao: 'VALIDAR_ALERTA',
    justificativa: 'Mensagem de teste do layout. Nenhum documento real foi analisado.',
    linkDrive: 'https://drive.google.com/drive/folders/' + CFG.PASTA_DRIVE_ID,
    statusMte: 'Nao consultado (teste)', linkMte: CFG.MTE_URL_CONSULTA,
    empresas: empresas, linkEmpresas: ''
  });

  if (ts) gravarSlackTs_(idAlerta, ts);

  const msg = 'Alerta de teste ' + idAlerta + ' postado' +
              (ts ? ' (ts ' + ts + ').' : ' via webhook - sem ts, nao da para ler reacao.') +
              ' Reaja na mensagem e rode coletarDecisoes_().';
  Logger.log(msg);
  return msg;
}

/** Aviso de fonte quebrada. Silencio de uma fonte e incidente, nao e "sem novidade". */
function avisarErro_(assunto, erro) {
  try {
    // Fonte quebrada quebra de hora em hora. Sem trava sao 24 e-mails iguais por dia.
    // Manda 1 por dia por assunto; no dia seguinte volta a avisar se ainda estiver quebrada.
    const props = PropertiesService.getScriptProperties();
    const chave = ('AVISO_ERRO|' + assunto).slice(0, 100);
    const hoje = Utilities.formatDate(new Date(), CFG.FUSO, 'yyyy-MM-dd');
    if (props.getProperty(chave) === hoje) return;
    props.setProperty(chave, hoje);
    MailApp.sendEmail(CFG.EMAIL_ERROS, '[Monitor CCT] ' + assunto,assunto + '\n\n' + (erro && erro.stack ? erro.stack : erro) + '\n\n' + agora_());
  } catch (e) {
    Logger.log('Falhou ate o e-mail de erro: ' + e);
  }
}

// Wrapper publico: o editor do Apps Script nao lista funcoes com _ no fim.
function coletarDecisoes() {
  const n = coletarDecisoes_();
  const msg = n + ' decisao(oes) lida(s) das reacoes e gravada(s) na 05_FILA_VALIDACAO.';
  Logger.log(msg);
  return msg;
}

/**
 * O Slack recusa a mensagem inteira (invalid_blocks) por detalhe de formato:
 * secao com texto vazio, texto acima de 3000 caracteres, mais de 50 blocos.
 * Perder um alerta de CCT por causa disso e inaceitavel - entao o layout e
 * ajustado antes de sair, e o conteudo cortado fica no documento do Drive.
 */
function sanitizarBlocos_(blocos) {
  const LIMITE = { section: 2900, header: 140, context: 1900 };
  const ok = [];
  (blocos || []).forEach(function (b) {
    if (!b || !b.type) return;
    if (b.type === 'divider') { ok.push(b); return; }

    if (b.type === 'context') {
      const els = (b.elements || []).filter(function (e) { return e && String(e.text || '').trim(); })
        .slice(0, 10).map(function (e) {
          return Object.assign({}, e, { text: String(e.text).slice(0, LIMITE.context) }); });
      if (els.length) ok.push({ type: 'context', elements: els });
      return;
    }

    const t = b.text ? String(b.text.text || '') : '';
    if (!t.trim()) return;                       // secao vazia derruba a mensagem
    const max = LIMITE[b.type] || LIMITE.section;
    const corte = t.length > max ? t.slice(0, max - 20) + '\n_(...)_' : t;
    ok.push(Object.assign({}, b, { text: Object.assign({}, b.text, { text: corte }) }));
  });
  return ok.slice(0, 50);
}

/** Versao em texto puro do alerta, usada quando o Slack recusa o layout. */
function textoSimples_(dados) {
  const g = dados.gemini || {};
  return [
    'Documento: ' + (g.sindicato_laboral || dados.entidade || '-'),
    'Tipo: ' + (g.tipo || dados.tipo || '-') + '  |  ' + vigenciaTexto_(g),
    dados.linkDrive ? 'Arquivo: ' + dados.linkDrive : null,
    'Conferencia: ' + (dados.decisao || '-'),
    'Alerta ' + dados.idAlerta + ' - fonte ' + dados.idFonte
  ].filter(Boolean).join('\n').slice(0, 2900);
}