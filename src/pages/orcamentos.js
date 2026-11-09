// Orçamentos (só o Master: têm preços e custos). Fluxo: Rascunho → Enviado (email com link para a página pública) →
// Aceite / Rejeitado (resposta do cliente na página, ou registada à mão) → folha de obra. Anulado: retirado.
// orcamentos/{id}: documento interno (com custos). propostas/{código}: cópia congelada para o cliente (sem custos).
const sessao = await iniciarPagina({ perfis: ['master'] });

const COND_PADRAO = 'Validade da proposta: 30 dias.\nPrazo de execução: a combinar após adjudicação.\nCondições de pagamento: 30 dias após faturação.\nAos valores acresce IVA à taxa legal em vigor.\nGarantia: conforme a legislação em vigor.';
let sep = new URLSearchParams(location.search).get('s') || 'Enviado';
let lista = [];
let cursor = null;
let atual = null;

$$('#sep button').forEach((b) => b.onclick = () => { sep = b.dataset.s; history.replaceState({}, '', pagina('orcamentos', { s: sep })); carregarLista(); });
$('#btnNovo').onclick = () => abrirEditor(null);
$('#btnMais').onclick = () => comBotao($('#btnMais'), () => carregarLista(true));

function codigoAleatorio() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => a[x % a.length]).join('');
}
function linkProposta(codigo) { return new URL('proposta' + (ENV === 'dev' ? '-dev' : '') + '.html?c=' + codigo, location.href).href; }
function estadoVisivel(o) { return o.estado === 'Enviado' && o.validade && paraData(o.validade) < inicioDia(new Date()) ? 'Expirado' : o.estado; }
function badgeOrc(o) {
  const e = estadoVisivel(o);
  const cls = { Rascunho: 'estado-por-agendar', Enviado: 'estado-agendada', Aceite: 'estado-concluida', Rejeitado: 'estado-pendente', Anulado: 'estado-anulada', Expirado: 'estado-pendente' }[e] || '';
  return `<span class="badge ${cls}" id="detEstado">${esc(e)}</span>`;
}

// ---------- Lista ----------
async function carregarLista(mais = false) {
  $$('#sep button').forEach((b) => b.classList.toggle('ativo', b.dataset.s === sep));
  contarPedidos();
  if (sep === 'pedidos') { $('#maisWrap').classList.add('oculto'); return listarPedidos(); }
  if (!mais) { lista = []; cursor = null; $('#lista').innerHTML = '<div class="vazio">A carregar…</div>'; }
  try {
    const c = [where('estado', '==', sep), orderBy('criadoEm', 'desc')];
    if (cursor) c.push(startAfter(cursor));
    c.push(limit(PAGINA_TAM));
    const snap = await getDocs(query(collection(db, 'orcamentos'), ...c));
    let novos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (sep === 'Enviado') novos = await sincronizarRespostas(novos);
    lista = lista.concat(novos);
    cursor = snap.docs[snap.docs.length - 1] || cursor;
    $('#maisWrap').classList.toggle('oculto', snap.docs.length < PAGINA_TAM);
    $('#lista').innerHTML = lista.length ? lista.map((o) => `
      <a class="lista-item" href="${pagina('orcamentos', { id: o.id })}" data-id="${esc(o.id)}">
        <div class="li-topo"><span class="li-titulo">${esc(o.numero)} · ${esc(o.clienteNome)}</span>${badgeOrc(o).replace(' id="detEstado"', '')}</div>
        <div class="li-sub">${esc(o.assunto || '')}</div>
        <div class="li-meta"><b>${esc(eurP(totaisProposta(o.linhas, o.ivaTaxa).total))}</b> c/IVA${o.folhaNumero ? ' · ' + esc(o.folhaNumero) : ''}
          ${o.estado === 'Enviado' ? ` · ${o.vistoEm ? 'visto ' + esc(fmtDataHora(o.vistoEm)) : 'ainda não visto'}` : ''}
          ${o.envio && o.envio.estado === 'Erro' ? ' · <span class="txt-erro">email não enviado</span>' : ''}</div>
      </a>`).join('') : '<div class="vazio">Nada neste estado.</div>';
  } catch (e) { $('#lista').innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
}
// a resposta do cliente fica na proposta pública: traz para o orçamento (a PontePHC também o faz e avisa por email)
async function sincronizarRespostas(l) {
  return Promise.all(l.map(async (o) => {
    if (!o.codigo) return o;
    try {
      const s = await getDoc(doc(db, 'propostas', o.codigo));
      if (!s.exists()) return o;
      const p = s.data();
      const alt = {};
      if (p.vistoEm && !o.vistoEm) alt.vistoEm = p.vistoEm;
      if (['Aceite', 'Rejeitado'].includes(p.estado) && o.estado === 'Enviado') Object.assign(alt, { estado: p.estado, respostaNome: p.respostaNome || '', respostaNota: p.respostaNota || '', respostaNE: p.respostaNE || '', respondidoEm: p.respondidoEm || Timestamp.now() });
      if (Object.keys(alt).length) { await updateDoc(doc(db, 'orcamentos', o.id), alt); return { ...o, ...alt }; }
    } catch (e) { /* mantém */ }
    return o;
  }));
}
// pedidos de orçamento: folhas pendentes com motivo «Orçamento» ainda sem orçamento
let pedidos = null;
async function lerPedidos() {
  if (!pedidos) {
    const snap = await getDocs(query(collection(db, 'folhas'), where('estado', '==', 'Pendente'), orderBy('criadoEm', 'desc'), limit(50)));
    pedidos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((f) => f.pendencia && f.pendencia.motivo === 'Orçamento' && !f.orcamentoId);
  }
  return pedidos;
}
async function contarPedidos() { try { $('#nPedidos').textContent = (await lerPedidos()).length; } catch (e) { $('#nPedidos').textContent = '?'; } }
async function listarPedidos() {
  try {
    const l = await lerPedidos();
    $('#lista').innerHTML = '<p class="muted" style="margin-top:0">Folhas pendentes à espera de orçamento (pedido do técnico ou do backoffice).</p>' + (l.length ? l.map((f) => `
      <div class="lista-item b-pendente"><div class="li-topo"><a class="li-titulo" href="${pagina('folhas', { id: f.id })}">${esc(f.numero)} · ${esc(f.clienteNome)}</a>
        <button class="btn btn-peq btn-primario" data-pedido="${esc(f.id)}">Criar orçamento</button></div>
        <div class="li-sub">${esc(f.descricao || '')}</div>
        ${f.pendencia.nota ? `<div class="li-meta">Nota: ${esc(f.pendencia.nota)} — ${esc(f.pendencia.nome || '')}</div>` : ''}</div>`).join('') : '<div class="vazio">Sem pedidos de orçamento.</div>');
    $$('[data-pedido]').forEach((b) => b.onclick = () => abrirEditor(null, l.find((f) => f.id === b.dataset.pedido)));
  } catch (e) { $('#lista').innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
}
$('#lista').addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-id]');
  if (!a || ev.metaKey || ev.ctrlKey) return;
  ev.preventDefault();
  irPara({ id: a.dataset.id });
});
function irPara(params) { history.pushState({}, '', pagina('orcamentos', params)); rota(); }
window.addEventListener('popstate', rota);
function rota() {
  const p = new URLSearchParams(location.search);
  fecharModal();
  if (p.get('id')) { abrirDetalhe(p.get('id')); return; }
  $('#vDetalhe').classList.add('oculto');
  $('#vLista').classList.remove('oculto');
  carregarLista();
}

