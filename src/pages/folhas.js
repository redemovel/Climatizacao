const sessao = await iniciarPagina({ perfis: ['master', 'backoffice', 'tecnico'] });
const staff = ehStaff(sessao.perfil);
const tecnico = sessao.perfil === 'tecnico';

let lista = [];            // folhas carregadas (cache da lista para não reler ao voltar do detalhe)
let cursor = null;
let listaCarregada = false;
let atual = null;          // folha aberta no detalhe

// ---------- Filtros ----------
$('#fEstado').insertAdjacentHTML('beforeend', ESTADOS.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join(''));
if (tecnico) $('#tituloLista').textContent = 'As minhas folhas';
if (staff) {
  $('#btnNova').classList.remove('oculto');
  $('#fTec').classList.remove('oculto');
  carregarTecnicos().then((tecs) => {
    $('#fTec').insertAdjacentHTML('beforeend', tecs.map((t) => `<option value="${esc(t.uid)}">${esc(t.nome)}</option>`).join(''));
  }).catch((e) => toast(erroFirebase(e), 'erro'));
}
$('#fEstado').onchange = () => carregarLista();
$('#fTec').onchange = () => carregarLista();
$('#btnNova').onclick = () => abrirForm(null);
$('#btnMais').onclick = () => comBotao($('#btnMais'), () => carregarLista(true));

$('#fPesq').onsubmit = async (ev) => {
  ev.preventDefault();
  let v = $('#pNum').value.trim().toUpperCase();
  if (!v) { carregarLista(); return; }
  if (/^\d+$/.test(v)) v = `FO-${new Date().getFullYear()}-${v.padStart(4, '0')}`;
  else if (/^\d{4}-\d+$/.test(v)) { const [a, n] = v.split('-'); v = `FO-${a}-${n.padStart(4, '0')}`; }
  const c = [where('numero', '==', v)];
  if (tecnico) c.unshift(where('tecnicoUid', '==', sessao.uid));
  try {
    const snap = await getDocs(query(collection(db, 'folhas'), ...c, limit(5)));
    lista = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cursor = null;
    $('#maisWrap').classList.add('oculto');
    renderLista(`Nenhuma folha com o número ${v}.`);
  } catch (e) { toast(erroFirebase(e), 'erro'); }
};

// ---------- Lista ----------
function consultaLista() {
  const c = [];
  const est = $('#fEstado').value;
  if (tecnico) c.push(where('tecnicoUid', '==', sessao.uid));
  else if ($('#fTec').value) c.push(where('tecnicoUid', '==', $('#fTec').value));
  if (est === 'abertas') c.push(where('estado', 'in', ESTADOS_ABERTOS));
  else if (est) c.push(where('estado', '==', est));
  c.push(orderBy('criadoEm', 'desc'));
  if (cursor) c.push(startAfter(cursor));
  c.push(limit(PAGINA_TAM));
  return query(collection(db, 'folhas'), ...c);
}

