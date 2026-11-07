const sessao = await iniciarPagina({ perfis: ['master', 'backoffice', 'tecnico'] });
const staff = ehStaff(sessao.perfil);
const tecnico = sessao.perfil === 'tecnico';

let lista = [];            // folhas carregadas (cache da lista para não reler ao voltar do detalhe)
let cursor = null;
let listaCarregada = false;
let atual = null;          // folha aberta no detalhe

// ---------- Filtros ----------
$('#fEstado').insertAdjacentHTML('beforeend', `<option value="antigas">Antigas (+${DIAS_ATRASO} dias)</option>`
  + ESTADOS.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join(''));
if (new URLSearchParams(location.search).get('filtro') === 'antigas') $('#fEstado').value = 'antigas';
const selecionadas = new Set();
if (tecnico) $('#tituloLista').textContent = 'As minhas folhas';
if (staff) {
  $('#btnNova').classList.remove('oculto');
  $('#btnSincPHC').classList.remove('oculto');
  $('#btnSincPHC').onclick = () => pedirSincronizacao($('#btnSincPHC'), () => carregarLista());
  $('#fTec').classList.remove('oculto');
  carregarTecnicos().then((tecs) => {
    $('#fTec').insertAdjacentHTML('beforeend', tecs.map((t) => `<option value="${esc(t.uid)}">${esc(t.nome)}</option>`).join(''));
  }).catch((e) => toast(erroFirebase(e), 'erro'));
}
$('#fEstado').onchange = () => carregarLista();
$('#fTec').onchange = () => carregarLista();
$('#btnNova').onclick = () => abrirForm(null);
$('#btnMais').onclick = () => comBotao($('#btnMais'), () => carregarLista(true));

// Pesquisa: n.º da folha (exato) ou cliente, NIF e descrição da avaria (palavras, pelos prefixos guardados em «pesquisa»).
$('#fPesq').onsubmit = async (ev) => {
  ev.preventDefault();
  const texto = $('#pNum').value.trim();
  if (!texto) { carregarLista(); return; }
  let v = texto.toUpperCase();
  const base = tecnico ? [where('tecnicoUid', '==', sessao.uid)] : [];
  try {
    let docs = [];
    if (/^\d{1,5}$/.test(v) || /^\d{4}-\d+$/.test(v) || /^FO-\d{4}-\d+$/.test(v)) {
      if (/^\d{1,5}$/.test(v)) v = `FO-${new Date().getFullYear()}-${v.padStart(4, '0')}`;
      else if (/^\d{4}-\d+$/.test(v)) { const [an, n] = v.split('-'); v = `FO-${an}-${n.padStart(4, '0')}`; }
      else { const [, an, n] = v.split('-'); v = `FO-${an}-${n.padStart(4, '0')}`; }
      docs = (await getDocs(query(collection(db, 'folhas'), ...base, where('numero', '==', v), limit(5)))).docs;
    }
    if (!docs.length) {
      const palavras = normalizar(texto).split(/[^a-z0-9]+/).filter((p) => p.length >= 2).map((p) => p.slice(0, 15));
      if (!palavras.length) { toast('Escreva pelo menos 2 letras ou números.', 'erro'); return; }
      const chave = palavras.reduce((x, y) => (y.length > x.length ? y : x));
      const snap = await getDocs(query(collection(db, 'folhas'), ...base, where('pesquisa', 'array-contains', chave), orderBy('criadoEm', 'desc'), limit(PAGINA_TAM)));
      docs = snap.docs.filter((d) => palavras.every((p) => (d.data().pesquisa || []).includes(p)));
    }
    lista = docs.map((d) => ({ id: d.id, ...d.data() }));
    cursor = null;
    $('#maisWrap').classList.add('oculto');
    renderLista(`Nenhuma folha encontrada para «${texto}».`);
  } catch (e) { toast(erroFirebase(e), 'erro'); }
};

// ---------- Lista ----------
function consultaLista() {
  const c = [];
  const est = $('#fEstado').value;
  if (tecnico) c.push(where('tecnicoUid', '==', sessao.uid));
  else if ($('#fTec').value) c.push(where('tecnicoUid', '==', $('#fTec').value));
  if (est === 'antigas') {
    c.push(where('estado', 'in', ESTADOS_ABERTOS), where('dataPrevista', '<', Timestamp.fromDate(addDias(inicioDia(new Date()), -DIAS_ATRASO))), orderBy('dataPrevista'));
  } else {
    if (est === 'abertas') c.push(where('estado', 'in', ESTADOS_ABERTOS));
    else if (est) c.push(where('estado', '==', est));
    c.push(orderBy('criadoEm', 'desc'));
  }
  if (cursor) c.push(startAfter(cursor));
  c.push(limit(PAGINA_TAM));
  return query(collection(db, 'folhas'), ...c);
}

