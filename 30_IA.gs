/**
 * 30_IA.gs  |  Camada 2: Gemini classifica, Claude audita.
 * Só é chamada quando o coletor detectou mudança. É o que mantém o custo baixo.
 */

const SCHEMA_GEMINI = {
  type: 'OBJECT',
  properties: {
    eh_instrumento_coletivo: { type: 'BOOLEAN' },
    tipo: { type: 'STRING', enum: ['CCT','ACT','TERMO_ADITIVO','MINUTA','PAUTA','COMUNICADO','OUTRO'] },
    sindicato_laboral: { type: 'STRING', nullable: true },
    sindicato_patronal: { type: 'STRING', nullable: true },
    uf: { type: 'STRING', nullable: true },
    municipios_abrangidos: { type: 'ARRAY', items: { type: 'STRING' } },
    vigencia_inicio: { type: 'STRING', nullable: true },
    vigencia_fim: { type: 'STRING', nullable: true },
    data_base: { type: 'STRING', nullable: true },
    reajuste_percentual: { type: 'NUMBER', nullable: true },
    piso_salarial: { type: 'NUMBER', nullable: true },
    pisos: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      funcao:     { type: 'STRING' },
      valor:      { type: 'NUMBER', nullable: true },
      observacao: { type: 'STRING', nullable: true }
    } } },
    numero_registro_mte: { type: 'STRING', nullable: true },
    documento_assinado: { type: 'BOOLEAN' },
    divergencia_cadastro: { type: 'STRING', nullable: true },
    confianca: { type: 'NUMBER' }
  },
  required: ['eh_instrumento_coletivo','tipo','confianca']
};


function promptGemini_(entidades) {
  const e = entidades[0] || {};
  const outras = entidades.slice(1).map(function (x) { return x['Sigla correta']; }).join(', ');

  return [
    'Você é analista de relações trabalhistas. Recebe um documento detectado automaticamente',
    'no site de um sindicato e deve classificá-lo.',
    '',
    'CONTEXTO DO CADASTRO',
    'Entidade monitorada: ' + (e['Sigla correta'] || '?') + ' — ' + (e['Nome completo confirmado'] || ''),
    'Contraparte esperada: ' + (e['Patronal (base)'] || '?'),
    'UF esperada: ' + (e['UF'] || '?'),
    'Data-base cadastrada: ' + (e['Data-base'] || '?'),
    'Última CCT conhecida: vigência até ' + (e['Vigência última CCT'] || 'não informada'),
    outras ? 'Esta fonte também publica documentos de: ' + outras : '',
    '',
    'TAREFA',
    '1. Determine se o documento é um instrumento coletivo.',
    '2. Se for, extraia os metadados.',
    '3. Se a UF ou as partes não baterem com o cadastro, preencha divergencia_cadastro.',
    '',
    'REGRAS',
    'Campo não encontrado no documento = null. Nunca invente valor.',
    'Piso salarial: a maioria das convenções tem VÁRIAS faixas por função. Liste TODAS em',
    'pisos, uma por faixa (funcao + valor). Quando a faixa for livre negociação, deixe valor',
    'null e escreva isso em observacao. Em piso_salarial repita apenas o MENOR valor.',
    'municipios_abrangidos: liste os municípios da base territorial se o documento trouxer.',
    'Datas no formato AAAA-MM-DD. Percentual como número (5.2, não "5,2%").',
    'Confiança abaixo de 0.80 quando o documento estiver ilegível, cortado ou for minuta.',
    'Minuta, pauta de reivindicações e comunicado NÃO são instrumento coletivo.'
  ].filter(String).join('\n');
}


/**
 * Chama o Gemini tentando os modelos da lista em ordem.
 *
 * O Google aposenta modelo sem aviso previo - aconteceu com o gemini-2.5-flash
 * em 18/08/2026 e o robo ficou cego ate alguem trocar o nome na mao. Aqui ele
 * cai para o proximo sozinho, guarda qual funcionou e avisa uma unica vez.
 */
