// Guias de Transporte AC (série 111 no PHC): uma por viatura, com o cliente como destinatário.
// Só podem levar até ao stock disponível do armazém da climatização. A comunicação à AT (código AT) é feita
// pela PontePHC + GuiasAT (Fase 5): sem código AT a guia não pode sair nem ser impressa.
// Da guia importa-se para a folha de obra só o que foi gasto; o que sobra é devolvido ao fechar a guia.
const sessao = await iniciarPagina({ perfis: ['master', 'backoffice', 'tecnico'] });
const staff = ehStaff(sessao.perfil);
const tecnico = sessao.perfil === 'tecnico';
const ESTADOS_GUIA_ABERTOS = ['Por comunicar', 'Comunicada'];

let lista = [];
let cursor = null;
let atual = null;

if (tecnico) $('#tituloLista').textContent = 'As minhas guias';
$('#btnNova').classList.remove('oculto');
$('#btnNova').onclick = () => irPara({ nova: 1 });
$('#fEstado').onchange = () => carregarLista();
$('#btnMais').onclick = () => comBotao($('#btnMais'), () => carregarLista(true));

const saldo = (l) => r3((l.qtd || 0) - (l.consumido || 0) - (l.devolvido || 0));
const nomeGuia = (g) => g.numero ? 'GTAC ' + g.numero : 'Guia por comunicar';

// ---------- Lista ----------
async function carregarLista(mais = false) {
  if (!mais) { lista = []; cursor = null; $('#lista').innerHTML = '<div class="vazio">A carregar…</div>'; }
  const est = $('#fEstado').value;
  const c = [];
  if (tecnico) c.push(where('tecnicoUid', '==', sessao.uid));
  c.push(est === 'abertas' ? where('estado', 'in', ESTADOS_GUIA_ABERTOS) : where('estado', '==', est));
  c.push(orderBy('criadoEm', 'desc'));
  if (cursor) c.push(startAfter(cursor));
  c.push(limit(PAGINA_TAM));
  try {
    const snap = await getDocs(query(collection(db, 'guias'), ...c));
    lista = lista.concat(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    cursor = snap.docs[snap.docs.length - 1] || cursor;
    $('#maisWrap').classList.toggle('oculto', snap.docs.length < PAGINA_TAM);
    $('#lista').innerHTML = lista.length ? lista.map((g) => `
      <a class="lista-item ${classeEstado(g.estado).replace('estado-', 'b-')}" href="${pagina('guias', { id: g.id })}" data-id="${esc(g.id)}">
        <div class="li-topo"><span class="li-titulo">${esc(nomeGuia(g))} · ${esc(g.clienteNome)}</span>${badgeEstado(g.estado)}</div>
        <div class="li-sub">${esc(g.viatura)} · ${esc(fmtDataHora(g.dataSaida))} · ${esc(g.tecnicoNome || '')}</div>
        <div class="li-meta">${(g.linhas || []).length} artigos${g.folhaNumero ? ' · ' + esc(g.folhaNumero) : ''}${(g.linhas || []).some((l) => saldo(l) > 0) && g.estado === 'Comunicada' ? ' · com material por gastar' : ''}</div>
      </a>`).join('') : '<div class="vazio">Sem guias.</div>';
  } catch (e) { $('#lista').innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
}
$('#lista').addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-id]');
  if (!a || ev.metaKey || ev.ctrlKey) return;
  ev.preventDefault();
  irPara({ id: a.dataset.id });
});

