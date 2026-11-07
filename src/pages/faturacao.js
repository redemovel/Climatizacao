// Painel de faturação (só o Master): Concluída → Revista → (cliente exige NE: Aguarda NE → NE registada) → Faturada.
// «Exige nota de encomenda» é um campo da plataforma na ficha do cliente (clientes/{id}.exigeNE).
const sessao = await iniciarPagina({ perfis: ['master'] });

const MAX = 100;
let folhas = { rever: [], revista: [], aguarda: [] };
let clientes = {};          // clienteId -> {exigeNE, nome}
let valores = null;         // folhaId -> total (PHC), carregado a pedido
let sep = new URLSearchParams(location.search).get('s') || 'rever';

const eur = (v) => (Number(v) || 0).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
const diasDesde = (v) => (v ? Math.max(0, Math.floor((Date.now() - paraData(v).getTime()) / 86400000)) : 0);

$$('#sep button').forEach((b) => b.onclick = () => { sep = b.dataset.s; history.replaceState({}, '', pagina('faturacao', { s: sep })); render(); });
$('#btnValores').onclick = () => comBotao($('#btnValores'), carregarValores);

async function lerEstado(estado) {
  const snap = await getDocs(query(collection(db, 'folhas'), where('estado', '==', estado), orderBy('dataPrevista', 'asc'), limit(MAX)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function carregar() {
  try {
    const [rever, revista, aguarda] = await Promise.all([lerEstado('Concluída'), lerEstado('Revista'), lerEstado('Aguarda NE')]);
    folhas = { rever, revista, aguarda };
    // ficha de cada cliente (só para saber se exige NE): uma leitura por cliente
    const ids = [...new Set([...revista, ...aguarda, ...rever].map((f) => f.clienteId).filter((id) => id && !(id in clientes)))];
    await Promise.all(ids.map(async (id) => {
      try { const s = await getDoc(doc(db, 'clientes', id)); clientes[id] = s.exists() ? s.data() : {}; } catch (e) { clientes[id] = {}; }
    }));
    render();
  } catch (e) { $('#conteudo').innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
}

const exige = (f) => !!(clientes[f.clienteId] || {}).exigeNE;
function grupos() {
  return {
    rever: folhas.rever,
    pedir: folhas.revista.filter((f) => exige(f)),
    aguarda: folhas.aguarda.filter((f) => !f.ne),
    faturar: [...folhas.revista.filter((f) => !exige(f)), ...folhas.aguarda.filter((f) => f.ne)],
  };
}
function porCliente(l) {
  const m = new Map();
  for (const f of l) { const k = f.clienteId || f.clienteNome; if (!m.has(k)) m.set(k, []); m.get(k).push(f); }
  return [...m.values()].sort((a, b) => String(a[0].clienteNome).localeCompare(String(b[0].clienteNome), 'pt'));
}

function linhaFolha(f, botoes) {
  const v = valores && valores[f.id] != null ? ` · <b>${esc(eur(valores[f.id]))}</b>` : '';
  const dias = f.estado === 'Aguarda NE' ? ` · <span class="${diasDesde(f.estadoAlteradoEm) > 15 ? 'txt-erro' : ''}">há ${diasDesde(f.estadoAlteradoEm)} dias</span>` : '';
  return `<div class="fat-linha" data-f="${esc(f.id)}">
    <div class="fat-txt"><a href="${pagina('folhas', { id: f.id })}"><b>${esc(f.numero)}</b></a> <span class="tipo">${esc(f.tipo === 'AT' ? 'Assistência' : f.tipo)}</span>
      <div class="muted">${esc(f.dataPrevista ? fmtData(f.dataPrevista) : '—')} · ${esc(f.tecnicoNome || '—')}${dias}${v}${f.ne ? ` · NE ${esc(f.ne.numero)}` : ''}</div>
      ${f.descricao ? `<div class="fat-desc">${esc(f.descricao.split('\n')[0])}</div>` : ''}</div>
    <div class="fat-bts">${botoes(f)}</div>
  </div>`;
}

function render() {
  const g = grupos();
  $('#nRever').textContent = g.rever.length;
  $('#nPedir').textContent = g.pedir.length;
  $('#nAguarda').textContent = g.aguarda.length;
  $('#nFaturar').textContent = g.faturar.length;
  $$('#sep button').forEach((b) => b.classList.toggle('ativo', b.dataset.s === sep));
  const l = g[sep];
  const ajuda = {
    rever: 'Concluídas pelo técnico. Confira tempos, material e descrição na folha e marque como revista.',
    pedir: 'Revistas de clientes que exigem nota de encomenda. Peça a NE ao cliente e marque «NE pedida».',
    aguarda: 'À espera da nota de encomenda do cliente. Ao recebê-la, registe o n.º (pode cobrir várias folhas).',
    faturar: 'Prontas a faturar no PHC: revistas de clientes sem exigência de NE, ou com a NE já registada.',
  }[sep];
  if (!l.length) { $('#conteudo').innerHTML = `<p class="muted">${esc(ajuda)}</p><div class="vazio">Nada nesta fase.</div>`; return; }
  const bt = {
    rever: (f) => `<button class="btn btn-peq btn-primario" data-acao="revista" data-id="${esc(f.id)}">Revista ✓</button>`,
    pedir: () => '',
    aguarda: () => '',
    faturar: (f) => `<button class="btn btn-peq" data-acao="faturada" data-id="${esc(f.id)}">Faturada</button>`,
  }[sep];
  $('#conteudo').innerHTML = `<p class="muted" style="margin-top:0">${esc(ajuda)}${l.length >= MAX ? ' (primeiras ' + MAX + ')' : ''}</p>` + porCliente(l).map((grupo) => {
    const c = grupo[0];
    const tot = valores ? grupo.reduce((s, f) => s + (Number(valores[f.id]) || 0), 0) : null;
    const cab = sep === 'pedir' ? `<button class="btn btn-peq btn-primario" data-acao="pedir" data-cli="${esc(c.clienteId)}">NE pedida (${grupo.length})</button>`
      : sep === 'aguarda' ? `<button class="btn btn-peq btn-primario" data-acao="ne" data-cli="${esc(c.clienteId)}">Registar NE</button>` : '';
    return `<div class="cartao fat-cli" data-cli="${esc(c.clienteId)}">
      <div class="fat-cab"><div><b>${esc(c.clienteNome)}</b>${exige(c) ? ' <span class="badge estado-aguarda-ne">Exige NE</span>' : ''}
        <div class="muted">${grupo.length} folha${grupo.length > 1 ? 's' : ''}${tot != null ? ' · ' + esc(eur(tot)) : ''}</div></div>${cab}</div>
      ${grupo.map((f) => linhaFolha(f, bt)).join('')}
    </div>`;
  }).join('');
}

$('#conteudo').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-acao]');
  if (!b) return;
  const a = b.dataset.acao;
  const todas = [...folhas.rever, ...folhas.revista, ...folhas.aguarda];
  if (a === 'revista') comBotao(b, () => mudar([todas.find((f) => f.id === b.dataset.id)], 'Revista', {}, 'Folha marcada como revista.'));
  if (a === 'faturada') faturar(todas.find((f) => f.id === b.dataset.id), b);
  if (a === 'pedir') {
    const l = grupos().pedir.filter((f) => f.clienteId === b.dataset.cli);
    comBotao(b, () => mudar(l, 'Aguarda NE', { nePedidaEm: Timestamp.now() }, `${l.length} folha${l.length > 1 ? 's' : ''} a aguardar NE.`));
  }
  if (a === 'ne') registarNE(grupos().aguarda.filter((f) => f.clienteId === b.dataset.cli));
});

// muda o estado de uma ou várias folhas (uma transação por folha; histórico com utilizador e hora)
async function mudar(lista, novo, extra, msg) {
  let ok = 0;
  for (const f of lista) {
    const ref = doc(db, 'folhas', f.id);
    try {
      await runTransaction(db, async (tx) => {
        const s = await tx.get(ref);
        const d = s.data();
        if (d.estado !== f.estado) throw Object.assign(new Error(`${f.numero} foi alterada entretanto. Atualize a página.`), { code: 'alterada' });
        let aplicar = null;
        if (novo === 'Faturada') {
          const mov = movLibertarFolha(d);
          if (Object.keys(mov).length) aplicar = await aplicarReservas(tx, mov);
        }
        const entrada = { estado: novo, de: d.estado, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() };
        if (extra.numeroFatura) entrada.nota = 'Fatura ' + extra.numeroFatura;
        tx.update(ref, { ...extra, estado: novo, historico: [...(d.historico || []), entrada], estadoAlteradoEm: serverTimestamp(), atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
        if (aplicar) aplicar();
      });
      ok++;
    } catch (e) { toast(erroFirebase(e), 'erro', 6000); }
  }
  if (ok) toast(msg, 'ok');
  await carregar();
}

function faturar(f, btn) {
  const c = abrirModal('Marcar como faturada', `<p style="margin-top:0">${esc(f.numero)} · ${esc(f.clienteNome)}</p>
    <label class="campo"><span>N.º da fatura (opcional)</span><input id="fNum" autocomplete="off" placeholder="Ex.: FT 2026/123"></label>
    ${f.origem === 'phc' ? '<p class="muted">Esta folha vem do PHC: passa a «Faturada» sozinha quando faturar o dossier no PHC.</p>' : ''}
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="fOk">Faturada</button></div>`);
  $('#fOk', c).onclick = () => {
    const n = $('#fNum', c).value.trim();
    fecharModal();
    comBotao(btn, () => mudar([f], 'Faturada', n ? { numeroFatura: n } : {}, 'Folha marcada como faturada.'));
  };
}

function registarNE(lista) {
  const c = abrirModal('Registar nota de encomenda', `<p style="margin-top:0"><b>${esc(lista[0].clienteNome)}</b></p>
    <div class="grelha-2">
      <label class="campo"><span>N.º da NE *</span><input id="neNum" autocomplete="off"></label>
      <label class="campo"><span>Data</span><input type="date" id="neData" value="${isoLocal(new Date())}"></label>
    </div>
    <div class="campo"><span>Folhas abrangidas</span>${lista.map((f) => `<label class="interruptor" style="display:flex;margin:6px 0"><input type="checkbox" data-ne="${esc(f.id)}" checked> ${esc(f.numero)} — ${esc((f.descricao || '').split('\n')[0].slice(0, 60))}</label>`).join('')}</div>
    <div class="msg-erro" id="neErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="neOk">Registar</button></div>`);
  $('#neOk', c).onclick = () => {
    const numero = $('#neNum', c).value.trim();
    const sel = $$('[data-ne]', c).filter((x) => x.checked).map((x) => x.dataset.ne);
    if (!numero) { $('#neErro', c).textContent = 'Indique o n.º da nota de encomenda.'; return; }
    if (!sel.length) { $('#neErro', c).textContent = 'Escolha pelo menos uma folha.'; return; }
    const ne = { numero, data: Timestamp.fromDate(deIsoLocal($('#neData', c).value || isoLocal(new Date()))), registadaEm: Timestamp.now(), uid: sessao.uid };
    comBotao($('#neOk', c), async () => {
      try {
        const b = writeBatch(db);
        for (const id of sel) b.update(doc(db, 'folhas', id), { ne, atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
        await b.commit();
        fecharModal();
        toast(`NE ${numero} registada em ${sel.length} folha${sel.length > 1 ? 's' : ''}: passa${sel.length > 1 ? 'm' : ''} para «A faturar».`, 'ok', 5000);
        await carregar();
      } catch (e) { $('#neErro', c).textContent = erroFirebase(e); }
    });
  };
}

// totais (só PHC: folhas/{id}/privado/phc.totalVenda), lidos a pedido
async function carregarValores() {
  const l = [...folhas.revista, ...folhas.aguarda, ...folhas.rever];
  valores = {};
  await Promise.all(l.map(async (f) => {
    try { const s = await getDoc(doc(db, 'folhas', f.id, 'privado', 'phc')); if (s.exists() && s.data().totalVenda != null) valores[f.id] = s.data().totalVenda; } catch (e) { /* sem valor */ }
  }));
  $('#btnValores').classList.add('oculto');
  render();
}

carregar();