// ---------- Detalhe ----------
async function abrirDetalhe(id) {
  $('#vLista').classList.add('oculto');
  const v = $('#vDetalhe');
  v.classList.remove('oculto');
  v.innerHTML = '<div class="vazio">A carregar…</div>';
  try {
    const s = await getDoc(doc(db, 'orcamentos', id));
    if (!s.exists()) { v.innerHTML = '<div class="vazio">Orçamento não encontrado.</div>'; return; }
    atual = (await sincronizarRespostas([{ id: s.id, ...s.data() }]))[0];
    renderDetalhe();
  } catch (e) { v.innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
}
function margem(o) {
  const linhas = o.linhas || [];
  if (!linhas.some((l) => l.custo != null && l.custo !== '')) return null;
  const venda = linhas.reduce((s, l) => s + totalLinha(l), 0);
  const custo = linhas.reduce((s, l) => s + (Number(l.custo) || 0) * (Number(l.qtd) || 0), 0);
  return { venda, custo, margem: venda - custo, pct: venda ? ((venda - custo) / venda) * 100 : 0 };
}
function renderDetalhe() {
  const o = atual;
  const e = estadoVisivel(o);
  const t = totaisProposta(o.linhas, o.ivaTaxa);
  const m = margem(o);
  const v = $('#vDetalhe');
  v.innerHTML = `
    <button class="voltar" id="btnVoltar">‹ Orçamentos</button>
    <div class="cartao">
      <div class="det-cab"><div><h1 id="detNumero">${esc(o.numero)}</h1><span class="muted">${esc(o.assunto || '')}</span></div><div>${badgeOrc(o)}</div></div>
      <dl class="dl">
        <div><dt>Cliente</dt><dd>${esc(o.clienteNome)}${o.clienteNif ? `<br><span class="muted">NIF ${esc(o.clienteNif)}</span>` : ''}</dd></div>
        <div><dt>Total</dt><dd><b>${esc(eurP(t.total))}</b> <span class="muted">(${esc(eurP(t.base))} + IVA)</span>
          ${m ? `<br><span class="muted" id="detMargem">Custo ${esc(eurP(m.custo))} · margem ${esc(eurP(m.margem))} (${esc(m.pct.toFixed(0))}%)</span>` : ''}</dd></div>
        <div><dt>Validade</dt><dd>${esc(o.validade ? fmtData(o.validade) : '—')}</dd></div>
        ${o.folhaId ? `<div><dt>Folha de obra</dt><dd><a href="${pagina('folhas', { id: o.folhaId })}" id="detFolha">${esc(o.folhaNumero)}</a></dd></div>` : ''}
        ${o.envio ? `<div><dt>Email</dt><dd>${o.envio.estado === 'Enviado' ? `Enviado para ${esc(o.envio.para)} em ${esc(fmtDataHora(o.envio.em))}` : o.envio.estado === 'Erro' ? `<span class="txt-erro">Não enviado: ${esc(o.envio.erro || '')}</span>` : esc(o.envio.estado)}</dd></div>`
          : o.enviadoPara ? `<div><dt>Email</dt><dd>A enviar para ${esc(o.enviadoPara)}…</dd></div>` : ''}
        ${o.estado === 'Enviado' ? `<div><dt>Cliente abriu</dt><dd>${o.vistoEm ? esc(fmtDataHora(o.vistoEm)) : 'Ainda não'}</dd></div>` : ''}
        ${o.respostaNome ? `<div class="desc-destaque"><dt>Resposta</dt><dd id="detResposta">${esc(o.estado)} por <b>${esc(o.respostaNome)}</b>${o.respondidoEm ? ' em ' + esc(fmtDataHora(o.respondidoEm)) : ''}
          ${o.respostaNE ? `<br>Nota de encomenda: <b>${esc(o.respostaNE)}</b>` : ''}${o.respostaNota ? `<br>«${esc(o.respostaNota)}»` : ''}</dd></div>` : ''}
        ${o.notasInternas ? `<div><dt>Notas internas</dt><dd style="white-space:pre-wrap">${esc(o.notasInternas)}</dd></div>` : ''}
      </dl>
      <div class="acoes" style="flex-wrap:wrap">
        ${['Rascunho', 'Enviado'].includes(o.estado) ? '<button class="btn" id="btnEditar">Editar</button>' : ''}
        ${['Rascunho', 'Enviado'].includes(o.estado) ? `<button class="btn btn-primario" id="btnEnviar">${o.estado === 'Rascunho' ? 'Enviar ao cliente' : 'Reenviar'}</button>` : ''}
        ${o.codigo ? '<button class="btn" id="btnLink">Copiar link</button>' : ''}
        ${o.estado === 'Enviado' ? '<button class="btn" id="btnAceiteManual">Aceite (por telefone/email)</button><button class="btn" id="btnRejeitadoManual">Não aceite</button>' : ''}
        ${o.estado === 'Aceite' && !o.folhaId ? '<button class="btn btn-primario" id="btnCriarFolha">Criar folha de obra</button>' : ''}
        ${o.estado === 'Aceite' && o.folhaId ? '<button class="btn btn-primario" id="btnRetomar">Retomar a folha</button>' : ''}
        <button class="btn" id="btnDuplicar">Duplicar</button>
        ${['Rascunho', 'Enviado'].includes(o.estado) ? '<button class="btn btn-perigo" id="btnAnular">Anular</button>' : ''}
      </div>
    </div>
    <div class="cartao" style="padding:0;overflow-x:auto">${htmlProposta({ ...o, data: o.enviadoEm || o.criadoEm })}</div>`;
  $('#btnVoltar').onclick = () => { if (history.length > 1) history.back(); else irPara({}); };
  const on = (id, fn) => { const b = $('#' + id); if (b) b.onclick = () => fn(b); };
  on('btnEditar', () => abrirEditor(atual));
  on('btnEnviar', () => enviar());
  on('btnLink', async () => { try { await navigator.clipboard.writeText(linkProposta(atual.codigo)); toast('Link copiado.', 'ok'); } catch (e) { prompt('Link da proposta:', linkProposta(atual.codigo)); } });
  on('btnAceiteManual', () => respostaManual(true));
  on('btnRejeitadoManual', () => respostaManual(false));
  on('btnCriarFolha', () => criarFolhaDoOrcamento());
  on('btnRetomar', (b) => retomarFolha(b));
  on('btnDuplicar', () => abrirEditor({ ...atual, id: null, numero: '', estado: 'Rascunho', codigo: '', envio: null, enviadoPara: '', vistoEm: null, respostaNome: '', respostaNota: '', respostaNE: '', folhaId: '', folhaNumero: '' }));
  on('btnAnular', (b) => anular(b));
  window.scrollTo(0, 0);
}

// ---------- Editor ----------
let precos = null;
async function tabelaPrecos() { if (!precos) { try { const s = await getDoc(doc(db, 'config', 'precosHora')); precos = s.exists() ? s.data() : { linhas: [] }; } catch (e) { precos = { linhas: [] }; } } return precos; }

async function abrirEditor(o, folhaPedido = null) {
  const ed = !!(o && o.id);
  let cliente = o && o.clienteId ? { id: o.clienteId, nome: o.clienteNome, nif: o.clienteNif, email: o.clienteEmail, morada: o.morada, codigoPostal: o.codigoPostal, localidade: o.localidade } : null;
  if (!cliente && folhaPedido) {
    try { const s = await getDoc(doc(db, 'clientes', folhaPedido.clienteId)); cliente = s.exists() ? { id: s.id, ...s.data() } : { id: folhaPedido.clienteId, nome: folhaPedido.clienteNome, nif: folhaPedido.clienteNif }; } catch (e) { cliente = { id: folhaPedido.clienteId, nome: folhaPedido.clienteNome }; }
  }
  const linhas = ((o && o.linhas) || []).map((l) => ({ ...l }));
  const folha = folhaPedido ? { id: folhaPedido.id, numero: folhaPedido.numero } : (o && o.folhaId ? { id: o.folhaId, numero: o.folhaNumero } : null);
  const validadeDias = o && o.validadeDias ? o.validadeDias : 30;
  const c = abrirModal(ed ? 'Editar ' + o.numero : 'Novo orçamento', `
    <div class="campo"><span>Cliente *</span><div id="oCli"></div></div>
    ${folha ? `<p class="muted" style="margin:-4px 0 10px">Ligado à folha <b>${esc(folha.numero)}</b></p>` : ''}
    <label class="campo"><span>Assunto *</span><input id="oAssunto" maxlength="200" value="${esc((o && o.assunto) || (folhaPedido ? 'Reparação: ' + (folhaPedido.descricao || '').split('\n')[0].slice(0, 150) : ''))}"></label>
    <label class="campo"><span>Introdução (opcional)</span><textarea id="oIntro" placeholder="Ex.: Na sequência da visita técnica, apresentamos a nossa proposta para…">${esc((o && o.introducao) || '')}</textarea></label>
    <div class="campo"><span>Linhas</span><div id="oLinhas"></div>
      <div class="acoes" style="justify-content:flex-start;flex-wrap:wrap;margin-top:6px">
        <button type="button" class="btn btn-peq" id="oMaisArt">+ Artigo do stock</button>
        <button type="button" class="btn btn-peq" id="oMaisMO">+ Mão de obra</button>
        <button type="button" class="btn btn-peq" id="oMaisLivre">+ Linha livre</button></div></div>
    <div id="oTotais" class="ok-at" style="margin:6px 0 12px"></div>
    <div class="linha2">
      <label class="campo"><span>IVA (%)</span><input type="number" id="oIva" min="0" max="23" step="1" inputmode="decimal" value="${esc(String(o && o.ivaTaxa != null ? o.ivaTaxa : 23))}"></label>
      <label class="campo"><span>Validade (dias)</span><input type="number" id="oVal" min="1" max="365" value="${esc(String(validadeDias))}"></label>
    </div>
    <label class="campo"><span>Condições</span><textarea id="oCond" rows="5">${esc((o && o.condicoes) || COND_PADRAO)}</textarea></label>
    <label class="campo"><span>Notas internas (não vão para o cliente)</span><textarea id="oNotas">${esc((o && o.notasInternas) || (folhaPedido && folhaPedido.pendencia && folhaPedido.pendencia.nota ? 'Pedido do técnico: ' + folhaPedido.pendencia.nota : ''))}</textarea></label>
    <div class="msg-erro" id="oErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="oGuardar">Guardar</button></div>`);
  c.closest('.modal').classList.add('modal-largo');

  const desenharCliente = () => {
    $('#oCli', c).innerHTML = cliente
      ? `<div class="cliente-escolhido"><b>${esc(cliente.nome)}</b> <span class="muted">${esc(cliente.nif || '')}</span>${ed || folhaPedido ? '' : ' <button type="button" class="btn btn-peq" id="oTrocar">Trocar</button>'}</div>`
      : '<div style="display:flex;gap:8px"><input id="oCliQ" placeholder="Nome, sigla ou NIF" autocomplete="off"><button type="button" class="btn" id="oCliBtn">Procurar</button></div><div id="oCliRes"></div>';
    if ($('#oTrocar', c)) $('#oTrocar', c).onclick = () => { cliente = null; desenharCliente(); };
    if ($('#oCliBtn', c)) $('#oCliBtn', c).onclick = () => comBotao($('#oCliBtn', c), async () => {
      const l = await pesquisarClientes($('#oCliQ', c).value, { soAtivos: true }).catch(() => []);
      $('#oCliRes', c).innerHTML = l.map((x, i) => `<button type="button" class="artigo-op" data-c="${i}"><b>${esc(x.nome)}</b> <span class="muted">${esc(x.localidade || '')}</span></button>`).join('') || '<p class="muted">Nenhum cliente.</p>';
      $$('[data-c]', c).forEach((b) => b.onclick = () => { cliente = l[+b.dataset.c]; desenharCliente(); });
    });
  };
  desenharCliente();

  const lerLinhas = () => $$('[data-l]', c).forEach((row) => {
    const l = linhas[+row.dataset.l];
    l.descricao = $('[data-k=descricao]', row).value.trim();
    for (const k of ['qtd', 'preco', 'desconto', 'custo']) { const i = $(`[data-k=${k}]`, row); if (i) l[k] = i.value === '' ? (k === 'custo' ? null : 0) : Number(String(i.value).replace(',', '.')); }
    l.unidade = $('[data-k=unidade]', row).value.trim();
  });
  const desenharTotais = () => {
    lerLinhas();
    const t = totaisProposta(linhas, Number($('#oIva', c).value) || 0);
    const m = margem({ linhas });
    $('#oTotais', c).innerHTML = `Total s/IVA <b>${esc(eurP(t.base))}</b> · c/IVA <b id="oTotal">${esc(eurP(t.total))}</b>${m ? ` <span class="muted">· margem ${esc(eurP(m.margem))} (${esc(m.pct.toFixed(0))}%)</span>` : ''}`;
  };
  const desenharLinhas = () => {
    $('#oLinhas', c).innerHTML = linhas.length ? linhas.map((l, i) => `<div class="orc-linha" data-l="${i}">
      <div style="display:flex;gap:6px"><input data-k="descricao" placeholder="Descrição *" value="${esc(l.descricao || '')}"><button type="button" class="lixo" data-x="${i}" aria-label="Tirar">✕</button></div>
      ${l.ref ? `<div class="muted" style="font-size:.78rem">${esc(l.ref)}${l.tipo === 'mo' ? '' : ''}</div>` : ''}
      <div class="orc-num">
        <label>Qtd.<input data-k="qtd" type="number" step="any" inputmode="decimal" value="${esc(String(l.qtd ?? 1))}"></label>
        <label>Un.<input data-k="unidade" value="${esc(l.unidade || '')}" maxlength="8"></label>
        <label>Preço €<input data-k="preco" type="number" step="0.01" inputmode="decimal" value="${esc(String(l.preco ?? ''))}"></label>
        <label>Desc. %<input data-k="desconto" type="number" step="any" inputmode="decimal" value="${esc(String(l.desconto || ''))}"></label>
        <label>Custo €<input data-k="custo" type="number" step="0.01" inputmode="decimal" value="${esc(l.custo == null ? '' : String(l.custo))}" placeholder="—"></label>
      </div></div>`).join('') : '<p class="muted" style="margin:0">Sem linhas.</p>';
    $$('[data-x]', c).forEach((b) => b.onclick = () => { lerLinhas(); linhas.splice(+b.dataset.x, 1); desenharLinhas(); });
    $$('#oLinhas input', c).forEach((i) => i.oninput = desenharTotais);
    desenharTotais();
  };
  desenharLinhas();
  $('#oIva', c).oninput = desenharTotais;
  const nova = (l) => { lerLinhas(); linhas.push({ id: Date.now().toString(36) + linhas.length, qtd: 1, desconto: 0, unidade: 'un', ...l }); desenharLinhas(); };
  $('#oMaisLivre', c).onclick = () => nova({ tipo: 'livre', descricao: '', preco: 0, custo: null });
  $('#oMaisArt', c).onclick = () => escolherArtigo(c, nova);
  $('#oMaisMO', c).onclick = () => escolherMO(c, nova);

  $('#oGuardar', c).onclick = () => {
    lerLinhas();
    const erro = (m) => { $('#oErro', c).textContent = m; };
    if (!cliente) return erro('Escolha o cliente.');
    const assunto = $('#oAssunto', c).value.trim();
    if (!assunto) return erro('Indique o assunto.');
    if (!linhas.length) return erro('Acrescente pelo menos uma linha.');
    if (linhas.some((l) => !l.descricao)) return erro('Todas as linhas precisam de descrição.');
    if (linhas.some((l) => !(Number(l.qtd) > 0))) return erro('Todas as linhas precisam de quantidade.');
    const dias = Math.max(1, Math.min(365, Math.round(Number($('#oVal', c).value) || 30)));
    const dados = {
      clienteId: cliente.id, clienteNome: cliente.nome, clienteNif: cliente.nif || '', clienteEmail: (o && o.clienteEmail) || cliente.email || '',
      morada: cliente.morada || '', codigoPostal: cliente.codigoPostal || '', localidade: cliente.localidade || '',
      assunto, introducao: $('#oIntro', c).value.trim(), linhas: linhas.map((l) => ({ id: l.id, tipo: l.tipo || 'livre', ref: l.ref || '', artigoId: l.artigoId || '', descricao: l.descricao,
        qtd: Number(l.qtd) || 0, unidade: l.unidade || '', preco: Number(l.preco) || 0, desconto: Number(l.desconto) || 0, custo: l.custo == null || l.custo === '' ? null : Number(l.custo) })),
      ivaTaxa: Math.max(0, Math.min(23, Number($('#oIva', c).value) || 0)), validadeDias: dias,
      validade: Timestamp.fromDate(addDias(inicioDia(new Date()), dias)), condicoes: $('#oCond', c).value.trim(), notasInternas: $('#oNotas', c).value.trim(),
      atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid,
    };
    dados.total = totaisProposta(dados.linhas, dados.ivaTaxa).total;
    comBotao($('#oGuardar', c), async () => {
      try {
        let id = o && o.id;
        if (ed) {
          dados.pesquisa = tokensPesquisa(o.numero, cliente.nome, cliente.nif, assunto).slice(0, 200);
          await updateDoc(doc(db, 'orcamentos', id), dados);
          // se já foi enviado e ainda não teve resposta, a proposta do cliente acompanha a alteração
          if (o.estado === 'Enviado' && o.codigo) await setDoc(doc(db, 'propostas', o.codigo), dadosProposta({ ...o, ...dados, validade: dados.validade }), { merge: true });
        } else {
          const ano = new Date().getFullYear();
          const cRef = doc(db, 'contadores', 'orcamentos-' + ano);
          const ref = doc(collection(db, 'orcamentos'));
          id = ref.id;
          await runTransaction(db, async (tx) => {
            const s = await tx.get(cRef);
            const fRef = folha ? doc(db, 'folhas', folha.id) : null;
            const n = (s.exists() ? s.data().valor : 0) + 1;
            const numero = `ORC-${ano}-${String(n).padStart(4, '0')}`;
            tx.set(cRef, { valor: n });
            tx.set(ref, { ...dados, numero, estado: 'Rascunho', codigo: '', folhaId: folha ? folha.id : '', folhaNumero: folha ? folha.numero : '',
              pesquisa: tokensPesquisa(numero, cliente.nome, cliente.nif, assunto).slice(0, 200), criadoEm: serverTimestamp(), criadoPor: sessao.uid, criadoPorNome: sessao.nome || sessao.email });
            if (fRef) tx.update(fRef, { orcamentoId: id, orcamentoNumero: numero, atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
          });
          pedidos = null;
        }
        fecharModal();
        toast('Orçamento guardado.', 'ok');
        history.replaceState({}, '', pagina('orcamentos', { id }));
        abrirDetalhe(id);
      } catch (e) { erro(erroFirebase(e)); }
    });
  };
}

function escolherArtigo(cEditor, nova) {
  const box = document.createElement('div');
  box.className = 'cartao';
  box.innerHTML = `<div style="display:flex;gap:6px"><input id="aQ" placeholder="Referência ou designação" autocomplete="off"><button type="button" class="btn" id="aBtn">Procurar</button><button type="button" class="btn" id="aFechar">✕</button></div><div id="aRes"></div>`;
  $('#oLinhas', cEditor).after(box);
  $('#aQ', box).focus();
  $('#aFechar', box).onclick = () => box.remove();
  const procurar = () => comBotao($('#aBtn', box), async () => {
    const l = await pesquisarArtigos($('#aQ', box).value).catch(() => []);
    $('#aRes', box).innerHTML = l.slice(0, 15).map((a, i) => `<button type="button" class="artigo-op" data-a="${i}"><b>${esc(a.ref)}</b> ${esc(a.design)} <span class="muted">· disp. ${esc(fmtQtd(disponivel(a)))} ${esc(a.unidade || '')}</span></button>`).join('') || '<p class="muted">Nenhum artigo.</p>';
    $$('[data-a]', box).forEach((b) => b.onclick = async () => {
      const a = l[+b.dataset.a];
      let custo = null;
      try { const s = await getDoc(doc(db, 'artigos', a.id, 'privado', 'custo')); if (s.exists()) custo = Number(s.data().custo) || null; } catch (e) { /* sem custo */ }
      box.remove();
      nova({ tipo: 'artigo', artigoId: a.id, ref: a.ref, descricao: a.design, unidade: a.unidade || 'un', preco: custo ? Math.round(custo * 1.35 * 100) / 100 : 0, custo });
    });
  });
  $('#aBtn', box).onclick = procurar;
  $('#aQ', box).onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); procurar(); } };
}