function irPara(params) { history.pushState({}, '', pagina('guias', params)); rota(); }
window.addEventListener('popstate', rota);
function rota() {
  const p = new URLSearchParams(location.search);
  fecharModal();
  if (p.get('nova')) { formNova(p.get('folha')); return; }
  if (p.get('id')) { abrirDetalhe(p.get('id')); return; }
  $('#vDetalhe').classList.add('oculto');
  $('#vLista').classList.remove('oculto');
  if (!lista.length) carregarLista();
}
const voltar = () => `<button class="voltar" id="btnVoltar">‹ ${tecnico ? 'As minhas guias' : 'Guias de transporte'}</button>`;
function ligarVoltar() { $('#btnVoltar').onclick = () => { if (history.state !== null && history.length > 1) history.back(); else irPara(null); }; }
function mostrar(html) {
  $('#vLista').classList.add('oculto');
  const v = $('#vDetalhe');
  v.classList.remove('oculto');
  v.innerHTML = voltar() + html;
  ligarVoltar();
  window.scrollTo(0, 0);
}

// ---------- Detalhe ----------
async function abrirDetalhe(id) {
  mostrar('<div class="vazio">A carregar…</div>');
  try {
    const s = await getDoc(doc(db, 'guias', id));
    if (!s.exists()) { mostrar('<div class="vazio">Guia não encontrada.</div>'); return; }
    atual = { id: s.id, ...s.data() };
    renderDetalhe();
  } catch (e) { mostrar(`<div class="vazio">${esc(erroFirebase(e))}</div>`); }
}

function renderDetalhe() {
  const g = atual;
  const meu = staff || g.tecnicoUid === sessao.uid;
  mostrar(`
    <div class="cartao">
      <div class="det-cab"><div><h1 id="detNumero">${esc(nomeGuia(g))}</h1><span class="tipo">Guia de Transporte AC · viatura ${esc(g.viatura)}</span></div>
        <div>${badgeEstado(g.estado)}</div></div>
      ${g.estado === 'Por comunicar' ? `<p class="aviso-at" id="avisoAT"><b>Sem código AT.</b> A guia ainda não foi comunicada à Autoridade Tributária: o material não pode sair e a guia não pode ser impressa.</p>`
        : g.codigoAT ? `<p class="ok-at">Código AT <b id="codigoAT">${esc(g.codigoAT)}</b></p>` : ''}
      <dl class="dl">
        <div><dt>Destinatário (cliente)</dt><dd>${esc(g.clienteNome)}${g.clienteNif ? `<br><span class="muted">NIF ${esc(g.clienteNif)}</span>` : ''}</dd></div>
        <div><dt>Local de descarga</dt><dd>${esc([g.morada, [g.codigoPostal, g.localidade].filter(Boolean).join(' ')].filter(Boolean).join('\n') || '—')}</dd></div>
        <div><dt>Carga</dt><dd>Armazém ${esc(String(g.armazem || 99))} · ${esc(fmtDiaSemana(paraData(g.dataSaida)))}, ${esc(fmtHora(g.dataSaida))}</dd></div>
        <div><dt>Técnico</dt><dd>${esc(g.tecnicoNome || '—')}</dd></div>
        ${g.folhaId ? `<div><dt>Folha de obra prevista</dt><dd><a href="${pagina('folhas', { id: g.folhaId })}">${esc(g.folhaNumero || 'abrir')}</a></dd></div>` : ''}
      </dl>
    </div>
    <div class="cartao">
      <h3 style="margin-top:0">Material</h3>
      <table class="tabela-guia" id="linhasGuia"><thead><tr><th>Artigo</th><th class="n">Levou</th><th class="n">Gasto</th><th class="n">${g.estado === 'Fechada' ? 'Devolvido' : 'Por gastar'}</th></tr></thead><tbody>
        ${(g.linhas || []).map((l) => `<tr><td><b>${esc(l.ref)}</b><br>${esc(l.design)}${(l.series || []).length ? `<br>${l.series.map((x) => `<span class="serie-tag" style="${(l.seriesUsadas || []).includes(x) ? 'text-decoration:line-through' : ''}">${esc(x)}</span>`).join('')}` : ''}${(l.consumos || []).length ? `<br><span class="muted">${l.consumos.map((c) => `${esc(c.numero)}: ${esc(fmtQtd(c.qtd))}`).join(' · ')}</span>` : ''}</td>
          <td class="n">${esc(fmtQtd(l.qtd))} ${esc(l.unidade || '')}</td><td class="n">${esc(fmtQtd(l.consumido || 0))}</td>
          <td class="n">${esc(fmtQtd(g.estado === 'Fechada' ? (l.devolvido || 0) : saldo(l)))}</td></tr>`).join('')}
      </tbody></table>
    </div>
    ${meu && ['Por comunicar', 'Comunicada'].includes(g.estado) ? `<div class="cartao estados-acoes">
      ${g.codigoAT ? '<button class="btn btn-sec" id="btnImprimir">Imprimir</button>' : ''}
      ${g.estado === 'Comunicada' ? '<button class="btn" id="btnFechar">Fechar guia (devolver o que sobrou)</button>' : ''}
      ${g.estado === 'Por comunicar' ? '<button class="btn btn-perigo" id="btnAnular">Anular guia</button>' : ''}
    </div>` : ''}
    <div class="cartao">
      <h3 style="margin-top:0">Histórico</h3>
      <ul class="hist">${(g.historico || []).slice().reverse().map((h) => `<li>${badgeEstado(h.estado)}<span>${esc(h.nome || '')}${h.nota ? ' · ' + esc(h.nota) : ''}</span><span class="muted">${esc(fmtDataHora(h.em))}</span></li>`).join('')}</ul>
    </div>`);
  if ($('#btnImprimir')) $('#btnImprimir').onclick = () => window.print();
  if ($('#btnFechar')) $('#btnFechar').onclick = () => fecharGuia($('#btnFechar'));
  if ($('#btnAnular')) $('#btnAnular').onclick = () => anularGuia($('#btnAnular'));
}