async function carregarLista(mais = false) {
  if (!mais) { lista = []; cursor = null; $('#lista').innerHTML = '<div class="vazio">A carregar…</div>'; }
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
  $('#lista').innerHTML = lista.map((f) => `
    <a class="lista-item ${classeEstado(f.estado).replace('estado-', 'b-')}" href="${pagina('folhas', { id: f.id })}" data-id="${esc(f.id)}">
      <div class="li-topo"><span class="li-titulo">${esc(f.numero || '')} · ${esc(f.clienteNome || '')}</span>${badgeEstado(f.estado)}</div>
      <div class="li-sub">${esc(f.localidade || f.morada || '')}</div>
      <div class="li-meta"><span class="tipo">${esc(TIPO_NOME[f.tipo] || f.tipo)}</span>
        <span>${esc(fmtDataHora(f.dataPrevista))}</span>${staff ? `<span>· ${esc(f.tecnicoNome || '')}</span>` : ''}</div>
    </a>`).join('');
}
$('#lista').addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-id]');
  if (!a) return;
  ev.preventDefault();
  irPara({ id: a.dataset.id });
});

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
  const rotulo = { 'Em curso': f.estado === 'Agendada' ? 'Iniciar trabalho' : 'Retomar trabalho', 'Pendente material': 'Pendente material', 'Concluída': 'Concluir', 'Faturada': 'Marcar como faturada' };
  const podeObs = staff || (tecnico && f.estado !== 'Faturada');
  const obsPorGravar = $('#obs') ? $('#obs').value : null; // não perder texto escrito ao re-desenhar
  $('#vDetalhe').innerHTML = `
    ${botaoVoltar()}
    <div class="cartao">
      <div class="det-cab"><div><h1 id="detNumero">${esc(f.numero)}</h1><span class="tipo">${esc(TIPO_NOME[f.tipo] || f.tipo)}</span></div>
        <div style="text-align:right">${badgeEstado(f.estado)}${staff ? '<br><button class="btn btn-peq" id="btnEditar" style="margin-top:8px">Editar</button>' : ''}</div></div>
      <dl class="dl">
        <div><dt>Cliente</dt><dd>${esc(f.clienteNome)}${f.clienteNif ? `<br><span class="muted">NIF ${esc(f.clienteNif)}</span>` : ''}</dd></div>
        <div><dt>Data prevista</dt><dd>${esc(fmtDiaSemana(paraData(f.dataPrevista)))}, ${esc(fmtHora(f.dataPrevista))}</dd></div>
        <div><dt>Morada da obra</dt><dd>${esc([f.morada, [f.codigoPostal, f.localidade].filter(Boolean).join(' ')].filter(Boolean).join('\n') || '—')}</dd></div>
        <div><dt>Contacto no local</dt><dd>${esc([f.contacto, f.telefone].filter(Boolean).join(' · ') || '—')}</dd></div>
        <div><dt>Técnico responsável</dt><dd>${esc(f.tecnicoNome || '—')}</dd></div>
        <div><dt>Descrição do trabalho</dt><dd>${esc(f.descricao || '—')}</dd></div>
      </dl>
      ${(tel || mapa) ? `<div class="acoes-rapidas">
        ${tel ? `<a class="btn btn-sec" href="${esc(tel)}">Ligar</a>` : '<span></span>'}
        ${mapa ? `<a class="btn btn-sec" href="${esc(mapa)}" target="_blank" rel="noopener">Navegar</a>` : ''}</div>` : ''}
    </div>
    <div class="cartao">
      <h3 style="margin-top:0">Estado</h3>
      <div class="estados-acoes">
        ${proximos.map((e) => `<button class="btn ${e === 'Pendente material' ? '' : 'btn-primario'}" data-estado="${esc(e)}">${esc(rotulo[e] || e)}</button>`).join('')
          || '<div class="muted">Sem ações disponíveis neste estado.</div>'}
        ${outros.length ? `<label class="campo" style="margin:4px 0 0"><span>Corrigir estado</span>
          <select id="selCorrigir"><option value="">—</option>${outros.map((e) => `<option>${esc(e)}</option>`).join('')}</select></label>` : ''}
      </div>
    </div>
    <div class="cartao">
      <h3 style="margin-top:0">Observações do técnico</h3>
      ${podeObs
        ? `<textarea id="obs" placeholder="Notas sobre o trabalho realizado, anomalias, material em falta…">${esc(f.observacoesTecnico || '')}</textarea>
           <div class="acoes"><button class="btn" id="btnObs">Guardar observações</button></div>`
        : `<p>${esc(f.observacoesTecnico || '—')}</p>`}
    </div>
    <div class="cartao">
      <h3 style="margin-top:0">Histórico</h3>
      <ul class="hist">${(f.historico || []).slice().reverse().map((h) => `
        <li>${badgeEstado(h.estado)}<span>${esc(h.nome || '')}</span><span class="muted">${esc(fmtDataHora(h.em))}</span></li>`).join('')}</ul>
      <p class="muted" style="margin-bottom:0">Criada por ${esc(f.criadoPorNome || '—')} em ${esc(fmtDataHora(f.criadoEm))}</p>
    </div>`;
  ligarVoltar();
  if (obsPorGravar !== null && $('#obs')) $('#obs').value = obsPorGravar;
  $$('[data-estado]').forEach((b) => b.onclick = () => mudarEstado(b.dataset.estado, b));
  if ($('#selCorrigir')) $('#selCorrigir').onchange = (ev) => { const e = ev.target.value; ev.target.value = ''; if (e) mudarEstado(e, null); };
  if ($('#btnObs')) $('#btnObs').onclick = () => comBotao($('#btnObs'), guardarObs);
  if ($('#btnEditar')) $('#btnEditar').onclick = () => abrirForm(atual);
}

