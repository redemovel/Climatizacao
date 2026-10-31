const sessao = await iniciarPagina({ perfis: ['master', 'backoffice'] });

let lista = [];
let cursor = null;
let modo = 'todos';        // 'todos' (paginado por nome) ou 'pesquisa'
let listaCarregada = false;
let atual = null;

$('#info').textContent = 'Fonte: registo local. A sincronização com o PHC será ativada numa fase seguinte.';

// ---------- Lista e pesquisa ----------
async function carregarLista(mais = false) {
  modo = 'todos';
  if (!mais) { lista = []; cursor = null; $('#lista').innerHTML = '<div class="vazio">A carregar…</div>'; }
  const c = [orderBy('nomePesquisa')];
  if (cursor) c.push(startAfter(cursor));
  c.push(limit(PAGINA_TAM));
  try {
    const snap = await getDocs(query(collection(db, 'clientes'), ...c));
    lista = lista.concat(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    cursor = snap.docs[snap.docs.length - 1] || cursor;
    $('#maisWrap').classList.toggle('oculto', snap.docs.length < PAGINA_TAM);
    listaCarregada = true;
    renderLista('Ainda não há clientes registados.');
  } catch (e) { $('#lista').innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
}

function renderLista(vazio) {
  $('#lista').innerHTML = lista.length ? lista.map((c) => `
    <a class="lista-item" href="${pagina('clientes', { id: c.id })}" data-id="${esc(c.id)}">
      <div class="li-topo"><span class="li-titulo">${esc(c.nome)}</span><span class="muted">${esc(c.nif)}</span></div>
      <div class="li-sub">${esc([c.localidade, c.telefone].filter(Boolean).join(' · '))}</div>
    </a>`).join('') : `<div class="vazio">${esc(vazio)}</div>`;
}

$('#fPesq').onsubmit = async (ev) => {
  ev.preventDefault();
  const q = $('#q').value.trim();
  if (!q) { carregarLista(); return; }
  if (q.length < 2) { toast('Escreva pelo menos 2 letras.'); return; }
  modo = 'pesquisa';
  $('#lista').innerHTML = '<div class="vazio">A procurar…</div>';
  $('#maisWrap').classList.add('oculto');
  try {
    lista = await pesquisarClientes(q);
    renderLista('Nenhum cliente encontrado.');
  } catch (e) { $('#lista').innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
};
$('#btnMais').onclick = () => comBotao($('#btnMais'), () => carregarLista(true));
$('#btnNovo').onclick = () => abrirForm(null);
$('#btnImportar').onclick = () => abrirImportacao();
$('#lista').addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-id]');
  if (!a) return;
  ev.preventDefault();
  irPara({ id: a.dataset.id });
});

// ---------- Navegação ----------
function irPara(params) { history.pushState({}, '', pagina('clientes', params)); rota(); }
window.addEventListener('popstate', rota);
function rota() {
  const p = new URLSearchParams(location.search);
  fecharModal();
  if (p.get('id')) { abrirFicha(p.get('id')); return; }
  $('#vFicha').classList.add('oculto');
  $('#vLista').classList.remove('oculto');
  if (!listaCarregada) carregarLista();
  else renderLista('Sem resultados.');
  if (p.get('novo')) abrirForm(null);
}

// ---------- Ficha ----------
async function abrirFicha(id) {
  $('#vLista').classList.add('oculto');
  const v = $('#vFicha');
  v.classList.remove('oculto');
  v.innerHTML = '<div class="vazio">A carregar…</div>';
  window.scrollTo(0, 0);
  try {
    const s = await getDoc(doc(db, 'clientes', id));
    if (!s.exists()) { v.innerHTML = '<button class="voltar" id="btnVoltar">‹ Clientes</button><div class="vazio">Cliente não encontrado.</div>'; ligarVoltar(); return; }
    atual = { id: s.id, ...s.data() };
    renderFicha();
  } catch (e) { v.innerHTML = `<button class="voltar" id="btnVoltar">‹ Clientes</button><div class="vazio">${esc(erroFirebase(e))}</div>`; ligarVoltar(); }
}
function ligarVoltar() {
  $('#btnVoltar').onclick = () => { if (history.state !== null && history.length > 1) history.back(); else irPara(null); };
}