// Fechar: o que não foi gasto deixa de estar na guia (volta ao disponível do armazém).
async function fecharGuia(btn) {
  const sobra = (atual.linhas || []).filter((l) => saldo(l) > 0.0005);
  const msg = sobra.length
    ? `Fechar a guia? Fica registado como devolvido: ${sobra.map((l) => `${fmtQtd(saldo(l))} ${l.unidade || ''} de ${l.ref}`).join(', ')}. O regresso deste material ao armazém precisa de documento de transporte próprio.`
    : 'Fechar a guia? Todo o material foi passado para folhas de obra.';
  if (!(await confirmar(msg, { ok: 'Fechar guia' }))) return;
  await mudarGuia(btn, 'Fechada', (g) => {
    const mov = {};
    const linhas = g.linhas.map((l) => {
      const x = saldo(l);
      if (x > 0) (mov[l.artigoId] = mov[l.artigoId] || { resGuias: 0 }).resGuias -= x;
      return { ...l, devolvido: r3((l.devolvido || 0) + Math.max(x, 0)) };
    });
    return { alt: { linhas }, mov };
  }, sobra.length ? 'Devolvido o que sobrou' : '');
}
async function anularGuia(btn) {
  if (!(await confirmar('Anular esta guia? O material volta a ficar disponível.', { ok: 'Anular', perigo: true }))) return;
  await mudarGuia(btn, 'Anulada', (g) => {
    const mov = {};
    for (const l of g.linhas) (mov[l.artigoId] = mov[l.artigoId] || { resGuias: 0 }).resGuias -= saldo(l);
    return { alt: {}, mov };
  }, '');
}
async function mudarGuia(btn, novo, fn, nota) {
  await comBotao(btn, async () => {
    try {
      const ref = doc(db, 'guias', atual.id);
      const res = await runTransaction(db, async (tx) => {
        const s = await tx.get(ref);
        const g = s.data();
        if (g.estado !== atual.estado) throw Object.assign(new Error('A guia foi alterada por outra pessoa. Atualize a página.'), { code: 'guia' });
        const { alt, mov } = fn(g);
        const aplicar = Object.keys(mov).length ? await aplicarReservas(tx, mov) : null;
        // n.º de série que não foram aplicados deixam de estar na guia
        for (const l of g.linhas) for (const sr of (l.series || []).filter((x) => !(l.seriesUsadas || []).includes(x))) tx.delete(doc(db, 'series', idSerie(sr)));
        const h = { estado: novo, de: g.estado, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() };
        if (nota) h.nota = nota;
        const tudo = { ...alt, estado: novo, historico: [...(g.historico || []), h], atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid };
        tx.update(ref, tudo);
        if (aplicar) aplicar();
        return { ...g, ...tudo };
      });
      atual = { id: atual.id, ...res };
      lista = [];
      toast('Guia ' + (novo === 'Fechada' ? 'fechada.' : 'anulada.'), 'ok');
      renderDetalhe();
    } catch (e) { toast(['stock', 'artigo', 'guia', 'serie'].includes(e.code) ? e.message : erroFirebase(e), 'erro', 6000); }
  });
}