async function mudarEstado(novo, btn) {
  const f = atual;
  if (novo === 'Concluída' && !(await confirmar('Marcar esta folha de obra como concluída?', { ok: 'Concluir' }))) return;
  if (novo === 'Faturada' && !(await confirmar('Marcar como faturada? Depois disso só o Master pode alterar o estado.', { ok: 'Faturada' }))) return;
  const exec = async () => {
    const ref = doc(db, 'folhas', f.id);
    try {
      const resultado = await runTransaction(db, async (tx) => {
        const s = await tx.get(ref);
        const d = s.data();
        if (d.estado !== f.estado) throw Object.assign(new Error('A folha foi alterada por outra pessoa. Atualize a página.'), { code: 'alterada' });
        const entrada = { estado: novo, de: d.estado, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() };
        const alt = {
          estado: novo, historico: [...(d.historico || []), entrada],
          estadoAlteradoEm: serverTimestamp(), atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid,
        };
        tx.update(ref, alt);
        return { ...d, ...alt, estadoAlteradoEm: Timestamp.now(), atualizadoEm: Timestamp.now() };
      });
      atual = { id: f.id, ...resultado };
      const i = lista.findIndex((x) => x.id === f.id);
      if (i >= 0) lista[i] = atual;
      toast('Estado alterado para «' + novo + '».', 'ok');
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
async function abrirForm(folha, clienteIdInicial) {
  const ed = !!folha;
  let cliente = ed ? { id: folha.clienteId, nome: folha.clienteNome, nif: folha.clienteNif } : null;
  const dp = ed ? paraData(folha.dataPrevista) : addDias(inicioDia(new Date()), 1);
  const horaIni = ed ? fmtHora(folha.dataPrevista) : '09:00';
  const corpo = abrirModal(ed ? 'Editar ' + folha.numero : 'Nova folha de obra', `
    <form id="fFolha" novalidate>
      <div class="campo"><span>Cliente *</span><div id="cliBox"></div></div>
      <div class="campo"><span>Tipo *</span><div class="chips">${TIPOS.map((t) => `
        <label><input type="radio" name="tipo" value="${esc(t)}" ${(ed ? folha.tipo === t : t === 'Instalação') ? 'checked' : ''}><span>${esc(TIPO_NOME[t])}</span></label>`).join('')}</div></div>
      <label class="campo"><span>Técnico responsável *</span><select id="ffTec" required><option value="">A carregar…</option></select></label>
      <div class="linha2">
        <label class="campo"><span>Data prevista *</span><input type="date" id="ffData" value="${isoLocal(dp)}" required></label>
        <label class="campo"><span>Hora</span><input type="time" id="ffHora" value="${esc(horaIni)}" step="900"></label>
      </div>
      <label class="campo"><span>Morada da obra</span><input id="ffMorada" value="${esc(folha?.morada || '')}" autocomplete="off"></label>
      <div class="linha2">
        <label class="campo"><span>Código postal</span><input id="ffCP" value="${esc(folha?.codigoPostal || '')}" inputmode="numeric" placeholder="0000-000"></label>
        <label class="campo"><span>Localidade</span><input id="ffLoc" value="${esc(folha?.localidade || '')}"></label>
      </div>
      <div class="linha2">
        <label class="campo"><span>Contacto no local</span><input id="ffContacto" value="${esc(folha?.contacto || '')}"></label>
        <label class="campo"><span>Telefone</span><input id="ffTel" type="tel" value="${esc(folha?.telefone || '')}"></label>
      </div>
      <label class="campo"><span>Descrição do trabalho</span><textarea id="ffDesc">${esc(folha?.descricao || '')}</textarea></label>
      <div class="msg-erro" id="ffErro"></div>
      <div class="acoes"><button type="button" class="btn" data-fechar>Cancelar</button>
        <button type="submit" class="btn btn-primario" id="ffGuardar">${ed ? 'Guardar' : 'Criar folha'}</button></div>
    </form>`);

  // Técnicos
  carregarTecnicos().then((tecs) => {
    const sel = $('#ffTec', corpo);
    sel.innerHTML = '<option value="">Escolher…</option>' + tecs.map((t) => `<option value="${esc(t.uid)}">${esc(t.nome)}</option>`).join('');
    if (ed) {
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
        const res = await pesquisarClientes(q);
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
    if (!tecUid) return erro('Escolha o técnico responsável.');
    if (!data) return erro('Indique a data prevista.');
    const tecOpt = $('#ffTec', corpo).selectedOptions[0];
    const dados = {
      tipo, tecnicoUid: tecUid, tecnicoNome: tecOpt.textContent.replace(/ \(inativo\)$/, ''),
      dataPrevista: Timestamp.fromDate(deIsoLocal(data, $('#ffHora', corpo).value || '09:00')),
      morada: $('#ffMorada', corpo).value.trim(), codigoPostal: $('#ffCP', corpo).value.trim(), localidade: $('#ffLoc', corpo).value.trim(),
      contacto: $('#ffContacto', corpo).value.trim(), telefone: $('#ffTel', corpo).value.trim(),
      descricao: $('#ffDesc', corpo).value.trim(),
      atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid,
    };
    comBotao($('#ffGuardar', corpo), async () => {
      try {
        if (ed) {
          await updateDoc(doc(db, 'folhas', folha.id), dados);
          atual = { ...atual, ...dados, atualizadoEm: Timestamp.now() };
          const i = lista.findIndex((x) => x.id === folha.id);
          if (i >= 0) lista[i] = atual;
          fecharModal();
          toast('Folha atualizada.', 'ok');
          renderDetalhe();
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

async function criarFolha(cliente, dados) {
  const ano = new Date().getFullYear();
  const cRef = doc(db, 'contadores', 'folhas-' + ano);
  const fRef = doc(collection(db, 'folhas'));
  await runTransaction(db, async (tx) => {
    const c = await tx.get(cRef);
    const n = (c.exists() ? c.data().valor : 0) + 1;
    tx.set(cRef, { valor: n });
    tx.set(fRef, {
      ...dados,
      numero: `FO-${ano}-${String(n).padStart(4, '0')}`,
      clienteId: cliente.id, clienteNome: cliente.nome, clienteNif: cliente.nif || '',
      estado: 'Agendada',
      historico: [{ estado: 'Agendada', de: null, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() }],
      observacoesTecnico: '',
      criadoEm: serverTimestamp(), criadoPor: sessao.uid, criadoPorNome: sessao.nome || sessao.email,
      estadoAlteradoEm: serverTimestamp(),
    });
  });
  return fRef.id;
}

rota();
