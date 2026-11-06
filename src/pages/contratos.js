// Contratos de manutenção: periodicidade, equipamentos, tarefas, técnico e hora preferidos.
// As folhas de cada visita são geradas automaticamente («Por agendar», com data e técnico sugeridos)
// «antecedência» dias antes da visita, quando o Master ou o backoffice abrem a plataforma.
// O valor do contrato fica em contratos/{id}/privado/valores (só o Master).
const sessao = await iniciarPagina({ perfis: ['master', 'backoffice'] });
const master = sessao.perfil === 'master';

let lista = [];
let cursor = null;
let atual = null;
let tecnicos = [];
carregarTecnicos().then((t) => { tecnicos = t; }).catch(() => {});

const eur = (v) => (Number(v) || 0).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
const fmtDia = (v) => v ? fmtData(v) : '—';
function aRenovar(c) { return c.dataFim && c.estado === 'Ativo' && paraData(c.dataFim) < addDias(new Date(), 60); }
function tokensContrato(c) {
  return tokensPesquisa(c.numero, String(c.numero || '').split('-').pop(), c.clienteNome, String(c.clienteNif || '').replace(/\D/g, ''), c.localidade,
    ...(c.equipamentos || []).flatMap((e) => [e.descricao, e.marca, e.serie])).slice(0, 400);
}

// ---------- Geração automática ----------
async function verGeracao(forcar = false) {
  const feitas = await gerarManutencoesPendentes({ forcar });
  const box = $('#cartaoGerar');
  if (feitas.length) {
    box.classList.remove('oculto');
    box.innerHTML = `<b>${feitas.length} folha${feitas.length > 1 ? 's' : ''} de manutenção gerada${feitas.length > 1 ? 's' : ''}</b>
      <p class="muted" style="margin:4px 0 0">Ficam «Por agendar» com a data e o técnico sugeridos: confirme em Folhas › «Agendar».</p>
      <p style="margin:6px 0 0">${feitas.map((f) => `<a href="${pagina('folhas', { id: f.id })}">${esc(f.numero)}</a>`).join(' · ')}</p>`;
    carregarLista();
  } else if (forcar) toast('Não há visitas por gerar.', 'ok');
}

// ---------- Lista ----------
$('#fEstado').onchange = () => carregarLista();
$('#fPesq').onsubmit = (ev) => { ev.preventDefault(); carregarLista(); };
$('#btnMais').onclick = () => comBotao($('#btnMais'), () => carregarLista(true));
$('#btnNovo').onclick = () => abrirForm(null);

async function carregarLista(mais = false) {
  if (!mais) { lista = []; cursor = null; $('#lista').innerHTML = '<div class="vazio">A carregar…</div>'; }
  const texto = $('#q').value.trim();
  const c = [where('estado', '==', $('#fEstado').value)];
  let palavras = [];
  if (texto) {
    palavras = normalizar(texto).split(/[^a-z0-9]+/).filter((p) => p.length >= 2).map((p) => p.slice(0, 15));
    if (palavras.length) c.push(where('pesquisa', 'array-contains', palavras.reduce((a, b) => (b.length > a.length ? b : a))));
  }
  c.push(orderBy(texto ? 'criadoEm' : 'proximaData', texto ? 'desc' : 'asc'));
  if (cursor) c.push(startAfter(cursor));
  c.push(limit(PAGINA_TAM));
  try {
    const snap = await getDocs(query(collection(db, 'contratos'), ...c));
    let novos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (palavras.length) novos = novos.filter((x) => palavras.every((p) => (x.pesquisa || []).includes(p)));
    lista = lista.concat(novos);
    cursor = snap.docs[snap.docs.length - 1] || cursor;
    $('#maisWrap').classList.toggle('oculto', snap.docs.length < PAGINA_TAM);
    $('#lista').innerHTML = lista.length ? lista.map((x) => `
      <a class="lista-item" href="${pagina('contratos', { id: x.id })}" data-id="${esc(x.id)}">
        <div class="li-topo"><span class="li-titulo">${esc(x.numero)} · ${esc(x.clienteNome)}</span>
          <span class="badge">${esc(x.periodicidade)}</span></div>
        <div class="li-sub">Próxima visita: <b>${esc(fmtDia(x.proximaData))}</b>${x.tecnicoNome ? ' · ' + esc(x.tecnicoNome) : ''}</div>
        <div class="li-meta">${(x.equipamentos || []).length} equipamento${(x.equipamentos || []).length === 1 ? '' : 's'}${x.localidade ? ' · ' + esc(x.localidade) : ''}
          ${aRenovar(x) ? ' · <span class="badge estado-pendente-material">Termina a ' + esc(fmtDia(x.dataFim)) + '</span>' : ''}</div>
      </a>`).join('') : `<div class="vazio">${texto ? 'Nenhum contrato encontrado.' : 'Sem contratos neste estado.'}</div>`;
  } catch (e) { $('#lista').innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
}
$('#lista').addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-id]');
  if (!a || ev.metaKey || ev.ctrlKey) return;
  ev.preventDefault();
  irPara({ id: a.dataset.id });
});
function irPara(params) { history.pushState({}, '', pagina('contratos', params)); rota(); }
window.addEventListener('popstate', rota);
function rota() {
  const p = new URLSearchParams(location.search);
  fecharModal();
  if (p.get('id')) { abrirDetalhe(p.get('id')); return; }
  $('#vDetalhe').classList.add('oculto');
  $('#vLista').classList.remove('oculto');
  if (!lista.length) carregarLista();
  if (p.get('novo')) abrirForm(null, p.get('cliente'));
}