// ---------- Nova guia ----------
async function formNova(folhaId) {
  let folha = null, cliente = null;
  const linhas = [];
  mostrar('<div class="vazio">A carregar…</div>');
  try {
    if (folhaId) {
      const s = await getDoc(doc(db, 'folhas', folhaId));
      if (s.exists()) folha = { id: s.id, ...s.data() };
    }
  } catch (e) { toast(erroFirebase(e), 'erro'); }
  if (tecnico && !folha) {
    mostrar('<div class="cartao"><p style="margin:0">Para criar uma guia, abra a folha de obra e use «Nova guia de transporte».</p></div>');
    return;
  }
  if (folha) cliente = { id: folha.clienteId, nome: folha.clienteNome, nif: folha.clienteNif || '', morada: folha.morada || '', cp: folha.codigoPostal || '', loc: folha.localidade || '' };
  let viaturas = [];
  try { const v = await getDoc(doc(db, 'listas', 'viaturas')); if (v.exists()) viaturas = v.data().itens || []; } catch (e) { /* sem lista */ }
  const tecs = staff ? await carregarTecnicos().catch(() => []) : [];
  const agora = new Date(Date.now() + 10 * 60000);
  mostrar(`
    <div class="cartao">
      <h1 style="margin-top:0">Nova guia de transporte</h1>
      <p class="muted" style="margin-top:0">Fica «Por comunicar»: só pode sair depois de ter código AT.</p>
      <div class="campo"><span>Cliente (destinatário) *</span><div id="gCliente"></div></div>
      ${folha ? `<p class="muted">Folha de obra: <b>${esc(folha.numero)}</b></p>` : ''}
      ${staff ? `<label class="campo"><span>Técnico *</span><select id="gTec"><option value="">—</option>${tecs.map((t) => `<option value="${esc(t.uid)}" ${folha && folha.tecnicoUid === t.uid ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></label>` : ''}
      <label class="campo"><span>Viatura (matrícula) *</span>${viaturas.length
        ? `<select id="gViatura"><option value="">—</option>${viaturas.map((v) => `<option>${esc(v)}</option>`).join('')}</select>`
        : '<input id="gViatura" maxlength="12" placeholder="AA-00-AA" autocomplete="off">'}</label>
      <div class="grelha-2">
        <label class="campo"><span>Dia de saída *</span><input type="date" id="gDia" value="${isoLocal(agora)}"></label>
        <label class="campo"><span>Hora *</span><input type="time" id="gHora" value="${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}"></label>
      </div>
    </div>
    <div class="cartao">
      <h3 style="margin-top:0">Material (armazém 99)</h3>
      <div style="display:flex;gap:8px"><input id="gProc" autocomplete="off" placeholder="Referência, nome ou n.º de série"><button class="btn" id="gProcBtn" type="button">Procurar</button></div>
      <div id="gRes" style="margin-top:8px"></div>
      <div id="gLinhas"></div>
    </div>
    <div class="msg-erro" id="gErro"></div>
    <div class="acoes"><button class="btn" id="gCancelar">Cancelar</button><button class="btn btn-primario" id="gGuardar">Criar guia</button></div>`);
  const desenharCliente = () => {
    $('#gCliente').innerHTML = cliente
      ? `<div class="cliente-escolhido"><b>${esc(cliente.nome)}</b><br><span class="muted">${esc([cliente.morada, cliente.cp, cliente.loc].filter(Boolean).join(', '))}</span>${!folha ? ' <button type="button" class="btn btn-peq" id="gTrocar">Trocar</button>' : ''}</div>`
      : `<div style="display:flex;gap:8px"><input id="gCliProc" placeholder="Nome, NIF ou localidade" autocomplete="off"><button type="button" class="btn" id="gCliBtn">Procurar</button></div><div id="gCliRes"></div>`;
    if ($('#gTrocar')) $('#gTrocar').onclick = () => { cliente = null; desenharCliente(); };
    if ($('#gCliBtn')) $('#gCliBtn').onclick = () => comBotao($('#gCliBtn'), async () => {
      const l = await pesquisarClientes($('#gCliProc').value, { soAtivos: true }).catch((e) => { toast(erroFirebase(e), 'erro'); return []; });
      $('#gCliRes').innerHTML = l.map((x, i) => `<button type="button" class="artigo-op" data-c="${i}"><b>${esc(x.nome)}</b> <span class="muted">${esc(x.localidade || '')}</span></button>`).join('') || '<p class="muted">Nenhum cliente.</p>';
      $$('[data-c]').forEach((b) => b.onclick = () => {
        const x = l[+b.dataset.c];
        cliente = { id: x.id, nome: x.nome, nif: x.nif || '', morada: x.morada || '', cp: x.codigoPostal || '', loc: x.localidade || '' };
        desenharCliente();
      });
    });
  };
  desenharCliente();
  const desenharLinhas = () => {
    $('#gLinhas').innerHTML = linhas.length ? `<table class="tabela-guia"><thead><tr><th>Artigo</th><th class="n">Qtd.</th><th></th></tr></thead><tbody>
      ${linhas.map((l, i) => `<tr><td><b>${esc(l.a.ref)}</b><br>${esc(l.a.design)}<br><span class="muted">disponível ${esc(fmtQtd(disponivel(l.a)))} ${esc(l.a.unidade || '')}</span>
          ${l.a.comSerie ? `<div class="series-campos" style="margin-top:6px">${Array.from({ length: Math.max(0, Math.min(50, Math.floor(l.qtd || 0))) }, (_, k) =>
            `<input data-sl="${i}" data-sk="${k}" autocomplete="off" placeholder="N.º de série ${k + 1} *" value="${esc((l.series || [])[k] || '')}">`).join('') || '<span class="muted">Com n.º de série: indique a quantidade.</span>'}</div>` : ''}</td>
        <td class="n"><input type="number" inputmode="decimal" min="0" step="${l.a.comSerie ? '1' : 'any'}" value="${l.qtd || ''}" data-q="${i}" style="width:86px"></td>
        <td><button type="button" class="lixo" data-x="${i}" aria-label="Tirar">✕</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">Ainda sem material.</p>';
    $$('[data-q]').forEach((inp) => {
      inp.oninput = () => { linhas[+inp.dataset.q].qtd = r3(String(inp.value).replace(',', '.')); };
      inp.onchange = () => { if (linhas[+inp.dataset.q].a.comSerie) { desenharLinhas(); } };
    });
    $$('[data-sl]').forEach((inp) => inp.oninput = () => { const l = linhas[+inp.dataset.sl]; (l.series = l.series || [])[+inp.dataset.sk] = inp.value; });
    $$('[data-x]').forEach((b) => b.onclick = () => { linhas.splice(+b.dataset.x, 1); desenharLinhas(); });
  };
  desenharLinhas();
  const procurar = () => comBotao($('#gProcBtn'), async () => {
    const t = $('#gProc').value.trim();
    if (t.length < 2) return;
    // n.º de série de um equipamento em armazém: acrescenta logo a linha do artigo com esse n.º
    if (t.length >= 3 && !/\s/.test(t)) {
      const r = await procurarSerie(t).catch(() => null);
      if (r && r.uso) { $('#gRes').innerHTML = `<p class="aviso-concl">O n.º de série ${esc(r.uso.serie)} já está ${r.uso.estado === 'guia' ? 'na guia ' + esc(r.uso.guiaNumero || '(por comunicar)') : 'aplicado na ' + esc(r.uso.folhaNumero || 'outra folha')}.</p>`; return; }
      if (r && r.artigo) {
        let lin = linhas.find((x) => x.a.id === r.artigo.id);
        if (!lin) { lin = { a: r.artigo, qtd: 0, series: [] }; linhas.push(lin); }
        lin.series = (lin.series || []).slice(0, lin.qtd).filter(Boolean);
        if (lin.series.map(idSerie).includes(idSerie(r.serie))) { toast('Esse n.º de série já está na guia.', 'erro'); return; }
        lin.series.push(r.serie);
        lin.qtd = lin.series.length;
        $('#gRes').innerHTML = ''; $('#gProc').value = '';
        desenharLinhas();
        toast(`N.º de série ${r.serie}: ${r.artigo.ref} acrescentado.`, 'ok');
        return;
      }
    }
    const l = await pesquisarArtigos(t).catch((e) => { toast(erroFirebase(e), 'erro'); return []; });
    $('#gRes').innerHTML = l.length ? `<div class="lista-artigos">${l.map((x, i) => `
      <button type="button" class="artigo-op" data-a="${i}" ${disponivel(x) > 0 ? '' : 'disabled'}><b>${esc(x.ref)}</b> ${esc(x.design)}<span class="${disponivel(x) > 0 ? 'disp' : 'disp zero'}">${esc(fmtQtd(disponivel(x)))} ${esc(x.unidade || '')} disp.</span></button>`).join('')}</div>`
      : '<p class="muted">Nenhum artigo encontrado.</p>';
    $$('[data-a]').forEach((b) => b.onclick = () => {
      const a = l[+b.dataset.a];
      if (!linhas.some((x) => x.a.id === a.id)) linhas.push({ a, qtd: 0 });
      $('#gRes').innerHTML = ''; $('#gProc').value = '';
      desenharLinhas();
      const ult = $$('[data-q]').pop(); if (ult) ult.focus();
    });
  });
  $('#gProcBtn').onclick = procurar;
  $('#gProc').onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); procurar(); } };
  $('#gCancelar').onclick = () => { if (folha) location.href = pagina('folhas', { id: folha.id }); else irPara(null); };
  $('#gGuardar').onclick = () => {
    const erro = (m) => { $('#gErro').textContent = m; };
    const viatura = $('#gViatura').value.trim().toUpperCase().replace(/\s+/g, '');
    const tecUid = staff ? $('#gTec').value : sessao.uid;
    const tecNome = staff ? ((tecs.find((t) => t.uid === tecUid) || {}).nome || '') : (sessao.nome || sessao.email);
    if (!cliente) return erro('Escolha o cliente (destinatário).');
    if (!tecUid) return erro('Escolha o técnico.');
    if (viatura.length < 6) return erro('Indique a matrícula da viatura.');
    if (!$('#gDia').value || !$('#gHora').value) return erro('Indique o dia e a hora de saída.');
    const saida = deIsoLocal($('#gDia').value, $('#gHora').value);
    if (saida < new Date(Date.now() - 5 * 60000)) return erro('A hora de saída não pode ser no passado: a guia tem de ser comunicada antes de o material sair.');
    if (!linhas.length) return erro('Acrescente pelo menos um artigo.');
    const sem = linhas.find((l) => !(l.qtd > 0));
    if (sem) return erro(`Indique a quantidade de ${sem.a.ref}.`);
    const excede = linhas.find((l) => l.qtd > disponivel(l.a) + 0.0005);
    if (excede) return erro(`${excede.a.ref}: só há ${fmtQtd(disponivel(excede.a))} ${excede.a.unidade || ''} disponíveis.`);
    const todasSeries = [];
    for (const l of linhas) {
      if (!l.a.comSerie) { l.series = []; continue; }
      if (!Number.isInteger(l.qtd)) return erro(`${l.a.ref}: equipamento com n.º de série, a quantidade tem de ser em unidades.`);
      l.series = (l.series || []).slice(0, l.qtd).map(limparSerie);
      if (l.series.length !== l.qtd || l.series.some((x) => x.length < 3)) return erro(`${l.a.ref}: indique o n.º de série de cada unidade.`);
      todasSeries.push(...l.series);
    }
    if (new Set(todasSeries.map(idSerie)).size !== todasSeries.length) return erro('Há números de série repetidos.');
    comBotao($('#gGuardar'), async () => {
      try {
        const ref = doc(collection(db, 'guias'));
        await runTransaction(db, async (tx) => {
          const mov = {};
          for (const l of linhas) (mov[l.a.id] = mov[l.a.id] || { resGuias: 0 }).resGuias += l.qtd;
          const aplicar = await aplicarReservas(tx, mov, new Set(Object.keys(mov)));
          for (const sr of todasSeries) {
            const x = await tx.get(doc(db, 'series', idSerie(sr)));
            if (x.exists()) {
              const i = x.data();
              throw Object.assign(new Error(i.estado === 'folha' ? `O n.º de série ${sr} já foi aplicado na ${i.folhaNumero}.` : `O n.º de série ${sr} já está noutra guia aberta.`), { code: 'stock' });
            }
          }
          for (const l of linhas) for (const sr of l.series) tx.set(doc(db, 'series', idSerie(sr)), { serie: sr, artigoId: l.a.id, ref: l.a.ref, estado: 'guia', guiaId: ref.id, guiaNumero: '', folhaId: '', folhaNumero: '', atualizadoEm: serverTimestamp(), uid: sessao.uid });
          tx.set(ref, {
            numero: '', codigoAT: '', estado: 'Por comunicar', armazem: 99,
            clienteId: cliente.id, clienteNome: cliente.nome, clienteNif: cliente.nif, morada: cliente.morada, codigoPostal: cliente.cp, localidade: cliente.loc,
            folhaId: folha ? folha.id : '', folhaNumero: folha ? folha.numero : '',
            tecnicoUid: tecUid, tecnicoNome: tecNome, viatura, dataSaida: Timestamp.fromDate(saida),
            linhas: linhas.map((l) => ({ id: novoId(), artigoId: l.a.id, ref: l.a.ref, design: l.a.design, unidade: l.a.unidade || '', qtd: l.qtd, consumido: 0, devolvido: 0, consumos: [],
              ...(l.series.length ? { series: l.series, seriesUsadas: [] } : {}) })),
            historico: [{ estado: 'Por comunicar', de: null, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() }],
            criadoEm: serverTimestamp(), criadoPor: sessao.uid, criadoPorNome: sessao.nome || sessao.email,
          });
          aplicar();
        });
        toast('Guia criada. Aguarda comunicação à AT.', 'ok', 5000);
        lista = [];
        history.replaceState({}, '', pagina('guias', { id: ref.id }));
        abrirDetalhe(ref.id);
      } catch (e) { erro(['stock', 'artigo'].includes(e.code) ? e.message : erroFirebase(e)); }
    });
  };
}
function novoId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

rota();