function chamarGemini_(corpo) {
  const chave = segredo_('GEMINI_API_KEY');
  const lista = modelosGemini_();
  var ultimoErro = '';
  var caiuParaReserva = false;

  for (var i = 0; i < lista.length; i++) {
    for (var t = 0; t < 3; t++) {
      var r, codigo;
      try {
        r = UrlFetchApp.fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' +
          lista[i] + ':generateContent?key=' + chave,
          { method: 'post', contentType: 'application/json',
            payload: JSON.stringify(corpo), muteHttpExceptions: true });
        codigo = r.getResponseCode();
      } catch (eRede) {
        // Timeout ou DNS: a chamada nem chegou a ter resposta HTTP. Mesmo
        // tratamento do 503 - espera, tenta de novo e depois cai para a reserva.
        ultimoErro = 'Gemini rede: ' + String(eRede).slice(0, 200);
        if (t < 2) { Utilities.sleep(t === 0 ? 3000 : 8000); continue; }
        caiuParaReserva = true; break;
      }

      if (codigo === 200) {
        if (caiuParaReserva) avisarTrocaDeModelo_(lista[i], lista.slice(0, i), ultimoErro);
        return JSON.parse(r.getContentText());
      }

      ultimoErro = 'Gemini ' + codigo + ': ' + r.getContentText().slice(0, 300);

      // 429 e 5xx sao passageiros (pico de demanda, fila cheia). Espera e insiste
      // no MESMO modelo. Se as 3 tentativas falharem, o proximo da fila assume -
      // um modelo menos disputado costuma responder quando o principal esta cheio.
      if (codigo === 429 || codigo >= 500) {
        if (t < 2) { Utilities.sleep(t === 0 ? 3000 : 8000); continue; }
        caiuParaReserva = true;
        break;
      }

      // 404 = modelo aposentado de vez. Fica marcado para nao ser tentado de novo.
      if (codigo === 404) { marcarModeloMorto_(lista[i]); caiuParaReserva = true; break; }

      // 400, 401, 403: payload, chave ou permissao. Insistir so atrasa a rodada.
      throw new Error(ultimoErro);
    }
  }
  // Fila inteira fora do ar. Isso NAO e erro do robo: o documento ainda nao foi
  // marcado como visto, entao a proxima rodada tenta de novo sozinha. Quem trata
  // e o rodarMonitor, olhando esta marca.
  const falha = new Error('Nenhum modelo Gemini respondeu. Ultimo erro - ' + ultimoErro);
  falha.geminiIndisponivel = /Gemini (429|5\d\d|rede)/.test(ultimoErro);
  throw falha;
}

/**
 * Fila de tentativa: o modelo da configuracao primeiro, depois as reservas.
 * Quem ja devolveu 404 fica de fora - nao adianta insistir em modelo aposentado.
 * A configuracao SEMPRE manda: nenhuma preferencia guardada sobrepoe o 00_Config.
 */
function modelosGemini_() {
  const mortos = (PropertiesService.getScriptProperties()
                    .getProperty('GEMINI_MODELOS_MORTOS') || '').split(',');
  const fila = [CFG.GEMINI_MODELO].concat(CFG.GEMINI_MODELOS_RESERVA || [])
                 .filter(function (m, i, a) { return m && a.indexOf(m) === i; });
  const vivos = fila.filter(function (m) { return mortos.indexOf(m) < 0; });
  return vivos.length ? vivos : fila;   // todos marcados: tenta tudo de novo
}

/** Marca modelo aposentado para nao gastar chamada com ele nas proximas rodadas. */
function marcarModeloMorto_(modelo) {
  const props = PropertiesService.getScriptProperties();
  const lista = (props.getProperty('GEMINI_MODELOS_MORTOS') || '').split(',').filter(String);
  if (lista.indexOf(modelo) > -1) return;
  lista.push(modelo);
  props.setProperty('GEMINI_MODELOS_MORTOS', lista.join(','));
}

/**
 * Avisa quando o robo trocou de modelo sozinho. So no Slack.
 *
 * Nao manda e-mail: e-mail e para o que PARA o robo. Troca de modelo e o
 * contrario disso - e o robo se virando sozinho. E avisa uma vez por dia por
 * modelo, senao repete a cada rodada enquanto a cota nao virar.
 */