function renderFicha() {
  const c = atual;
  const tel = linkTel(c.telefone);
  const mapa = linkMapa(c);
  $('#vFicha').innerHTML = `
    <button class="voltar" id="btnVoltar">‹ Clientes</button>
    <div class="cartao">
      <div class="det-cab"><div><h1 id="fichaNome">${esc(c.nome)}</h1><span class="muted">NIF ${esc(c.nif)}${c.phcId ? ' · PHC ' + esc(c.phcId) : ''}</span></div>
        <button class="btn btn-peq" id="btnEditar">Editar</button></div>
      <dl class="dl">
        <div><dt>Morada</dt><dd>${esc([c.morada, [c.codigoPostal, c.localidade].filter(Boolean).join(' ')].filter(Boolean).join('\n') || '—')}</dd></div>
        <div><dt>Contacto</dt><dd>${esc(c.contacto || '—')}</dd></div>
        <div><dt>Telefone</dt><dd>${tel ? `<a href="${esc(tel)}">${esc(c.telefone)}</a>` : '—'}</dd></div>
        <div><dt>Email</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</dd></div>
        <div><dt>Observações</dt><dd>${esc(c.observacoes || '—')}</dd></div>
      </dl>
      <div class="acoes-rapidas">
        <a class="btn btn-primario" href="${pagina('folhas', { nova: 1, cliente: c.id })}">+ Folha de obra</a>
        ${mapa ? `<a class="btn btn-sec" href="${esc(mapa)}" target="_blank" rel="noopener">Ver no mapa</a>` : ''}
      </div>
    </div>
    <div class="cartao">
      <h3 style="margin-top:0">Folhas de obra</h3>
      <div id="folhasCli"><button class="btn btn-sec btn-bloco" id="btnVerFolhas">Ver folhas deste cliente</button></div>
    </div>`;
  ligarVoltar();
  $('#btnEditar').onclick = () => abrirForm(atual);
  $('#btnVerFolhas').onclick = () => carregarFolhasCliente();
}