// ---------- Detalhe ----------
async function abrirDetalhe(id) {
  $('#vLista').classList.add('oculto');
  const v = $('#vDetalhe');
  v.classList.remove('oculto');
  v.innerHTML = '<div class="vazio">A carregar…</div>';
  try {
    const s = await getDoc(doc(db, 'contratos', id));
    if (!s.exists()) { v.innerHTML = '<div class="vazio">Contrato não encontrado.</div>'; return; }
    atual = { id: s.id, ...s.data() };
    renderDetalhe();
  } catch (e) { v.innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
}
function renderDetalhe() {
  const c = atual;
  const v = $('#vDetalhe');
  v.innerHTML = `
    <button class="voltar" id="btnVoltar">‹ Contratos</button>
    <div class="cartao">
      <div class="det-cab"><div><h1 id="detNumero">${esc(c.numero)}</h1><span class="tipo">Manutenção ${esc(String(c.periodicidade).toLowerCase())}</span></div>
        <div style="text-align:right">${badgeEstadoContrato(c.estado)}<br><button class="btn btn-peq" id="btnEditar" style="margin-top:6px">Editar</button></div></div>
      ${aRenovar(c) ? `<p class="aviso-concl" style="margin-top:10px">O contrato termina a ${esc(fmtDia(c.dataFim))}${c.renovacaoAutomatica ? ' e renova automaticamente.' : '. Renove-o ou termine-o.'}</p>` : ''}
      <dl class="dl">
        <div><dt>Cliente</dt><dd>${esc(c.clienteNome)}${c.clienteNif ? `<br><span class="muted">NIF ${esc(c.clienteNif)}</span>` : ''}</dd></div>
        <div><dt>Local</dt><dd>${esc([c.morada, [c.codigoPostal, c.localidade].filter(Boolean).join(' ')].filter(Boolean).join('\n') || '—')}</dd></div>
        <div><dt>Contacto</dt><dd>${esc([c.contacto, c.telefone].filter(Boolean).join(' · ') || '—')}${c.clienteEmail ? `<br>${esc(c.clienteEmail)}` : ''}</dd></div>
        <div class="desc-destaque"><dt>Próxima visita</dt><dd id="detProxima">${esc(c.proximaData ? fmtDiaSemana(paraData(c.proximaData)) : '—')}, ${esc(c.horaPreferida || '09:00')}${c.duracaoPrevista ? ' · ' + esc(String(c.duracaoPrevista).replace('.', ',')) + ' h' : ''}${c.tecnicoNome ? ' · ' + esc(c.tecnicoNome) : ''}</dd></div>
        <div><dt>Folha gerada</dt><dd>${esc(String(c.antecedenciaDias ?? 30))} dias antes de cada visita (fica «Por agendar» para confirmar)</dd></div>
        <div><dt>Vigência</dt><dd>${esc(fmtDia(c.dataInicio))} a ${c.dataFim ? esc(fmtDia(c.dataFim)) + (c.renovacaoAutomatica ? ' (renova automaticamente)' : '') : 'sem fim'}</dd></div>
        ${c.ambito ? `<div><dt>Âmbito</dt><dd style="white-space:pre-wrap">${esc(c.ambito)}</dd></div>` : ''}
      </dl>
      <div id="valorContrato"></div>
    </div>
    <div class="cartao">
      <h3 style="margin-top:0">Equipamentos (${(c.equipamentos || []).length})</h3>
      ${(c.equipamentos || []).length ? `<ul class="hist">${c.equipamentos.map((e) => `<li><b>${esc(e.descricao)}</b><span>${esc([e.marca, e.local].filter(Boolean).join(' · '))}${e.serie ? `<br><span class="serie-tag">${esc(e.serie)}</span>` : ''}</span></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">Sem equipamentos registados.</p>'}
    </div>
    ${(c.tarefas || []).length ? `<div class="cartao"><h3 style="margin-top:0">Tarefas de cada visita</h3><ul class="hist">${c.tarefas.map((t) => `<li><span>☐ ${esc(t)}</span></li>`).join('')}</ul></div>` : ''}
    <div class="cartao">
      <h3 style="margin-top:0">Folhas geradas</h3>
      ${(c.folhas || []).length ? `<ul class="hist" id="folhasContrato">${c.folhas.map((f) => `<li><a href="${pagina('folhas', { id: f.folhaId })}"><b>${esc(f.numero)}</b></a><span>${esc(fmtData(f.data))}</span></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">Ainda nenhuma.</p>'}
      ${c.estado === 'Ativo' ? '<div class="acoes"><button class="btn" id="btnGerarJa">Gerar já a folha da próxima visita</button></div>' : ''}
    </div>
    <div class="cartao estados-acoes">
      ${c.estado === 'Ativo' ? '<button class="btn" id="btnSuspender">Suspender</button>' : ''}
      ${c.estado === 'Suspenso' ? '<button class="btn btn-primario" id="btnReativar">Reativar</button>' : ''}
      ${c.estado !== 'Terminado' ? '<button class="btn btn-perigo" id="btnTerminar">Terminar contrato</button>' : ''}
    </div>`;
  $('#btnVoltar').onclick = () => { if (history.state !== null && history.length > 1) history.back(); else irPara(null); };
  $('#btnEditar').onclick = () => abrirForm(atual);
  if ($('#btnGerarJa')) $('#btnGerarJa').onclick = () => comBotao($('#btnGerarJa'), async () => {
    if (!(await confirmar(`Gerar já a folha da visita de ${fmtDia(atual.proximaData)}?`, { ok: 'Gerar' }))) return;
    try {
      const r = await gerarVisitaContrato(atual.id, { forcar: true });
      if (r) { toast(`Folha ${r.numero} gerada («Por agendar»).`, 'ok', 5000); abrirDetalhe(atual.id); } else toast('Não foi possível gerar (contrato terminado ou já gerada).', 'erro');
    } catch (e) { toast(erroFirebase(e), 'erro'); }
  });
  if ($('#btnSuspender')) $('#btnSuspender').onclick = () => mudarEstadoContrato('Suspenso', $('#btnSuspender'));
  if ($('#btnReativar')) $('#btnReativar').onclick = () => mudarEstadoContrato('Ativo', $('#btnReativar'));
  if ($('#btnTerminar')) $('#btnTerminar').onclick = () => mudarEstadoContrato('Terminado', $('#btnTerminar'));
  if (master) mostrarValor();
  window.scrollTo(0, 0);
}
function badgeEstadoContrato(e) {
  const cls = e === 'Ativo' ? 'estado-concluida' : e === 'Suspenso' ? 'estado-pendente' : 'estado-faturada';
  return `<span class="badge ${cls}" id="detEstado">${esc(e)}</span>`;
}
async function mostrarValor() {
  try {
    const s = await getDoc(doc(db, 'contratos', atual.id, 'privado', 'valores'));
    const v = s.exists() ? s.data() : {};
    const n = 12 / (PERIODICIDADES[atual.periodicidade] || 12);
    $('#valorContrato').innerHTML = v.valorAnual ? `<p class="ok-at" style="margin:10px 0 0" id="valorAnual">Valor anual <b>${esc(eur(v.valorAnual))}</b> s/IVA · ${n} visitas/ano · ${esc(eur(v.valorAnual / n))} por visita <span class="muted">(só o Master vê)</span></p>` : '';
  } catch (e) { /* sem valor */ }
}
async function mudarEstadoContrato(novo, btn) {
  const msg = { Suspenso: 'Suspender o contrato? Deixam de ser geradas folhas até o reativar.', Ativo: 'Reativar o contrato?', Terminado: 'Terminar o contrato? Deixam de ser geradas folhas.' }[novo];
  if (!(await confirmar(msg, { ok: novo === 'Ativo' ? 'Reativar' : novo === 'Suspenso' ? 'Suspender' : 'Terminar', perigo: novo === 'Terminado' }))) return;
  await comBotao(btn, async () => {
    try {
      const alt = { estado: novo, atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid };
      // ao reativar, a próxima visita não pode ficar no passado
      if (novo === 'Ativo' && atual.proximaData && paraData(atual.proximaData) < inicioDia(new Date())) {
        let p = paraData(atual.proximaData);
        while (p < inicioDia(new Date())) p = addMeses(p, PERIODICIDADES[atual.periodicidade] || 12);
        alt.proximaData = Timestamp.fromDate(p);
        alt.geracaoEm = Timestamp.fromDate(dataGeracao(p, atual.antecedenciaDias));
      }
      await updateDoc(doc(db, 'contratos', atual.id), alt);
      toast('Contrato ' + novo.toLowerCase() + '.', 'ok');
      lista = [];
      abrirDetalhe(atual.id);
    } catch (e) { toast(erroFirebase(e), 'erro'); }
  });
}

// ---------- Formulário ----------
async function abrirForm(ct, clienteIdInicial) {
  const ed = !!ct;
  let cliente = ed ? { id: ct.clienteId, nome: ct.clienteNome, nif: ct.clienteNif, email: ct.clienteEmail, morada: ct.morada, codigoPostal: ct.codigoPostal, localidade: ct.localidade, contacto: ct.contacto, telefone: ct.telefone } : null;
  if (!cliente && clienteIdInicial) {
    try { const s = await getDoc(doc(db, 'clientes', clienteIdInicial)); if (s.exists()) cliente = { id: s.id, ...s.data() }; } catch (e) { /* ignora */ }
  }
  let valorAnual = '';
  if (ed && master) { try { const s = await getDoc(doc(db, 'contratos', ct.id, 'privado', 'valores')); if (s.exists()) valorAnual = s.data().valorAnual || ''; } catch (e) { /* */ } }
  if (!tecnicos.length) tecnicos = await carregarTecnicos().catch(() => []);
  const equip = (ct?.equipamentos || []).map((e) => ({ ...e }));
  const hoje = isoLocal(new Date());
  const c = abrirModal(ed ? 'Editar contrato' : 'Novo contrato de manutenção', `
    <div class="campo"><span>Cliente *</span><div id="cCliente"></div></div>
    <div class="grelha-2">
      <label class="campo"><span>Periodicidade *</span><select id="cPer">${Object.keys(PERIODICIDADES).map((p) => `<option ${ct?.periodicidade === p || (!ct && p === 'Trimestral') ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <label class="campo"><span>Próxima visita *</span><input type="date" id="cProx" value="${ct?.proximaData ? isoLocal(paraData(ct.proximaData)) : hoje}"></label>
    </div>
    <div class="grelha-2">
      <label class="campo"><span>Hora preferida</span><input type="time" id="cHora" value="${esc(ct?.horaPreferida || '09:00')}"></label>
      <label class="campo"><span>Duração prevista (h)</span><input type="number" id="cDur" min="0" step="0.5" inputmode="decimal" value="${esc(String(ct?.duracaoPrevista ?? 2))}"></label>
    </div>
    <div class="grelha-2">
      <label class="campo"><span>Técnico habitual</span><select id="cTec"><option value="">— por atribuir —</option>${tecnicos.map((t) => `<option value="${esc(t.uid)}" ${ct?.tecnicoUid === t.uid ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></label>
      <label class="campo"><span>Gerar a folha (dias antes)</span><input type="number" id="cAnt" min="0" max="120" value="${esc(String(ct?.antecedenciaDias ?? 30))}"></label>
    </div>
    <div class="grelha-2">
      <label class="campo"><span>Início *</span><input type="date" id="cIni" value="${ct?.dataInicio ? isoLocal(paraData(ct.dataInicio)) : hoje}"></label>
      <label class="campo"><span>Fim</span><input type="date" id="cFim" value="${ct?.dataFim ? isoLocal(paraData(ct.dataFim)) : ''}"></label>
    </div>
    <label class="campo" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="cRen" style="width:auto;min-height:0" ${ct?.renovacaoAutomatica !== false ? 'checked' : ''}><span style="margin:0">Renova automaticamente por mais um ano</span></label>
    <label class="campo"><span>Email do cliente (avisos e relatórios)</span><input type="email" id="cEmail" inputmode="email" autocomplete="off" value="${esc(ct?.clienteEmail || cliente?.email || '')}"></label>
    <label class="campo"><span>Âmbito do contrato</span><textarea id="cAmb" placeholder="Ex.: limpeza de filtros, verificação de pressões e drenagens, relatório">${esc(ct?.ambito || '')}</textarea></label>
    <div class="campo"><span>Equipamentos</span><div id="cEquip"></div><button type="button" class="btn btn-peq" id="cMaisEq" style="margin-top:6px">+ Equipamento</button></div>
    <label class="campo"><span>Tarefas de cada visita (uma por linha)</span><textarea id="cTar" placeholder="Limpeza de filtros\nVerificação de pressões\nLimpeza de condensadores">${esc((ct?.tarefas || []).join('\n'))}</textarea></label>
    ${master ? `<label class="campo"><span>Valor anual (€, s/IVA) — só o Master vê</span><input type="number" id="cValor" min="0" step="0.01" inputmode="decimal" value="${esc(String(valorAnual))}"></label>` : ''}
    <div class="msg-erro" id="cErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="cGuardar">Guardar</button></div>`);
  const desenharCliente = () => {
    $('#cCliente', c).innerHTML = cliente
      ? `<div class="cliente-escolhido"><b>${esc(cliente.nome)}</b><br><span class="muted">${esc([cliente.morada, cliente.codigoPostal, cliente.localidade].filter(Boolean).join(', '))}</span>${ed ? '' : ' <button type="button" class="btn btn-peq" id="cTrocar">Trocar</button>'}</div>`
      : `<div style="display:flex;gap:8px"><input id="cCliProc" placeholder="Nome, NIF ou localidade" autocomplete="off"><button type="button" class="btn" id="cCliBtn">Procurar</button></div><div id="cCliRes"></div>`;
    if ($('#cTrocar', c)) $('#cTrocar', c).onclick = () => { cliente = null; desenharCliente(); };
    if ($('#cCliBtn', c)) $('#cCliBtn', c).onclick = () => comBotao($('#cCliBtn', c), async () => {
      const l = await pesquisarClientes($('#cCliProc', c).value, { soAtivos: true }).catch((e) => { toast(erroFirebase(e), 'erro'); return []; });
      $('#cCliRes', c).innerHTML = l.map((x, i) => `<button type="button" class="artigo-op" data-c="${i}"><b>${esc(x.nome)}</b> <span class="muted">${esc(x.localidade || '')}</span></button>`).join('') || '<p class="muted">Nenhum cliente.</p>';
      $$('[data-c]', c).forEach((b) => b.onclick = () => {
        cliente = l[+b.dataset.c];
        if (!$('#cEmail', c).value) $('#cEmail', c).value = cliente.email || '';
        desenharCliente();
      });
    });
  };
  desenharCliente();
  const lerEquip = () => $$('[data-eq]', c).forEach((row) => {
    const i = +row.dataset.eq;
    for (const k of ['descricao', 'marca', 'serie', 'local']) equip[i][k] = $(`[data-k="${k}"]`, row).value.trim();
  });
  const desenharEquip = () => {
    $('#cEquip', c).innerHTML = equip.map((e, i) => `<div class="equip-linha" data-eq="${i}">
      <input data-k="descricao" placeholder="Equipamento * (ex.: Split Daikin 3,5 kW)" value="${esc(e.descricao || '')}">
      <div class="grelha-2"><input data-k="marca" placeholder="Marca / modelo" value="${esc(e.marca || '')}"><input data-k="serie" placeholder="N.º de série" value="${esc(e.serie || '')}"></div>
      <div style="display:flex;gap:8px"><input data-k="local" placeholder="Localização (ex.: sala de reuniões)" value="${esc(e.local || '')}"><button type="button" class="lixo" data-xeq="${i}" aria-label="Tirar">✕</button></div>
    </div>`).join('') || '<p class="muted" style="margin:0">Sem equipamentos.</p>';
    $$('[data-xeq]', c).forEach((b) => b.onclick = () => { lerEquip(); equip.splice(+b.dataset.xeq, 1); desenharEquip(); });
  };
  desenharEquip();
  $('#cMaisEq', c).onclick = () => { lerEquip(); equip.push({ id: Date.now().toString(36) + equip.length }); desenharEquip(); };
  $('#cGuardar', c).onclick = () => {
    const erro = (m) => { $('#cErro', c).textContent = m; };
    lerEquip();
    if (!cliente) return erro('Escolha o cliente.');
    const per = $('#cPer', c).value;
    if (!$('#cProx', c).value) return erro('Indique a data da próxima visita.');
    if (!$('#cIni', c).value) return erro('Indique o início do contrato.');
    const prox = deIsoLocal($('#cProx', c).value);
    const ini = deIsoLocal($('#cIni', c).value);
    const fim = $('#cFim', c).value ? deIsoLocal($('#cFim', c).value) : null;
    if (fim && fim < ini) return erro('O fim do contrato não pode ser antes do início.');
    if (prox < ini) return erro('A próxima visita não pode ser antes do início do contrato.');
    const email = $('#cEmail', c).value.trim();
    if (email && !/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(email)) return erro('Email inválido.');
    const eqs = equip.filter((e) => e.descricao || e.marca || e.serie);
    if (eqs.some((e) => !e.descricao)) return erro('Indique a descrição de cada equipamento.');
    const ant = Math.max(0, Math.min(120, Math.round(Number($('#cAnt', c).value) || 0)));
    const tecUid = $('#cTec', c).value;
    const dados = {
      clienteId: cliente.id, clienteNome: cliente.nome, clienteNif: cliente.nif || '', clienteEmail: email,
      morada: cliente.morada || '', codigoPostal: cliente.codigoPostal || '', localidade: cliente.localidade || '', contacto: cliente.contacto || '', telefone: cliente.telefone || '',
      periodicidade: per, proximaData: Timestamp.fromDate(prox), geracaoEm: Timestamp.fromDate(dataGeracao(prox, ant)), antecedenciaDias: ant,
      horaPreferida: $('#cHora', c).value || '09:00', duracaoPrevista: Math.max(0, Number(String($('#cDur', c).value).replace(',', '.')) || 0),
      tecnicoUid: tecUid, tecnicoNome: tecUid ? ((tecnicos.find((t) => t.uid === tecUid) || {}).nome || '') : '',
      dataInicio: Timestamp.fromDate(ini), dataFim: fim ? Timestamp.fromDate(fim) : null, renovacaoAutomatica: $('#cRen', c).checked,
      ambito: $('#cAmb', c).value.trim(), equipamentos: eqs.map((e, i) => ({ id: e.id || String(i), descricao: e.descricao, marca: e.marca || '', serie: e.serie || '', local: e.local || '' })),
      tarefas: $('#cTar', c).value.split(/\r?\n/).map((t) => t.trim()).filter(Boolean).slice(0, 30),
      atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid,
    };
    const valor = master ? Number(String($('#cValor', c).value).replace(',', '.')) || 0 : null;
    comBotao($('#cGuardar', c), async () => {
      try {
        let id = ct?.id;
        if (ed) {
          dados.pesquisa = tokensContrato({ ...dados, numero: ct.numero });
          await updateDoc(doc(db, 'contratos', id), dados);
        } else {
          const ano = new Date().getFullYear();
          const cRef = doc(db, 'contadores', 'contratos-' + ano);
          const ref = doc(collection(db, 'contratos'));
          id = ref.id;
          await runTransaction(db, async (tx) => {
            const s = await tx.get(cRef);
            const n = (s.exists() ? s.data().valor : 0) + 1;
            const numero = `CM-${ano}-${String(n).padStart(3, '0')}`;
            tx.set(cRef, { valor: n });
            tx.set(ref, { ...dados, numero, estado: 'Ativo', folhas: [], pesquisa: tokensContrato({ ...dados, numero }), criadoEm: serverTimestamp(), criadoPor: sessao.uid, criadoPorNome: sessao.nome || sessao.email });
          });
        }
        if (master && valor !== null) await setDoc(doc(db, 'contratos', id, 'privado', 'valores'), { valorAnual: valor, atualizadoEm: serverTimestamp() });
        fecharModal();
        toast('Contrato guardado.', 'ok');
        lista = [];
        if (ed) abrirDetalhe(id);
        else { history.replaceState({}, '', pagina('contratos', { id })); abrirDetalhe(id); }
        // se a próxima visita já está dentro da antecedência, gera logo a folha
        if (dataGeracao(prox, ant) <= new Date()) {
          const r = await gerarVisitaContrato(id).catch(() => null);
          if (r) { toast(`Folha ${r.numero} gerada para a próxima visita («Por agendar»).`, 'ok', 6000); abrirDetalhe(id); }
        }
      } catch (e) { erro(erroFirebase(e)); }
    });
  };
}

rota();
verGeracao();