function avisarTrocaDeModelo_(novo, descartados, erro) {
  const props = PropertiesService.getScriptProperties();
  const hoje = Utilities.formatDate(new Date(), CFG.FUSO, 'yyyy-MM-dd');
  const marca = novo + '|' + hoje;
  if (props.getProperty('AVISO_MODELO') === marca) return;
  props.setProperty('AVISO_MODELO', marca);

  const m = ':arrows_counterclockwise: *Modelo de IA trocado automaticamente*\n' +
            'Passou a usar `' + novo + '`.\n' +
            'Nao respondeu: ' + descartados.join(', ') + '\n' +
            'Erro: ' + String(erro).slice(0, 200) + '\n' +
            'Se persistir, atualize CFG.GEMINI_MODELO no 00_Config.gs.';
  try { slackApi_('chat.postMessage', { channel: CFG.SLACK_CANAL_ID, text: m }); } catch (e) {}
}
/**
 * Tira o texto da resposta do Gemini.
 *
 * Quando o filtro de conteudo bloqueia o PDF, ou a resposta estoura o limite de
 * tokens, a API devolve 200 SEM o campo candidates. O codigo antigo fazia
 * resp.candidates[0] direto e quebrava com "Cannot read properties of undefined".
 * Devolve null e o motivo em vez de estourar.
 */
function textoDaResposta_(resp) {
  const c = (resp && resp.candidates) ? resp.candidates[0] : null;
  const p = (c && c.content && c.content.parts) ? c.content.parts[0] : null;
  if (p && p.text) return { texto: p.text, motivo: null };
  const motivo = (c && c.finishReason) ||
                 (resp && resp.promptFeedback && resp.promptFeedback.blockReason) ||
                 'resposta vazia';
  return { texto: null, motivo: String(motivo) };
}