let cursorFolhas = null;
async function carregarFolhasCliente(mais = false) {
  const box = $('#folhasCli');
  if (!mais) { cursorFolhas = null; box.innerHTML = '<div class="vazio">A carregar…</div>'; }
  const c = [where('clienteId', '==', atual.id), orderBy('criadoEm', 'desc')];
  if (cursorFolhas) c.push(startAfter(cursorFolhas));
  c.push(limit(10));
  try {
    const snap = await getDocs(query(collection(db, 'folhas'), ...c));
    $('#maisFolhas')?.remove();
    if (!mais) box.innerHTML = '';
    cursorFolhas = snap.docs[snap.docs.length - 1] || cursorFolhas;
    const html = snap.docs.map((d) => { const f = d.data(); return `
      <a class="lista-item ${classeEstado(f.estado).replace('estado-', 'b-')}" href="${pagina('folhas', { id: d.id })}">
        <div class="li-topo"><span class="li-titulo">${esc(f.numero)}</span>${badgeEstado(f.estado)}</div>
        <div class="li-meta"><span class="tipo">${esc(TIPO_NOME[f.tipo] || f.tipo)}</span><span>${esc(fmtDataHora(f.dataPrevista))}</span><span>· ${esc(f.tecnicoNome || '')}</span></div>
      </a>`; }).join('');
    box.insertAdjacentHTML('beforeend', html || (mais ? '' : '<div class="vazio">Sem folhas de obra.</div>'));
    if (snap.docs.length === 10) {
      box.insertAdjacentHTML('beforeend', '<div class="mais" id="maisFolhas"><button class="btn btn-peq">Carregar mais</button></div>');
      $('#maisFolhas button').onclick = () => carregarFolhasCliente(true);
    }
  } catch (e) { box.innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
}

// ---------- Formulário ----------
function abrirForm(c) {
  const ed = !!c;
  const corpo = abrirModal(ed ? 'Editar cliente' : 'Novo cliente', `
    <form id="fCli" novalidate>
      <label class="campo"><span>Nome / designação *</span><input id="cNome" value="${esc(c?.nome || '')}" required autocomplete="off"></label>
      <label class="campo" id="campoNif"><span>NIF *</span><input id="cNif" value="${esc(c?.nif || '')}" required autocomplete="off" placeholder="9 dígitos, ou ES B12345678">
        <div class="msg-erro" id="nifErro"></div></label>
      <label class="campo"><span>Morada</span><input id="cMorada" value="${esc(c?.morada || '')}" autocomplete="off"></label>
      <div class="linha2">
        <label class="campo"><span>Código postal</span><input id="cCP" value="${esc(c?.codigoPostal || '')}" inputmode="numeric" placeholder="0000-000"></label>
        <label class="campo"><span>Localidade</span><input id="cLoc" value="${esc(c?.localidade || '')}"></label>
      </div>
      <div class="linha2">
        <label class="campo"><span>Telefone</span><input id="cTel" type="tel" value="${esc(c?.telefone || '')}"></label>
        <label class="campo"><span>Contacto (pessoa)</span><input id="cContacto" value="${esc(c?.contacto || '')}"></label>
      </div>
      <label class="campo"><span>Email</span><input id="cEmail" type="email" inputmode="email" value="${esc(c?.email || '')}"></label>
      <label class="campo"><span>Observações</span><textarea id="cObs">${esc(c?.observacoes || '')}</textarea></label>
      <div class="msg-erro" id="cErro"></div>
      <div class="acoes"><button type="button" class="btn" data-fechar>Cancelar</button>
        <button type="submit" class="btn btn-primario" id="cGuardar">${ed ? 'Guardar' : 'Criar cliente'}</button></div>
    </form>`);
  const vNif = () => {
    const r = validarNIF($('#cNif', corpo).value);
    $('#nifErro', corpo).textContent = r.ok ? '' : r.erro;
    $('#campoNif', corpo).classList.toggle('campo-erro', !r.ok);
    return r;
  };
  $('#cNif', corpo).onblur = vNif;
  $('#fCli', corpo).onsubmit = (ev) => {
    ev.preventDefault();
    const erro = (m) => { $('#cErro', corpo).textContent = m; };
    const nome = $('#cNome', corpo).value.trim().replace(/\s+/g, ' ');
    if (nome.length < 2) return erro('Indique o nome do cliente.');
    const n = vNif();
    if (!n.ok) return erro(n.erro);
    const cp = $('#cCP', corpo).value.trim();
    if (cp && n.pais === 'PT' && !/^\d{4}-\d{3}$/.test(cp)) return erro('Código postal no formato 0000-000.');
    const email = $('#cEmail', corpo).value.trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return erro('Email inválido.');
    const loc = $('#cLoc', corpo).value.trim();
    const dados = {
      nome, nomePesquisa: normalizar(nome), pesquisa: tokensPesquisa(nome, loc),
      nif: n.nif, nifPais: n.pais,
      morada: $('#cMorada', corpo).value.trim(), codigoPostal: cp, localidade: loc,
      telefone: $('#cTel', corpo).value.trim(), contacto: $('#cContacto', corpo).value.trim(), email,
      observacoes: $('#cObs', corpo).value.trim(),
      atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid,
    };
    comBotao($('#cGuardar', corpo), async () => {
      try {
        // NIF único: não duplicamos clientes
        const dup = await getDocs(query(collection(db, 'clientes'), where('nif', '==', n.nif), limit(2)));
        const outro = dup.docs.find((d) => !ed || d.id !== c.id);
        if (outro) return erro(`Já existe um cliente com este NIF: ${outro.data().nome}.`);
        if (ed) {
          await updateDoc(doc(db, 'clientes', c.id), dados);
          atual = { ...atual, ...dados };
          const i = lista.findIndex((x) => x.id === c.id);
          if (i >= 0) lista[i] = atual;
          fecharModal();
          toast('Cliente atualizado.', 'ok');
          renderFicha();
        } else {
          const ref = doc(collection(db, 'clientes'));
          await setDoc(ref, { ...dados, origem: 'manual', phcId: null, criadoEm: serverTimestamp(), criadoPor: sessao.uid });
          fecharModal();
          toast('Cliente criado.', 'ok');
          listaCarregada = false;
          history.replaceState({}, '', pagina('clientes'));
          irPara({ id: ref.id });
        }
      } catch (e) { erro(erroFirebase(e)); }
    });
  };
}

// ---------- Importação de clientes (CSV exportado do PHC ou do Excel) ----------
const COLUNAS = {
  nome: ['nome', 'name', 'designacao', 'cliente', 'nomecliente', 'razaosocial'],
  nif: ['nif', 'ncont', 'contribuinte', 'ncontribuinte', 'nocontribuinte', 'numerocontribuinte', 'nipc', 'nifcliente', 'vat'],
  morada: ['morada', 'endereco', 'address', 'morada1'],
  codigoPostal: ['codpost', 'codigopostal', 'codpostal', 'cp'],
  localidade: ['local', 'localidade', 'cidade', 'concelho'],
  telefone: ['telefone', 'tlf', 'telef', 'telemovel', 'tlmvl', 'phone', 'tel'],
  email: ['email', 'emailcliente'],
  contacto: ['contacto', 'contato', 'pessoacontacto'],
  phcId: ['no', 'n', 'numero', 'ncliente', 'numerocliente', 'nocliente', 'codcliente', 'codigo'],
};

function lerCSV(txt) {
  const linha1 = txt.split(/\r?\n/)[0] || '';
  const sep = [';', '\t', ','].map((c) => [c, linha1.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const linhas = [];
  let campo = '', linha = [], aspas = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (aspas) {
      if (ch === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === sep) { linha.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && txt[i + 1] === '\n') i++;
      linha.push(campo); campo = '';
      if (linha.some((c) => c.trim())) linhas.push(linha);
      linha = [];
    } else campo += ch;
  }
  linha.push(campo);
  if (linha.some((c) => c.trim())) linhas.push(linha);
  return linhas;
}

async function lerFicheiroTexto(f) {
  const buf = await f.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8.replace(/^﻿/, '');
}

function abrirImportacao() {
  const corpo = abrirModal('Importar clientes', `
    <p class="muted">Ficheiro <b>CSV</b> exportado do PHC ou do Excel (Ficheiro → Guardar como → CSV).
      A 1.ª linha tem os nomes das colunas: <b>Nome</b> e <b>NIF</b> (ou N.º Contribuinte) obrigatórios;
      Morada, Código Postal, Localidade, Telefone, Email, Contacto e N.º cliente PHC opcionais.
      Clientes com NIF já registado são ignorados.</p>
    <input type="file" id="impFich" accept=".csv,.txt,text/csv">
    <div id="impRes" style="margin-top:12px"></div>`);
  $('#impFich', corpo).onchange = async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const res = $('#impRes', corpo);
    res.innerHTML = '<div class="vazio">A analisar…</div>';
    try { await analisarImportacao(await lerFicheiroTexto(f), res); }
    catch (e) { res.innerHTML = `<p class="msg-erro">${esc(erroFirebase(e))}</p>`; }
  };
}

async function analisarImportacao(txt, res) {
  const linhas = lerCSV(txt);
  if (linhas.length < 2) { res.innerHTML = '<p class="msg-erro">O ficheiro não tem dados.</p>'; return; }
  const cab = linhas[0].map((h) => normalizar(h).replace(/[^a-z0-9]/g, ''));
  const col = {};
  for (const [campo, nomes] of Object.entries(COLUNAS)) {
    const i = cab.findIndex((h) => nomes.includes(h));
    if (i >= 0) col[campo] = i;
  }
  if (col.nome === undefined || col.nif === undefined) {
    res.innerHTML = `<p class="msg-erro">Não encontrei as colunas ${col.nome === undefined ? '«Nome»' : ''} ${col.nif === undefined ? '«NIF»' : ''}.
      Colunas do ficheiro: ${esc(linhas[0].join(', '))}</p>`;
    return;
  }
  const val = (l, c) => (col[c] === undefined ? '' : String(l[col[c]] || '').trim());
  const novos = [], erros = [], vistos = new Set();
  let repetidosFicheiro = 0;
  linhas.slice(1).forEach((l, k) => {
    const n = k + 2;
    const nome = val(l, 'nome').replace(/\s+/g, ' ');
    if (!nome && !val(l, 'nif')) return;
    if (nome.length < 2) { erros.push(`Linha ${n}: sem nome`); return; }
    const r = validarNIF(val(l, 'nif'));
    if (!r.ok) { erros.push(`Linha ${n} (${nome}): ${r.erro}`); return; }
    if (r.nif === '999999990') { erros.push(`Linha ${n} (${nome}): consumidor final — ignorado`); return; }
    if (vistos.has(r.nif)) { repetidosFicheiro++; return; }
    vistos.add(r.nif);
    const loc = val(l, 'localidade');
    novos.push({
      nome, nomePesquisa: normalizar(nome), pesquisa: tokensPesquisa(nome, loc), nif: r.nif, nifPais: r.pais,
      morada: val(l, 'morada'), codigoPostal: val(l, 'codigoPostal'), localidade: loc,
      telefone: val(l, 'telefone'), email: val(l, 'email'), contacto: val(l, 'contacto'), observacoes: '',
      origem: 'importacao', phcId: val(l, 'phcId') || null,
    });
  });
  // NIF já existentes (consultas de 30 em 30)
  const existentes = new Set();
  const nifs = novos.map((c) => c.nif);
  for (let i = 0; i < nifs.length; i += 30) {
    res.innerHTML = `<div class="vazio">A verificar duplicados… ${Math.min(i + 30, nifs.length)}/${nifs.length}</div>`;
    const snap = await getDocs(query(collection(db, 'clientes'), where('nif', 'in', nifs.slice(i, i + 30))));
    snap.docs.forEach((d) => existentes.add(d.data().nif));
  }
  const aImportar = novos.filter((c) => !existentes.has(c.nif));
  res.innerHTML = `
    <div class="cartao" style="box-shadow:none;border:1px solid var(--linha)">
      <div><b id="impNovos">${aImportar.length}</b> clientes novos para importar</div>
      <div class="muted">${existentes.size} já existem · ${repetidosFicheiro} NIF repetidos no ficheiro · ${erros.length} linhas com problemas</div>
    </div>
    ${erros.length ? `<details><summary class="muted">Ver linhas com problemas</summary><ul class="muted" id="impErros">${erros.slice(0, 200).map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button>
      ${aImportar.length ? `<button class="btn btn-primario" id="impOk">Importar ${aImportar.length} clientes</button>` : ''}</div>`;
  if (!aImportar.length) return;
  $('#impOk').onclick = () => comBotao($('#impOk'), async () => {
    let feitos = 0;
    for (let i = 0; i < aImportar.length; i += 400) {
      const lote = writeBatch(db);
      for (const c of aImportar.slice(i, i + 400)) {
        lote.set(doc(collection(db, 'clientes')), { ...c, criadoEm: serverTimestamp(), criadoPor: sessao.uid, atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
      }
      await lote.commit();
      feitos += Math.min(400, aImportar.length - i);
      $('#impNovos').textContent = `${feitos}/${aImportar.length}`;
    }
    fecharModal();
    toast(`${feitos} clientes importados.`, 'ok', 5000);
    listaCarregada = false;
    carregarLista();
  });
}

rota();