async function escolherMO(cEditor, nova) {
  const t = await tabelaPrecos();
  const ls = (t.linhas || []).filter((l) => l.preco);
  const box = document.createElement('div');
  box.className = 'cartao';
  box.innerHTML = ls.length ? `<label class="campo"><span>Mão de obra (tabela de preço/hora)</span><select id="mLinha">${ls.map((l, i) => `<option value="${i}">${esc(l.tipo)} · ${esc(l.composicao)} — ${esc(eurP(l.preco))}/h</option>`).join('')}</select></label>
    <div class="linha2"><label class="campo"><span>Horas</span><input type="number" id="mHoras" min="0.5" step="0.5" value="2" inputmode="decimal"></label>
    <div class="acoes" style="align-items:flex-end"><button type="button" class="btn" id="mFechar">Cancelar</button><button type="button" class="btn btn-primario" id="mOk">Acrescentar</button></div></div>`
    : '<p class="muted">A tabela de preço/hora está vazia (Utilizadores › Preço/hora). <button type="button" class="btn btn-peq" id="mFechar">Fechar</button></p>';
  $('#oLinhas', cEditor).after(box);
  $('#mFechar', box).onclick = () => box.remove();
  if (!ls.length) return;
  $('#mOk', box).onclick = () => {
    const l = ls[+$('#mLinha', box).value];
    box.remove();
    nova({ tipo: 'mo', ref: 'MO', descricao: `Mão de obra — ${l.composicao}`, unidade: 'h', qtd: Number($('#mHoras', box).value) || 1, preco: l.preco, custo: null });
  };
}