/** Chama o Gemini com o PDF e saida estruturada obrigatoria. */
function classificarComGemini_(blob, entidades) {
  const resp = chamarGemini_({
    contents: [{
      role: 'user',
      parts: [
        { text: promptGemini_(entidades) },
        { inline_data: { mime_type: 'application/pdf', data: Utilities.base64Encode(blob.getBytes()) } }
      ]
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA_GEMINI
    }
  });

  const r = textoDaResposta_(resp);

  // REGRA DE OURO: falso negativo e pior que falso positivo. Se a IA nao leu o
  // documento, o alerta sobe assim mesmo, marcado como INDETERMINADO e com
  // confianca zero - quem decide e o humano, nunca o silencio.
  if (!r.texto) {
    return { eh_instrumento_coletivo: true, tipo: 'INDETERMINADO', confianca: 0,
             municipios_abrangidos: [],
             divergencia_cadastro: 'A IA nao conseguiu ler este documento (' + r.motivo +
                                   '). Abrir o arquivo e conferir na mao.' };
  }
  // O Gemini as vezes corta a resposta no meio (limite de tokens) e o JSON chega
  // pela metade. Sem isto o SyntaxError derruba a rodada e o documento fica sem
  // leitura nenhuma. Regra de ouro: na duvida o alerta sobe, marcado INDETERMINADO.
  try {
    return JSON.parse(r.texto);
  } catch (e) {
    return { eh_instrumento_coletivo: true, tipo: 'INDETERMINADO', confianca: 0,
             municipios_abrangidos: [],
             divergencia_cadastro: 'A IA devolveu resposta truncada e ilegivel (' +
                                   String(e).slice(0, 120) + '). Abrir o arquivo e conferir na mao.' };
  }
}

// ---------------------------------------------------------------- auditoria

function promptAuditor_(gemini, entidades) {
  const e = entidades[0] || {};

  return [
    'Você é auditor de um monitor de convenções coletivas. NÃO é o detector.',
    'Sua função é decidir se o alerta sobe para o time fiscal/DP.',
    '',
    'CADASTRO DA ENTIDADE',
    JSON.stringify({
      sigla: e['Sigla correta'], nome: e['Nome completo confirmado'],
      patronal: e['Patronal (base)'], uf: e['UF'], data_base: e['Data-base'],
      ultima_cct_ate: e['Vigência última CCT'], prioridade: e['Prioridade']
    }),
    '',
    'SAÍDA DO PRIMEIRO CLASSIFICADOR',
    JSON.stringify(gemini),
    '',
    'DECIDA',
    'VALIDAR_ALERTA  - é instrumento coletivo novo e relevante para esta entidade',
    'NAO_ALERTAR     - é minuta, pauta, comunicado, documento repetido ou de outra UF/entidade',
    'ESCALAR_HUMANO  - há divergência que você não consegue resolver',
    '',
    'CRITÉRIO ASSIMÉTRICO OBRIGATÓRIO',
    'Deixar passar uma CCT real é muito pior do que gerar um alerta desnecessário.',
    'Na dúvida entre NAO_ALERTAR e ESCALAR_HUMANO, escolha ESCALAR_HUMANO.',
    'Só use NAO_ALERTAR quando tiver certeza.',
    '',
    'VERIFIQUE EXPLICITAMENTE',
    '- A UF do documento é a esperada?',
    '- As partes batem com laboral e patronal cadastrados?',
    '- A vigência é posterior à última CCT conhecida?',
    '- É apenas uma reassinatura do mesmo documento?',
    '',
    'Responda SOMENTE com JSON no formato:',
    '{"decisao":"...","concorda_com_gemini":true,"tipo_confirmado":"...",',
    '"e_documento_novo":true,"mudancas_vs_anterior":["..."],"inconsistencias":["..."],',
    '"justificativa":"máximo 3 linhas","confianca":0.0}'
  ].join('\n');
}


/** Auditoria pelo Claude. Recebe o PDF e o parecer do Gemini. */
function auditarComClaude_(blob, gemini, entidades) {
  const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': segredo_('CLAUDE_API_KEY'), 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: CFG.CLAUDE_MODELO,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'document',
            source: { type: 'base64', media_type: 'application/pdf',
                      data: Utilities.base64Encode(blob.getBytes()) } },
          { type: 'text', text: promptAuditor_(gemini, entidades) }
        ]
      }]
    })
  });

  if (r.getResponseCode() !== 200) {
    throw new Error('Claude ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  }

  const texto = JSON.parse(r.getContentText()).content[0].text;
  return JSON.parse(texto.replace(/```json|```/g, '').trim());
}


/** Auditoria alternativa sem custo: segunda passada no Gemini com o papel de auditor. */
function auditarComGemini_(gemini, entidades) {
  const resp = chamarGemini_({
    contents: [{ role: 'user', parts: [{ text: promptAuditor_(gemini, entidades) }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  });
  const r = textoDaResposta_(resp);
  if (!r.texto) throw new Error('Gemini auditor sem conteudo (' + r.motivo + ')');
  return JSON.parse(r.texto);
}


/**
 * Escolhe o auditor.
 *   USAR_CLAUDE = false            -> sempre Gemini (custo zero, sem chave da Anthropic)
 *   USAR_CLAUDE + SOMENTE_P1 true  -> Claude no P1, Gemini no resto
 *   USAR_CLAUDE + SOMENTE_P1 false -> Claude em tudo
 */
function auditar_(blob, gemini, entidades) {
  const p1 = entidades.some(function (e) { return e['Prioridade'] === 'P1'; });
  const usarClaude = CFG.USAR_CLAUDE && (p1 || !CFG.CLAUDE_SOMENTE_P1);

  try {
    if (usarClaude) return auditarComClaude_(blob, gemini, entidades);
    return auditarComGemini_(gemini, entidades);
  } catch (e) {
    // REGRA DE OURO: se o auditor falhar, o alerta sobe assim mesmo.
    return { decisao: 'ESCALAR_HUMANO', concorda_com_gemini: null,
             justificativa: 'Auditor indisponível (' + e.message + '). Escalando por precaução.',
             confianca: 0 };
  }
}