async function carregarLista(mais = false) {
  if (!mais) { lista = []; cursor = null; selecionadas.clear(); $('#lista').innerHTML = '<div class="vazio">A carregar…</div>'; }
  try {
    const snap = await getDocs(consultaLista());
    lista = lista.concat(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    cursor = snap.docs[snap.docs.length - 1] || cursor;
    $('#maisWrap').classList.toggle('oculto', snap.docs.length < PAGINA_TAM);
    listaCarregada = true;
    renderLista();
  } catch (e) {
    $('#lista').innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`;
  }
}

function renderLista(msgVazio = 'Não há folhas de obra com estes filtros.') {
  if (!lista.length) { $('#lista').innerHTML = `<div class="vazio">${esc(msgVazio)}</div>`; return; }
  const lote = sessao.perfil === 'master' && $('#fEstado').value === 'antigas';
  $('#lista').innerHTML = (lote ? `<div class="barra-lote" id="barraLote"><b id="nSel">0 selecionadas</b>
      <button class="btn btn-peq" id="selTodas">Selecionar todas</button>
      <select id="loteEstado" style="flex:1 1 140px"><option value="Concluída">Fechar como Concluída</option><option value="Faturada">Fechar como Faturada</option><option value="Anulada">Anular</option></select>
      <button class="btn btn-peq btn-primario" id="btnLote">Aplicar</button></div>` : '') + lista.map((f) => `
    <a class="lista-item ${classeEstado(f.estado).replace('estado-', 'b-')}" href="${pagina('folhas', { id: f.id })}" data-id="${esc(f.id)}">
      <div class="li-topo"><span class="li-titulo ${lote ? 'sel-lote' : ''}">${lote ? `<input type="checkbox" data-sel="${esc(f.id)}" ${selecionadas.has(f.id) ? 'checked' : ''} aria-label="Selecionar">` : ''}${esc(f.numero || '')} · ${esc(f.clienteNome || '')}</span>${badgeEstado(f.estado)}</div>
      <div class="li-sub">${esc(f.localidade || f.morada || '')}</div>
      <div class="li-meta"><span class="tipo">${esc(TIPO_NOME[f.tipo] || f.tipo)}</span>
        <span>${esc(fmtDataHora(f.dataPrevista))}</span>${staff ? `<span>· ${esc(f.tecnicoNome || '')}</span>` : ''}</div>
      ${f.descricao ? `<div class="li-desc">${esc(f.descricao)}</div>` : ''}
    </a>`).join('');
}
$('#lista').addEventListener('click', (ev) => {
  const cb = ev.target.closest('[data-sel]');
  if (cb) {
    ev.stopPropagation();
    if (cb.checked) selecionadas.add(cb.dataset.sel); else selecionadas.delete(cb.dataset.sel);
    $('#nSel').textContent = selecionadas.size + ' selecionadas';
    return;
  }
  if (ev.target.closest('#barraLote')) {
    if (ev.target.id === 'selTodas') { lista.forEach((f) => selecionadas.add(f.id)); renderLista(); $('#nSel').textContent = selecionadas.size + ' selecionadas'; }
    if (ev.target.id === 'btnLote') fecharEmLote(ev.target);
    ev.preventDefault();
    return;
  }
  const a = ev.target.closest('a[data-id]');
  if (!a) return;
  ev.preventDefault();
  irPara({ id: a.dataset.id });
});

// Fecho em lote das folhas antigas (só Master): cada folha fica com o registo no histórico.
async function fecharEmLote(btn) {
  const novo = $('#loteEstado').value;
  const alvo = lista.filter((f) => selecionadas.has(f.id));
  if (!alvo.length) { toast('Selecione pelo menos uma folha.'); return; }
  // sem técnico/data só pode ser anulada (as outras exigem técnico e data)
  const invalidas = novo === 'Anulada' ? [] : alvo.filter((f) => !f.tecnicoUid || !f.dataPrevista);
  if (!(await confirmar(`${novo === 'Anulada' ? 'Anular' : 'Fechar como «' + novo + '»'} ${alvo.length - invalidas.length} folhas?` +
    (invalidas.length ? ` (${invalidas.length} sem técnico ou data ficam de fora: só podem ser anuladas.)` : ''), { ok: 'Aplicar', perigo: novo === 'Anulada' }))) return;
  await comBotao(btn, async () => {
    const ok = alvo.filter((f) => !invalidas.includes(f));
    try {
      // folhas com material do stock da plataforma: uma a uma, para libertar as reservas na mesma transação
      const comStock = (novo === 'Faturada' || novo === 'Anulada') ? ok.filter((f) => (f.materiais || []).some((m) => m.artigoId)) : [];
      for (const f of comStock) {
        await runTransaction(db, async (tx) => {
          const s = await tx.get(doc(db, 'folhas', f.id));
          const d = s.data();
          const aplicar = await aplicarReservas(tx, movLibertarFolha(d));
          tx.update(doc(db, 'folhas', f.id), {
            estado: novo, historico: [...(d.historico || []), { estado: novo, de: d.estado, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now(), nota: 'Fecho em lote (folha antiga)' }],
            pendencia: null, estadoAlteradoEm: serverTimestamp(), atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid,
          });
          aplicar();
        });
      }
      const resto = ok.filter((f) => !comStock.includes(f));
      for (let i = 0; i < resto.length; i += 200) {
        const b = writeBatch(db);
        for (const f of resto.slice(i, i + 200)) {
          const entrada = { estado: novo, de: f.estado, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now(), nota: 'Fecho em lote (folha antiga)' };
          b.update(doc(db, 'folhas', f.id), {
            estado: novo, historico: [...(f.historico || []), entrada], pendencia: null,
            estadoAlteradoEm: serverTimestamp(), atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid,
          });
        }
        await b.commit();
      }
      toast(`${ok.length} folhas atualizadas.`, 'ok');
      carregarLista();
    } catch (e) { toast(erroFirebase(e), 'erro', 6000); }
  });
}

// ---------- Navegação lista ⇄ detalhe ----------
function irPara(params) { history.pushState({}, '', pagina('folhas', params)); rota(); }
window.addEventListener('popstate', rota);
function rota() {
  const p = new URLSearchParams(location.search);
  fecharModal();
  if (p.get('id')) { abrirDetalhe(p.get('id')); return; }
  $('#vDetalhe').classList.add('oculto');
  $('#vLista').classList.remove('oculto');
  if (!listaCarregada) carregarLista(); else renderLista();
  if (p.get('nova') && staff) abrirForm(null, p.get('cliente'));
}

// ---------- Detalhe ----------
async function abrirDetalhe(id) {
  $('#vLista').classList.add('oculto');
  const v = $('#vDetalhe');
  v.classList.remove('oculto');
  v.innerHTML = '<div class="vazio">A carregar…</div>';
  window.scrollTo(0, 0);
  try {
    const snap = await getDoc(doc(db, 'folhas', id));
    if (!snap.exists()) { v.innerHTML = botaoVoltar() + '<div class="vazio">Folha de obra não encontrada.</div>'; ligarVoltar(); return; }
    atual = { id: snap.id, ...snap.data() };
    renderDetalhe();
  } catch (e) {
    v.innerHTML = botaoVoltar() + `<div class="vazio">${esc(erroFirebase(e))}</div>`;
    ligarVoltar();
  }
}
const botaoVoltar = () => `<button class="voltar" id="btnVoltar">‹ ${tecnico ? 'As minhas folhas' : 'Folhas de obra'}</button>`;
function ligarVoltar() {
  $('#btnVoltar').onclick = () => {
    const vemDaAgenda = history.state === null && /agenda/.test(document.referrer);
    if ((history.state !== null || vemDaAgenda) && history.length > 1) history.back();
    else irPara(null);
  };
}

function renderDetalhe() {
  const f = atual;
  const tel = linkTel(f.telefone);
  const mapa = linkMapa(f);
  const proximos = (TRANSICOES[f.estado] || []).filter((e) => transicoesPermitidas(sessao.perfil, f.estado).includes(e));
  const outros = staff ? transicoesPermitidas(sessao.perfil, f.estado).filter((e) => !proximos.includes(e)) : [];
  const rotulo = {
    'Agendada': f.estado === 'Por agendar' ? 'Agendar' : 'Voltar a agendar',
    'Em curso': f.estado === 'Agendada' ? 'Iniciar trabalho' : 'Retomar trabalho',
    'Pendente': 'Pendente…', 'Concluída': 'Concluir', 'Revista': 'Marcar como revista',
    'Aguarda NE': 'Aguarda nota de encomenda', 'Faturada': 'Marcar como faturada',
  };
  const secundario = (e) => e === 'Pendente' || e === 'Aguarda NE' || (e === 'Agendada' && f.estado === 'Pendente');
  const pend = f.estado === 'Pendente' && f.pendencia ? f.pendencia : null;
  const podeObs = staff || (tecnico && f.estado !== 'Faturada');
  const obsPorGravar = $('#obs') ? $('#obs').value : null; // não perder texto escrito ao re-desenhar
  const relPorGravar = $('#relatorio') && $('#relatorio').value !== (f.relatorio || '') ? $('#relatorio').value : null;
  $('#vDetalhe').innerHTML = `
    ${botaoVoltar()}
    <div class="cartao">
      <div class="det-cab"><div><h1 id="detNumero">${esc(f.numero)}</h1><span class="tipo">${esc(TIPO_NOME[f.tipo] || f.tipo)}</span></div>
        <div style="text-align:right">${badgeEstado(f.estado)}${staff ? '<br><button class="btn btn-peq" id="btnEditar" style="margin-top:8px">Editar</button>' : ''}</div></div>
      <dl class="dl">
        <div><dt>Cliente</dt><dd>${esc(f.clienteNome)}${f.clienteNif ? `<br><span class="muted">NIF ${esc(f.clienteNif)}</span>` : ''}</dd></div>
        <div><dt>Data prevista</dt><dd>${f.dataPrevista ? `${esc(fmtDiaSemana(paraData(f.dataPrevista)))}, ${esc(fmtHora(f.dataPrevista))}` : '<span class="muted">Por agendar</span>'}${f.duracaoPrevista ? ` <span class="muted" id="detDuracao">· ${esc(String(f.duracaoPrevista).replace('.', ','))} h previstas</span>` : ''}</dd></div>
        ${f.contratoId ? `<div><dt>Contrato</dt><dd>${staff ? `<a href="${pagina('contratos', { id: f.contratoId })}" id="detContrato">${esc(f.contratoNumero)}</a>` : `<span id="detContrato">${esc(f.contratoNumero)}</span>`}</dd></div>` : ''}
        <div><dt>Morada da obra</dt><dd>${esc([f.morada, [f.codigoPostal, f.localidade].filter(Boolean).join(' ')].filter(Boolean).join('\n') || '—')}</dd></div>
        <div><dt>Contacto no local</dt><dd>${esc([f.contacto, f.telefone].filter(Boolean).join(' · ') || '—')}</dd></div>
        <div><dt>Técnico responsável</dt><dd>${esc(f.tecnicoNome || 'Por atribuir')}</dd></div>
        <div class="desc-destaque"><dt>Descrição do trabalho</dt><dd id="detDescricao">${esc(f.descricao || '—')}</dd></div>
      </dl>
      ${(tel || mapa) ? `<div class="acoes-rapidas">
        ${tel ? `<a class="btn btn-sec" href="${esc(tel)}">Ligar</a>` : '<span></span>'}
        ${mapa ? `<a class="btn btn-sec" href="${esc(mapa)}" target="_blank" rel="noopener">Navegar</a>` : ''}</div>` : ''}
    </div>
    <div class="cartao">
      <h3 style="margin-top:0">Estado</h3>
      ${pend ? `<div class="pendencia" id="pendencia"><b>Pendente — ${esc(pend.motivo)}</b>${pend.nota ? `<div>${esc(pend.nota)}</div>` : ''}
        <div class="muted">${esc(pend.nome || '')}, ${esc(fmtDataHora(pend.em))}${pend.reverEm ? ` · rever em ${esc(fmtData(pend.reverEm))}` : ''}</div></div>` : ''}
      ${f.estado === 'Faturada' && f.numeroFatura ? `<p class="muted" style="margin-top:0">Fatura ${esc(f.numeroFatura)}</p>` : ''}
      ${['Agendada', 'Em curso', 'Pendente'].includes(f.estado) && (f.avisoEnviado || f.avisoAgendamento) ? `<p class="muted" style="margin-top:0" id="estadoAviso">${f.avisoEnviado
        ? (f.avisoEnviado.estado === 'Enviado' ? `Aviso de agendamento enviado para ${esc(f.avisoEnviado.para)} em ${esc(fmtDataHora(f.avisoEnviado.em))}` : `Aviso de agendamento não enviado (${esc(f.avisoEnviado.erro || 'erro')})`)
        : `Aviso de agendamento a enviar para ${esc(f.avisoAgendamento.para)}…`}</p>` : ''}
      <div class="estados-acoes">
        ${proximos.map((e) => `<button class="btn ${secundario(e) ? '' : 'btn-primario'}" data-estado="${esc(e)}">${esc(rotulo[e] || e)}</button>`).join('')
          || '<div class="muted">Sem ações disponíveis neste estado.</div>'}
        ${outros.length ? `<label class="campo" style="margin:4px 0 0"><span>Corrigir estado</span>
          <select id="selCorrigir"><option value="">—</option>${outros.map((e) => `<option>${esc(e)}</option>`).join('')}</select></label>` : ''}
      </div>
    </div>
    ${htmlRelatorioCliente(f)}
    ${htmlTrabalho(f)}
    ${f.origem === 'phc' ? `<div class="cartao" id="cartaoPhc">
      <h3 style="margin-top:0">Registado no PHC</h3>
      <p class="muted" style="margin:0 0 8px">Dossier ${esc(String(f.phcNumero || ''))} · estado no PHC: ${esc(f.phcEstado || '—')}${f.phcFechada ? ' · faturado' : ''}${f.situacaoPHC ? ' · ' + esc(f.situacaoPHC) : ''}</p>
      ${f.encomendaCliente ? `<p style="margin:0 0 8px"><b>V/Encomenda:</b> <span id="encomendaPhc">${esc(f.encomendaCliente)}</span></p>` : ''}
      ${f.relatorioPHC ? `<h3>Relatório de intervenção</h3><p id="relatorioPhc" style="white-space:pre-wrap;margin:0 0 8px">${esc(f.relatorioPHC)}</p>` : ''}
      ${f.observacoesInternasPHC && staff ? `<h3>Observações internas</h3><p style="white-space:pre-wrap;margin:0 0 8px">${esc(f.observacoesInternasPHC)}</p>` : ''}
      ${(f.linhasPHC || []).length ? `<ul class="hist">${f.linhasPHC.map((l) => `
        <li><b>${esc(String(l.qtd ?? ''))} ${esc(l.unidade || '')}</b><span>${esc(l.descricao || '')}</span><span class="muted">${esc(l.ref || '')}${l.data ? ' · ' + esc(fmtData(l.data)) : ''}</span></li>`).join('')}</ul>`
        : '<p class="muted" style="margin:0">Sem linhas de trabalho ou material.</p>'}
      ${(f.temposPHC || []).length ? `<h3>Registo de tempos</h3><ul class="hist" id="temposPhc">${f.temposPHC.map((t) => `
        <li><b>${esc(String(t.horas ?? ''))} h</b><span>${esc(t.funcionario || '')}</span><span class="muted">${esc(fmtData(t.data))}</span></li>`).join('')}</ul>` : ''}
      ${(f.tarefasPHC || []).length ? `<h3>Tarefas</h3><ul class="hist">${[...new Set(f.tarefasPHC)].map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${sessao.perfil === 'master' ? '<div id="valoresPhc" style="margin-top:12px"><button class="btn btn-sec btn-bloco" id="btnValores">Ver valores (só Master)</button></div>' : ''}
    </div>` : ''}
    <div class="cartao">
      <h3 style="margin-top:0">Notas internas</h3>
      <p class="muted" style="margin:-4px 0 8px">Não seguem para o cliente.</p>
      ${podeObs
        ? `<textarea id="obs" placeholder="Notas sobre o trabalho realizado, anomalias, material em falta…">${esc(f.observacoesTecnico || '')}</textarea>
           <div class="acoes"><button class="btn" id="btnObs">Guardar observações</button></div>`
        : `<p>${esc(f.observacoesTecnico || '—')}</p>`}
    </div>
    <div class="cartao">
      <h3 style="margin-top:0">Histórico</h3>
      <ul class="hist">${(f.historico || []).slice().reverse().map((h) => `
        <li>${badgeEstado(h.estado)}${h.motivo ? `<span class="muted">${esc(h.motivo)}</span>` : ''}<span>${esc(h.nome || '')}</span><span class="muted">${esc(fmtDataHora(h.em))}</span></li>`).join('')}</ul>
      ${(f.historicoPHC || []).length ? `<details style="margin-top:8px"><summary class="muted">Histórico no PHC (${f.historicoPHC.length})</summary><ul class="hist">${f.historicoPHC.map((h) => `
        <li><span>${esc(h.texto || '')}</span><span class="muted">${esc(fmtDataHora(h.em))}</span></li>`).join('')}</ul></details>` : ''}
      <p class="muted" style="margin-bottom:0">Criada por ${esc(f.criadoPorNome || '—')} em ${esc(fmtDataHora(f.criadoEm))}</p>
    </div>`;
  ligarVoltar();
  if (obsPorGravar !== null && $('#obs')) $('#obs').value = obsPorGravar;
  if (relPorGravar !== null && $('#relatorio')) $('#relatorio').value = relPorGravar;
  ligarTrabalho();
  ligarRelatorioCliente();
  $$('[data-estado]').forEach((b) => b.onclick = () => mudarEstado(b.dataset.estado, b));
  if ($('#selCorrigir')) $('#selCorrigir').onchange = (ev) => { const e = ev.target.value; ev.target.value = ''; if (e) mudarEstado(e, null); };
  if ($('#btnObs')) $('#btnObs').onclick = () => comBotao($('#btnObs'), guardarObs);
  if ($('#btnEditar')) $('#btnEditar').onclick = () => abrirForm(atual);
  if ($('#btnValores')) $('#btnValores').onclick = () => comBotao($('#btnValores'), mostrarValores);
}

// Preços e valor/hora do PHC: documento separado que só o Master pode ler (garantido nas regras).
async function mostrarValores() {
  const eur = (v) => (Number(v) || 0).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
  try {
    const s = await getDoc(doc(db, 'folhas', atual.id, 'privado', 'phc'));
    if (!s.exists()) { $('#valoresPhc').innerHTML = '<p class="muted">Sem valores no PHC.</p>'; return; }
    const v = s.data();
    $('#valoresPhc').innerHTML = `<h3>Valores (só Master)</h3>
      ${(v.valorHora || []).length ? `<ul class="hist">${v.valorHora.map((x) => `
        <li><span>${esc(fmtData(x.data))}</span><span>${esc(x.tipoTecnico)} · ${esc(String(x.horas))} h × ${esc(eur(x.preco))}</span><b>${esc(eur(x.total))}</b></li>`).join('')}</ul>` : ''}
      ${(v.linhas || []).length ? `<ul class="hist">${v.linhas.map((x) => `
        <li><span>${esc(x.ref)}</span><span>${esc(String(x.qtd))} × ${esc(eur(x.preco))}</span><b>${esc(eur(x.total))}</b></li>`).join('')}</ul>` : ''}
      <p style="text-align:right;margin:8px 0 0"><b id="totalVenda">Total venda: ${esc(eur(v.totalVenda))}</b> <span class="muted">s/IVA</span></p>`;
  } catch (e) { toast(erroFirebase(e), 'erro'); }
}

// Pede o motivo da pendência (obrigatório), uma nota e a data para voltar a pegar.
function pedirPendencia() {
  return new Promise((resolve) => {
    const c = abrirModal('Folha pendente', `
      <div class="campo"><span>Motivo *</span><div class="chips">${MOTIVOS_PENDENCIA.map((m) => `
        <label><input type="radio" name="motivo" value="${esc(m)}"><span>${esc(m)}</span></label>`).join('')}</div></div>
      <label class="campo"><span>Nota</span><textarea id="pNota" placeholder="O que falta, quem está à espera de quê…"></textarea></label>
      <label class="campo"><span>Rever em</span><input type="date" id="pRever"></label>
      <div class="msg-erro" id="pErro"></div>
      <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="pOk">Marcar pendente</button></div>`,
    { aoFechar: () => resolve(null) });
    $('#pOk', c).onclick = () => {
      const m = ($('input[name=motivo]:checked', c) || {}).value;
      if (!m) { $('#pErro', c).textContent = 'Escolha o motivo.'; return; }
      const r = $('#pRever', c).value;
      const nota = $('#pNota', c).value.trim();
      fecharModal();
      resolve({ motivo: m, nota, reverEm: r ? Timestamp.fromDate(deIsoLocal(r, '09:00')) : null, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() });
    };
  });
}

function pedirTexto(titulo, rotulo) {
  return new Promise((resolve) => {
    const c = abrirModal(titulo, `<label class="campo"><span>${esc(rotulo)}</span><input id="tVal" autocomplete="off"></label>
      <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="tOk">Confirmar</button></div>`,
    { aoFechar: () => resolve(null) });
    $('#tOk', c).onclick = () => { const v = $('#tVal', c).value.trim(); fecharModal(); resolve(v); };
  });
}

async function mudarEstado(novo, btn) {
  const f = atual;
  const extra = {};
  let enviarPara = '';
  if (novo === 'Agendada' && (!f.tecnicoUid || !f.dataPrevista)) {
    toast('Indique o técnico e a data para agendar.', 'erro');
    abrirForm(atual, null, { agendarDepois: true });
    return;
  }
  let avisoPara = '';
  if (novo === 'Agendada') {
    const para = await pedirAvisoAgendamento(f, f.estado !== 'Por agendar');
    if (para === null) return;
    avisoPara = para;
  }
  if (novo === 'Pendente') {
    const p = await pedirPendencia();
    if (!p) return;
    extra.pendencia = p;
  }
  if (novo === 'Concluída' && f.estado === 'Em curso') {
    // fim do trabalho no local: relatório + assinatura do cliente
    const c = await pedirConclusao(f);
    if (!c) return;
    enviarPara = c.enviarRelatorioPara;
    delete c.enviarRelatorioPara;
    Object.assign(extra, c);
  } else if (novo === 'Concluída' && !(await confirmar('Marcar esta folha de obra como concluída?', { ok: 'Concluir' }))) return;
  if (novo === 'Faturada') {
    const n = await pedirTexto('Marcar como faturada', 'N.º da fatura (opcional)');
    if (n === null) return;
    if (n) extra.numeroFatura = n;
  }
  const exec = async () => {
    const ref = doc(db, 'folhas', f.id);
    try {
      const resultado = await runTransaction(db, async (tx) => {
        const s = await tx.get(ref);
        const d = s.data();
        if (d.estado !== f.estado) throw Object.assign(new Error('A folha foi alterada por outra pessoa. Atualize a página.'), { code: 'alterada' });
        // Faturada/Anulada: o material da folha deixa de estar reservado (e volta a estar se a folha for reaberta).
        const fecha = (e) => e === 'Faturada' || e === 'Anulada';
        let aplicar = null;
        if (fecha(novo) !== fecha(d.estado)) {
          const mov = movLibertarFolha(d);
          if (!fecha(novo)) for (const k in mov) mov[k].resFolhas = -mov[k].resFolhas;
          if (Object.keys(mov).length) aplicar = await aplicarReservas(tx, mov);
        }
        const entrada = { estado: novo, de: d.estado, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() };
        if (extra.pendencia) { entrada.motivo = extra.pendencia.motivo; if (extra.pendencia.nota) entrada.nota = extra.pendencia.nota; }
        const alt = {
          ...extra,
          estado: novo, historico: [...(d.historico || []), entrada],
          estadoAlteradoEm: serverTimestamp(), atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid,
        };
        if (novo !== 'Pendente' && d.pendencia) alt.pendencia = null;
        if (avisoPara) {
          const eRef = doc(collection(db, 'emails'));
          tx.set(eRef, dadosEmailAgendamento({ id: f.id, ...d, ...alt }, avisoPara, f.estado !== 'Por agendar'));
          alt.avisoAgendamento = { para: avisoPara, emailId: eRef.id, pedidoEm: Timestamp.now(), uid: sessao.uid };
        }
        // relatório ao cliente: fica em fila (emails/) na mesma transação; a PontePHC envia pelo Exchange
        if (enviarPara) {
          const eRef = doc(collection(db, 'emails'));
          const final = { id: f.id, ...d, ...alt, historico: alt.historico };
          tx.set(eRef, dadosEmailRelatorio(final, enviarPara));
          alt.relatorioCliente = { para: enviarPara, emailId: eRef.id, pedidoEm: Timestamp.now(), uid: sessao.uid };
        }
        tx.update(ref, alt);
        if (aplicar) aplicar();
        return { ...d, ...alt, estadoAlteradoEm: Timestamp.now(), atualizadoEm: Timestamp.now() };
      });
      atual = { id: f.id, ...resultado };
      const i = lista.findIndex((x) => x.id === f.id);
      if (i >= 0) lista[i] = atual;
      toast('Estado alterado para «' + novo + '».' + (enviarPara ? ' Relatório a enviar para ' + enviarPara + '.' : '') + (avisoPara ? ' Aviso de agendamento a enviar para ' + avisoPara + '.' : ''), 'ok', enviarPara || avisoPara ? 6000 : 3000);
      renderDetalhe();
    } catch (e) {
      toast(e.code === 'alterada' ? e.message : erroFirebase(e), 'erro', 5000);
    }
  };
  if (btn) await comBotao(btn, exec); else await exec();
}

async function guardarObs() {
  const txt = $('#obs').value.trim();
  try {
    await updateDoc(doc(db, 'folhas', atual.id), { observacoesTecnico: txt, atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
    atual.observacoesTecnico = txt;
    toast('Observações guardadas.', 'ok');
  } catch (e) { toast(erroFirebase(e), 'erro'); }
}

// ---------- Formulário nova / editar (só master e backoffice) ----------
async function abrirForm(folha, clienteIdInicial, { agendarDepois = false } = {}) {
  const ed = !!folha;
  let cliente = ed ? { id: folha.clienteId, nome: folha.clienteNome, nif: folha.clienteNif } : null;
  const dp = ed ? paraData(folha.dataPrevista) : addDias(inicioDia(new Date()), 1);
  const horaIni = ed && folha.dataPrevista ? fmtHora(folha.dataPrevista) : '09:00';
  const corpo = abrirModal(ed ? 'Editar ' + folha.numero : 'Nova folha de obra', `
    <form id="fFolha" novalidate>
      <div class="campo"><span>Cliente *</span><div id="cliBox"></div></div>
      <div class="campo"><span>Tipo *</span><div class="chips">${TIPOS.map((t) => `
        <label><input type="radio" name="tipo" value="${esc(t)}" ${(ed ? folha.tipo === t : t === 'Instalação') ? 'checked' : ''}><span>${esc(TIPO_NOME[t])}</span></label>`).join('')}</div></div>
      <label class="campo"><span>Técnico responsável</span><select id="ffTec"><option value="">A carregar…</option></select></label>
      <div class="linha2">
        <label class="campo"><span>Data prevista</span><input type="date" id="ffData" value="${dp ? isoLocal(dp) : ''}"></label>
        <label class="campo"><span>Hora</span><input type="time" id="ffHora" value="${esc(horaIni)}" step="900"></label>
      </div>
      <label class="campo"><span>Duração prevista (horas)</span><input type="number" id="ffDur" min="0" max="200" step="0.5" inputmode="decimal" value="${esc(String(folha?.duracaoPrevista || ''))}" placeholder="Ex.: 2"></label>
      <label class="campo"><span>Morada da obra</span><input id="ffMorada" value="${esc(folha?.morada || '')}" autocomplete="off"></label>
      <div class="linha2">
        <label class="campo"><span>Código postal</span><input id="ffCP" value="${esc(folha?.codigoPostal || '')}" inputmode="numeric" placeholder="0000-000"></label>
        <label class="campo"><span>Localidade</span><input id="ffLoc" value="${esc(folha?.localidade || '')}"></label>
      </div>
      <div class="linha2">
        <label class="campo"><span>Contacto no local</span><input id="ffContacto" value="${esc(folha?.contacto || '')}"></label>
        <label class="campo"><span>Telefone</span><input id="ffTel" type="tel" value="${esc(folha?.telefone || '')}"></label>
      </div>
      <label class="campo"><span>Email do cliente (avisos e relatório)</span><input id="ffEmail" type="email" inputmode="email" autocomplete="off" value="${esc(folha ? emailDoCliente(folha) : '')}"></label>
      <label class="campo"><span>Descrição do trabalho</span><textarea id="ffDesc">${esc(folha?.descricao || '')}</textarea></label>
      <div class="msg-erro" id="ffErro"></div>
      <div class="acoes"><button type="button" class="btn" data-fechar>Cancelar</button>
        <button type="submit" class="btn btn-primario" id="ffGuardar">${ed ? 'Guardar' : 'Criar folha'}</button></div>
    </form>`);

  // Técnicos
  carregarTecnicos().then((tecs) => {
    const sel = $('#ffTec', corpo);
    sel.innerHTML = '<option value="">Escolher…</option>' + tecs.map((t) => `<option value="${esc(t.uid)}">${esc(t.nome)}</option>`).join('');
    sel.options[0].textContent = 'Por atribuir';
    if (ed && folha.tecnicoUid) {
      if (!tecs.some((t) => t.uid === folha.tecnicoUid)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(folha.tecnicoUid)}">${esc(folha.tecnicoNome)} (inativo)</option>`);
      sel.value = folha.tecnicoUid;
    }
  }).catch((e) => { $('#ffErro', corpo).textContent = erroFirebase(e); });

  // Escolha de cliente
  function preencherDoCliente(c) {
    if ($('#ffMorada', corpo).value) return; // não apaga o que já foi escrito
    $('#ffMorada', corpo).value = c.morada || '';
    $('#ffCP', corpo).value = c.codigoPostal || '';
    $('#ffLoc', corpo).value = c.localidade || '';
    $('#ffContacto', corpo).value = c.contacto || '';
    $('#ffTel', corpo).value = c.telefone || '';
    if (!$('#ffEmail', corpo).value) $('#ffEmail', corpo).value = c.email || '';
  }
  function renderCliente() {
    const box = $('#cliBox', corpo);
    if (cliente) {
      box.innerHTML = `<div class="cliente-escolhido"><div><b>${esc(cliente.nome)}</b><br><span class="muted">NIF ${esc(cliente.nif || '—')}</span></div>
        ${ed ? '' : '<button type="button" class="btn btn-peq" id="cliTrocar">Trocar</button>'}</div>`;
      if (!ed) $('#cliTrocar', corpo).onclick = () => { cliente = null; renderCliente(); };
      return;
    }
    box.innerHTML = `<div class="barra" style="margin:0"><input id="cliQ" placeholder="Nome, localidade ou NIF" autocomplete="off">
      <button type="button" class="btn" id="cliProcurar">Procurar</button></div><div id="cliRes"></div>`;
    const procurar = () => comBotao($('#cliProcurar', corpo), async () => {
      const q = $('#cliQ', corpo).value;
      if (q.trim().length < 2) { $('#cliRes', corpo).innerHTML = '<p class="muted">Escreva pelo menos 2 letras.</p>'; return; }
      try {
        const res = await pesquisarClientes(q, { soAtivos: true });
        $('#cliRes', corpo).innerHTML = res.length
          ? `<div class="resultados">${res.map((c, i) => `<button type="button" data-i="${i}"><b>${esc(c.nome)}</b><br><span class="muted">${esc(c.nif)} · ${esc(c.localidade || '')}</span></button>`).join('')}</div>`
          : `<p class="muted">Nenhum cliente encontrado. <a href="${pagina('clientes', { novo: 1 })}">Criar cliente</a></p>`;
        $$('#cliRes [data-i]', corpo).forEach((b) => b.onclick = () => { cliente = res[+b.dataset.i]; preencherDoCliente(cliente); renderCliente(); });
      } catch (e) { $('#cliRes', corpo).innerHTML = `<p class="msg-erro">${esc(erroFirebase(e))}</p>`; }
    });
    $('#cliProcurar', corpo).onclick = procurar;
    $('#cliQ', corpo).onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); procurar(); } };
  }
  renderCliente();
  if (!ed && clienteIdInicial) {
    getDoc(doc(db, 'clientes', clienteIdInicial)).then((s) => { if (s.exists()) { cliente = { id: s.id, ...s.data() }; preencherDoCliente(cliente); renderCliente(); } });
  }

  $('#fFolha', corpo).onsubmit = (ev) => {
    ev.preventDefault();
    const erro = (m) => { $('#ffErro', corpo).textContent = m; };
    const tecUid = $('#ffTec', corpo).value;
    const tipo = ($('input[name=tipo]:checked', corpo) || {}).value;
    const data = $('#ffData', corpo).value;
    if (!cliente) return erro('Escolha o cliente.');
    if (!tipo) return erro('Escolha o tipo.');
    if (ed && folha.estado !== 'Por agendar' && (!tecUid || !data)) return erro('Esta folha já está agendada: indique o técnico e a data.');
    const tecOpt = $('#ffTec', corpo).selectedOptions[0];
    const dados = {
      tipo, tecnicoUid: tecUid || '', tecnicoNome: tecUid ? tecOpt.textContent.replace(/ \(inativo\)$/, '') : '',
      dataPrevista: data ? Timestamp.fromDate(deIsoLocal(data, $('#ffHora', corpo).value || '09:00')) : null,
      morada: $('#ffMorada', corpo).value.trim(), codigoPostal: $('#ffCP', corpo).value.trim(), localidade: $('#ffLoc', corpo).value.trim(),
      contacto: $('#ffContacto', corpo).value.trim(), telefone: $('#ffTel', corpo).value.trim(),
      descricao: $('#ffDesc', corpo).value.trim(),
      duracaoPrevista: Math.max(0, Math.min(200, Number(String($('#ffDur', corpo).value).replace(',', '.')) || 0)),
      clienteEmail: $('#ffEmail', corpo).value.trim(),
      atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid,
    };
    if (dados.clienteEmail && !emailValido(dados.clienteEmail)) return erro('Email do cliente inválido.');
    if (ed) dados.pesquisa = tokensFolha(folha.numero, folha.clienteNome, folha.clienteNif, dados.descricao);
    comBotao($('#ffGuardar', corpo), async () => {
      try {
        if (ed) {
          // «Por agendar» continua «Por agendar» até carregar em «Agendar» (decisão 2026-11-03).
          const antes = { tec: folha.tecnicoUid, data: folha.dataPrevista ? paraData(folha.dataPrevista).getTime() : 0 };
          await updateDoc(doc(db, 'folhas', folha.id), dados);
          atual = { ...atual, ...dados, atualizadoEm: Timestamp.now() };
          const reagendada = atual.estado === 'Agendada' && (antes.tec !== atual.tecnicoUid || antes.data !== (atual.dataPrevista ? paraData(atual.dataPrevista).getTime() : 0));
          const i = lista.findIndex((x) => x.id === folha.id);
          if (i >= 0) lista[i] = atual;
          fecharModal();
          toast('Folha atualizada.', 'ok');
          renderDetalhe();
          if (agendarDepois && atual.estado === 'Por agendar' && atual.tecnicoUid && atual.dataPrevista) await mudarEstado('Agendada', null);
          else if (reagendada) {
            const para = await pedirAvisoAgendamento(atual, true);
            if (para) {
              try { await setDoc(doc(collection(db, 'emails')), dadosEmailAgendamento(atual, para, true)); toast('Aviso de reagendamento a enviar para ' + para + '.', 'ok', 5000); }
              catch (e) { toast(erroFirebase(e), 'erro'); }
            }
          }
        } else {
          const id = await criarFolha(cliente, dados);
          fecharModal();
          toast('Folha criada.', 'ok');
          listaCarregada = false;
          history.replaceState({}, '', pagina('folhas'));
          irPara({ id });
        }
      } catch (e) { erro(erroFirebase(e)); }
    });
  };
}

function criarFolha(cliente, dados) { return criarFolhaNova(cliente, dados); }

rota();