// ---------- Enviar ----------
function dadosProposta(o) {
  return {
    orcamentoId: o.id, numero: o.numero, estado: 'Enviado', clienteNome: o.clienteNome, clienteNif: o.clienteNif || '', morada: o.morada || '', codigoPostal: o.codigoPostal || '', localidade: o.localidade || '',
    assunto: o.assunto || '', introducao: o.introducao || '', condicoes: o.condicoes || '', ivaTaxa: o.ivaTaxa,
    linhas: (o.linhas || []).map((l) => ({ ref: l.tipo === 'mo' ? '' : (l.ref || ''), descricao: l.descricao, qtd: l.qtd, unidade: l.unidade || '', preco: l.preco, desconto: l.desconto || 0 })),
    validade: o.validade, data: Timestamp.now(), notificar: 'nao',
  };
}
function emailProposta(o, para, link) {
  const t = totaisProposta(o.linhas, o.ivaTaxa);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:680px;margin:0 auto">
    ${cabecalhoEmail('Proposta ' + o.numero)}
    <div style="padding:16px 18px;font-size:14px">
      <p style="margin:0 0 12px">Exmos. Senhores,</p>
      <p style="margin:0 0 12px">Enviamos a nossa proposta <b>${esc(o.numero)}</b>${o.assunto ? ` — ${esc(o.assunto)}` : ''}, no valor de <b>${esc(eurP(t.total))}</b> (IVA incluído), válida até ${esc(fmtData(o.validade))}.</p>
      <p style="margin:18px 0"><a href="${esc(link)}" style="background:${COR_ARPURO};color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold;display:inline-block">Ver a proposta e responder</a></p>
      <p style="margin:0 0 12px;font-size:13px;color:#475569">Na página pode consultar o detalhe, guardar em PDF e aceitar ou recusar a proposta. Se o botão não funcionar, copie este endereço para o navegador:<br><span style="word-break:break-all">${esc(link)}</span></p>
      <p style="margin:0">Com os melhores cumprimentos,<br>Arpuro Climatização</p>
      <p style="margin:18px 0 0;font-size:12px;color:#64748b">ARPURO &amp; REDEMÓVEL, LDA · NIF 503198749 · São João da Madeira<br>Para qualquer questão, responda a este email.</p>
    </div></div>`;
  const texto = `Arpuro Climatização — proposta ${o.numero}\n\n${o.assunto || ''}\nValor: ${eurP(t.total)} (IVA incluído), válida até ${fmtData(o.validade)}.\n\nVer a proposta e responder: ${link}\n\nPara qualquer questão, responda a este email.`;
  return { tipo: 'orcamento', estado: 'Pendente', para, assunto: `Proposta ${o.numero} — ${o.assunto || o.clienteNome} — Arpuro Climatização`, html, texto, assinaturaPng: '',
    folhaId: '', orcamentoId: o.id, folhaNumero: o.numero, criadoPor: sessao.uid, criadoPorNome: sessao.nome || sessao.email, criadoEm: serverTimestamp() };
}
function enviar() {
  const o = atual;
  const c = abrirModal((o.estado === 'Rascunho' ? 'Enviar ' : 'Reenviar ') + o.numero, `
    <p style="margin-top:0">${esc(o.clienteNome)} · <b>${esc(eurP(totaisProposta(o.linhas, o.ivaTaxa).total))}</b> c/IVA</p>
    <label class="campo"><span>Email do cliente *</span><input type="email" id="eEmail" inputmode="email" value="${esc(o.clienteEmail || '')}" placeholder="email@cliente.pt"></label>
    <p class="muted" style="font-size:.85rem">O cliente recebe um email com o link para ver, guardar em PDF e aceitar ou recusar. Cópia oculta para rbastos@arpuro.pt.</p>
    <div class="msg-erro" id="eErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="eOk">Enviar</button></div>`);
  $('#eOk', c).onclick = () => {
    const para = $('#eEmail', c).value.trim();
    if (!/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(para)) { $('#eErro', c).textContent = 'Indique um email válido.'; return; }
    comBotao($('#eOk', c), async () => {
      try {
        const codigo = o.codigo || codigoAleatorio();
        const validade = o.estado === 'Rascunho' ? Timestamp.fromDate(addDias(inicioDia(new Date()), o.validadeDias || 30)) : o.validade;
        const oo = { ...o, validade };
        const link = linkProposta(codigo);
        const b = writeBatch(db);
        b.set(doc(db, 'propostas', codigo), dadosProposta(oo));
        b.set(doc(collection(db, 'emails')), emailProposta(oo, para, link));
        b.update(doc(db, 'orcamentos', o.id), { estado: 'Enviado', codigo, validade, clienteEmail: para, enviadoPara: para, enviadoEm: serverTimestamp(), envio: null, atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
        await b.commit();
        fecharModal();
        toast('Proposta a enviar para ' + para + '.', 'ok', 5000);
        abrirDetalhe(o.id);
      } catch (e) { $('#eErro', c).textContent = erroFirebase(e); }
    });
  };
}

// ---------- Resposta registada à mão, folha, anular ----------
function respostaManual(aceite) {
  const c = abrirModal(aceite ? 'Registar aceitação' : 'Registar recusa', `
    <label class="campo"><span>Quem respondeu *</span><input id="rNome" maxlength="120"></label>
    ${aceite ? '<label class="campo"><span>N.º da nota de encomenda</span><input id="rNE" maxlength="60"></label>' : ''}
    <label class="campo"><span>Nota</span><textarea id="rNota" maxlength="1000" placeholder="${aceite ? 'Ex.: aceite por telefone' : 'Motivo'}"></textarea></label>
    <div class="msg-erro" id="rErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="rOk">Guardar</button></div>`);
  $('#rOk', c).onclick = () => {
    const nome = $('#rNome', c).value.trim();
    if (nome.length < 2) { $('#rErro', c).textContent = 'Indique quem respondeu.'; return; }
    const alt = { estado: aceite ? 'Aceite' : 'Rejeitado', respostaNome: nome, respostaNE: aceite ? $('#rNE', c).value.trim() : '', respostaNota: $('#rNota', c).value.trim(), respondidoEm: Timestamp.now(), respostaManual: true };
    comBotao($('#rOk', c), async () => {
      try {
        const b = writeBatch(db);
        b.update(doc(db, 'orcamentos', atual.id), { ...alt, atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
        if (atual.codigo) b.update(doc(db, 'propostas', atual.codigo), { estado: alt.estado, respostaNome: nome, respostaNE: alt.respostaNE, respostaNota: alt.respostaNota, respondidoEm: serverTimestamp(), notificar: 'nao' });
        await b.commit();
        fecharModal();
        toast(aceite ? 'Aceitação registada.' : 'Recusa registada.', 'ok');
        abrirDetalhe(atual.id);
      } catch (e) { $('#rErro', c).textContent = erroFirebase(e); }
    });
  };
}
function criarFolhaDoOrcamento() {
  const o = atual;
  const c = abrirModal('Folha de obra para ' + o.numero, `
    <div class="campo"><span>Tipo *</span><div class="chips">${TIPOS.map((t) => `<label><input type="radio" name="tipo" value="${esc(t)}" ${t === 'Instalação' ? 'checked' : ''}><span>${esc(TIPO_NOME[t])}</span></label>`).join('')}</div></div>
    <p class="muted">A folha nasce «Por agendar», com a descrição do orçamento. Agende-a na Agenda › Equipa.</p>
    <div class="msg-erro" id="cErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="cOk">Criar folha</button></div>`);
  $('#cOk', c).onclick = () => comBotao($('#cOk', c), async () => {
    try {
      const sc = await getDoc(doc(db, 'clientes', o.clienteId));
      const cliente = sc.exists() ? { id: sc.id, ...sc.data() } : { id: o.clienteId, nome: o.clienteNome, nif: o.clienteNif };
      const tipo = $('input[name=tipo]:checked', c).value;
      const descricao = `${o.assunto} (orçamento ${o.numero}${o.respostaNE ? ', NE ' + o.respostaNE : ''})\n` + o.linhas.map((l) => `- ${fmtQtd(l.qtd)} ${l.unidade || ''} ${l.descricao}`).join('\n');
      const oRef = doc(db, 'orcamentos', o.id);
      const id = await criarFolhaNova(cliente, {
        tipo, tecnicoUid: '', tecnicoNome: '', dataPrevista: null, morada: cliente.morada || o.morada || '', codigoPostal: cliente.codigoPostal || '', localidade: cliente.localidade || '',
        contacto: cliente.contacto || '', telefone: cliente.telefone || '', clienteEmail: o.clienteEmail || cliente.email || '', descricao: descricao.slice(0, 4900),
        duracaoPrevista: (o.linhas.filter((l) => l.tipo === 'mo').reduce((s, l) => s + (Number(l.qtd) || 0), 0)) || 0, orcamentoId: o.id, orcamentoNumero: o.numero,
      });
      const sf = await getDoc(doc(db, 'folhas', id));
      await updateDoc(oRef, { folhaId: id, folhaNumero: sf.data().numero, atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
      fecharModal();
      toast('Folha ' + sf.data().numero + ' criada (Por agendar).', 'ok', 5000);
      abrirDetalhe(o.id);
    } catch (e) { $('#cErro', c).textContent = erroFirebase(e); }
  });
}
// orçamento aceite de uma folha parada «Pendente — Orçamento»: passa a «Pendente — Peças» (encomendar) ou retoma «Em curso»
async function retomarFolha(btn) {
  const ref = doc(db, 'folhas', atual.folhaId);
  const c = abrirModal('Retomar ' + atual.folhaNumero, `
    <p style="margin-top:0">O orçamento foi aceite. O que se segue na folha?</p>
    <div class="acoes" style="flex-direction:column;align-items:stretch">
      <button class="btn" data-r="pecas">Encomendar peças (Pendente — Peças)</button>
      <button class="btn btn-primario" data-r="agendar">Pronta a agendar (Por agendar)</button></div>
    <div class="msg-erro" id="tErro"></div>`);
  $$('[data-r]', c).forEach((b) => b.onclick = () => comBotao(b, async () => {
    try {
      await runTransaction(db, async (tx) => {
        const s = await tx.get(ref);
        const d = s.data();
        const nota = `Orçamento ${atual.numero} aceite${atual.respostaNE ? ' (NE ' + atual.respostaNE + ')' : ''}`;
        let alt;
        if (b.dataset.r === 'pecas') {
          if (d.estado !== 'Pendente') throw new Error(`A folha está «${d.estado}».`);
          alt = { pendencia: { ...d.pendencia, motivo: 'Peças', nota, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() } };
        } else {
          alt = { estado: 'Por agendar', pendencia: null, historico: [...(d.historico || []), { estado: 'Por agendar', de: d.estado, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now(), nota }], estadoAlteradoEm: serverTimestamp() };
        }
        tx.update(ref, { ...alt, atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
      });
      fecharModal();
      toast('Folha atualizada.', 'ok');
    } catch (e) { $('#tErro', c).textContent = erroFirebase(e); }
  }));
}
async function anular(btn) {
  if (!(await confirmar(`Anular ${atual.numero}?${atual.codigo ? ' O cliente deixa de poder aceitar pela página.' : ''}`, { ok: 'Anular', perigo: true }))) return;
  await comBotao(btn, async () => {
    try {
      const b = writeBatch(db);
      b.update(doc(db, 'orcamentos', atual.id), { estado: 'Anulado', atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
      if (atual.codigo) b.update(doc(db, 'propostas', atual.codigo), { estado: 'Retirada' });
      await b.commit();
      toast('Orçamento anulado.', 'ok');
      abrirDetalhe(atual.id);
    } catch (e) { toast(erroFirebase(e), 'erro'); }
  });
}

rota();
