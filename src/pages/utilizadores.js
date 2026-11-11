const sessao = await iniciarPagina({ perfis: ['master'] });
const U_LIMITE = 50;
let lista = [];
let cursor = null;

async function carregar(mais = false) {
  if (!mais) { lista = []; cursor = null; }
  const c = [orderBy('nome')];
  if (cursor) c.push(startAfter(cursor));
  c.push(limit(U_LIMITE));
  try {
    const snap = await getDocs(query(collection(db, 'utilizadores'), ...c));
    lista = lista.concat(snap.docs.map((d) => ({ uid: d.id, ...d.data() })));
    cursor = snap.docs[snap.docs.length - 1] || cursor;
    $('#maisWrap').classList.toggle('oculto', snap.docs.length < U_LIMITE);
    render();
  } catch (e) { $('#lista').innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
}

function render() {
  $('#lista').innerHTML = lista.map((u, i) => `
    <div class="lista-item" data-i="${i}" style="${u.ativo ? '' : 'opacity:.55'}">
      <div class="li-topo"><span class="li-titulo">${esc(u.nome)}</span><span class="badge">${esc(PERFIS[u.perfil] || u.perfil)}${u.tecnico && u.perfil !== 'tecnico' ? ' + Técnico' : ''}</span></div>
      <div class="li-sub">${esc(u.email)}${u.telefone ? ' · ' + esc(u.telefone) : ''}</div>
      ${u.ativo ? '' : '<div class="li-meta"><span class="badge">Inativo</span></div>'}
    </div>`).join('') || '<div class="vazio">Sem utilizadores.</div>';
}

$('#lista').addEventListener('click', (ev) => {
  const it = ev.target.closest('[data-i]');
  if (it) abrirForm(lista[+it.dataset.i]);
});
$('#btnNovo').onclick = () => abrirForm(null);
$('#btnMais').onclick = () => comBotao($('#btnMais'), () => carregar(true));

function senhaAleatoria() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('') + 'A!9';
}

function abrirForm(u) {
  const ed = !!u;
  const proprio = ed && u.uid === sessao.uid;
  const opcoes = ['tecnico', 'backoffice', 'master'].map((p) => `<option value="${p}" ${u?.perfil === p ? 'selected' : ''}>${PERFIS[p]}</option>`).join('')
    + '<option value="comercial" disabled>Comercial (futuro)</option>';
  const corpo = abrirModal(ed ? 'Editar utilizador' : 'Novo utilizador', `
    <form id="fU" novalidate>
      <label class="campo"><span>Nome *</span><input id="uNome" value="${esc(u?.nome || '')}" autocomplete="off"></label>
      <label class="campo"><span>Email *</span><input id="uEmail" type="email" inputmode="email" value="${esc(u?.email || '')}" ${ed ? 'disabled' : ''} autocomplete="off"></label>
      <label class="campo"><span>Telefone</span><input id="uTel" type="tel" value="${esc(u?.telefone || '')}"></label>
      <label class="campo"><span>Perfil *</span><select id="uPerfil" ${proprio ? 'disabled' : ''}>${opcoes}</select></label>
      <label class="campo" id="campoTec" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="uTecnico" style="width:auto;min-height:0" ${u?.tecnico ? 'checked' : ''}><span style="margin:0">Também é técnico (pode ter folhas atribuídas)</span></label>
      ${ed ? `<label class="campo" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="uAtivo" style="width:auto;min-height:0" ${u.ativo ? 'checked' : ''} ${proprio ? 'disabled' : ''}><span style="margin:0">Ativo (pode entrar na plataforma)</span></label>`
        : `<details style="margin-bottom:12px"><summary class="muted">Já existe no Firebase Authentication?</summary>
            <label class="campo" style="margin-top:8px"><span>UID existente</span><input id="uUid" placeholder="Deixe vazio para criar a conta" autocomplete="off"></label></details>`}
      ${proprio ? '<p class="muted">Não pode alterar o seu próprio perfil nem desativar-se.</p>' : ''}
      <div class="msg-erro" id="uErro"></div>
      <div class="acoes"><button type="button" class="btn" data-fechar>Cancelar</button>
        <button type="submit" class="btn btn-primario" id="uGuardar">${ed ? 'Guardar' : 'Criar e enviar convite'}</button></div>
    </form>`);
  const verTec = () => { $('#campoTec', corpo).style.display = $('#uPerfil', corpo).value === 'tecnico' ? 'none' : 'flex'; };
  $('#uPerfil', corpo).onchange = verTec;
  verTec();
  $('#fU', corpo).onsubmit = (ev) => {
    ev.preventDefault();
    const erro = (m) => { $('#uErro', corpo).textContent = m; };
    const nome = $('#uNome', corpo).value.trim();
    const email = (ed ? u.email : $('#uEmail', corpo).value.trim()).toLowerCase();
    const perfil = $('#uPerfil', corpo).value;
    if (nome.length < 2) return erro('Indique o nome.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return erro('Email inválido.');
    if (!PERFIS[perfil] || perfil === 'comercial') return erro('Escolha o perfil.');
    comBotao($('#uGuardar', corpo), async () => {
      try {
        if (ed) {
          const alt = { nome, telefone: $('#uTel', corpo).value.trim(), tecnico: perfil === 'tecnico' || $('#uTecnico', corpo).checked, atualizadoEm: serverTimestamp() };
          if (!proprio) { alt.perfil = perfil; alt.ativo = $('#uAtivo', corpo).checked; }
          await updateDoc(doc(db, 'utilizadores', u.uid), alt);
          Object.assign(u, alt);
          toast('Utilizador atualizado.', 'ok');
        } else {
          let uid = $('#uUid', corpo).value.trim();
          let convite = false;
          if (!uid) {
            // App secundária: cria a conta sem terminar a sessão do Master.
            const app2 = initializeApp(FIREBASE_CONFIG, 'criar-' + Date.now());
            try {
              const auth2 = getAuth(app2);
              const cred = await createUserWithEmailAndPassword(auth2, email, senhaAleatoria());
              uid = cred.user.uid;
              await signOut(auth2);
            } finally { await deleteApp(app2); }
            convite = true;
          }
          const existe = await getDoc(doc(db, 'utilizadores', uid));
          if (existe.exists()) return erro('Este UID já tem perfil atribuído.');
          const novo = { nome, email, telefone: $('#uTel', corpo).value.trim(), perfil, tecnico: perfil === 'tecnico' || $('#uTecnico', corpo).checked, ativo: true, criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp() };
          await setDoc(doc(db, 'utilizadores', uid), novo);
          if (convite) await sendPasswordResetEmail(auth, email);
          lista.push({ uid, ...novo });
          lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt'));
          toast(convite ? `Utilizador criado. Enviado email para ${email} definir a palavra-passe.` : 'Perfil associado.', 'ok', 6000);
        }
        fecharModal();
        render();
      } catch (e) { erro(erroFirebase(e)); }
    });
  };
}

// ---------- Tabela de preço/hora da mão de obra (só Master; config/precosHora) ----------
// Uma linha por equipa: «Tipo;Composição;Preço», p. ex. «Manutenção;Técnico-Técnico-Ajudante;51,00».
function lerTabelaPrecos(txt) {
  const linhas = [], ignoradas = [];
  for (const bruta of txt.split(/\r?\n/)) {
    const l = bruta.trim();
    if (!l) continue;
    const p = l.split(/[;\t]/).map((x) => x.trim());
    const preco = Number((p[2] || '').replace(/[€\s]/g, '').replace(',', '.'));
    const partes = (p[1] || '').split('-').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const tecnicos = partes.filter((x) => x.startsWith('técnico') || x.startsWith('tecnico')).length;
    const ajudantes = partes.filter((x) => x.startsWith('ajudante')).length;
    const aprendizes = partes.filter((x) => x.startsWith('aprendiz')).length;
    if (p.length < 3 || !(preco > 0) || !tecnicos || tecnicos + ajudantes + aprendizes !== partes.length) { ignoradas.push(l); continue; }
    const t0 = p[0].toLowerCase();
    const tipo = /manuten/.test(t0) ? 'Manutenção'
      : /at\s*\/\s*instal/.test(t0) ? 'AT/Instalação'
      : /instal/.test(t0) ? 'Instalação' : 'Assistência Técnica';
    const i = linhas.findIndex((x) => x.tipo === tipo && x.tecnicos === tecnicos && x.ajudantes === ajudantes && x.aprendizes === aprendizes);
    const nova = { tipo, composicao: p[1], tecnicos, ajudantes, aprendizes, preco: Math.round(preco * 100) / 100 };
    if (i >= 0) linhas[i] = nova; else linhas.push(nova);
  }
  return { linhas, ignoradas };
}

async function abrirPrecos() {
  let atualP = {};
  try { const s = await getDoc(doc(db, 'config', 'precosHora')); if (s.exists()) atualP = s.data(); } catch (e) { toast(erroFirebase(e), 'erro'); return; }
  const txt = (atualP.linhas || []).map((l) => `${l.tipo};${l.composicao};${String(l.preco).replace('.', ',')}`).join('\n');
  const c = abrirModal('Preço/hora da mão de obra', `
    <p class="muted" style="margin-top:0">Só o Master vê esta tabela. Uma linha por equipa: <b>Tipo;Composição;Preço</b><br>
      Tipos: Manutenção, Assistência Técnica, Instalação (ou AT/Instalação para as duas).<br>Ex.: <code>Manutenção;Técnico-Técnico-Ajudante;55,20</code> · <code>Assistência Técnica;Técnico;22,80</code></p>
    <label class="campo"><span>Tabela</span><textarea id="pTab" rows="10" style="font-family:monospace">${esc(txt)}</textarea></label>
    <div class="grelha-2">
      <label class="campo"><span>1.ª hora (+%)</span><input id="p1" type="number" min="0" value="${esc(String(atualP.primeiraHora ?? 20))}"></label>
      <label class="campo"><span>2.ª hora (+%)</span><input id="p2" type="number" min="0" value="${esc(String(atualP.segundaHora ?? 10))}"></label>
    </div>
    <label class="campo"><span>Sábado, domingo (+%)</span><input id="pFds" type="number" min="0" value="${esc(String(atualP.fimDeSemana ?? 100))}"></label>
    <div class="msg-erro" id="pErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="pGuardar">Guardar</button></div>`);
  $('#pGuardar', c).onclick = () => {
    const { linhas, ignoradas } = lerTabelaPrecos($('#pTab', c).value);
    if (!linhas.length) { $('#pErro', c).textContent = 'Nenhuma linha válida.'; return; }
    const n = (id) => Math.max(0, Number($(id, c).value) || 0);
    comBotao($('#pGuardar', c), async () => {
      try {
        await setDoc(doc(db, 'config', 'precosHora'), { linhas, primeiraHora: n('#p1'), segundaHora: n('#p2'), fimDeSemana: n('#pFds'), atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
        fecharModal();
        toast(`Tabela guardada (${linhas.length} linhas${ignoradas.length ? `, ${ignoradas.length} ignoradas: ${ignoradas.slice(0, 3).join(' | ')}` : ''}).`, ignoradas.length ? 'erro' : 'ok', 8000);
      } catch (e) { $('#pErro', c).textContent = erroFirebase(e); }
    });
  };
}
$('#btnPrecos').onclick = () => comBotao($('#btnPrecos'), abrirPrecos);

// ---------- Viaturas (matrículas usadas nas guias de transporte) ----------
async function abrirViaturas() {
  let itens = [];
  try { const s = await getDoc(doc(db, 'listas', 'viaturas')); if (s.exists()) itens = s.data().itens || []; } catch (e) { toast(erroFirebase(e), 'erro'); return; }
  const c = abrirModal('Viaturas', `
    <label class="campo"><span>Matrículas (uma por linha)</span><textarea id="vLista" rows="5" style="font-family:monospace">${esc(itens.join('\n'))}</textarea></label>
    <div class="msg-erro" id="vErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="vGuardar">Guardar</button></div>`);
  $('#vGuardar', c).onclick = () => {
    const l = [...new Set($('#vLista', c).value.split(/\r?\n/).map((x) => x.trim().toUpperCase().replace(/\s+/g, '')).filter(Boolean))];
    if (l.some((x) => !/^[A-Z0-9]{2}-?[A-Z0-9]{2}-?[A-Z0-9]{2}$/.test(x))) { $('#vErro', c).textContent = 'Matrícula inválida (ex.: AV-78-ER).'; return; }
    const norm = l.map((x) => x.includes('-') ? x : x.slice(0, 2) + '-' + x.slice(2, 4) + '-' + x.slice(4));
    comBotao($('#vGuardar', c), async () => {
      try { await setDoc(doc(db, 'listas', 'viaturas'), { itens: norm, atualizadoEm: serverTimestamp() }); fecharModal(); toast('Viaturas guardadas.', 'ok'); }
      catch (e) { $('#vErro', c).textContent = erroFirebase(e); }
    });
  };
}
$('#btnViaturas').onclick = () => comBotao($('#btnViaturas'), abrirViaturas);

// ---------- Colaboradores (quem aparece nos registos de tempo) ----------
const FUNCOES = ['Técnico', 'Ajudante', 'Aprendiz'];
let colaboradores = [];
let custos = { hora: {} };   // config/custos (só o Master): custo/hora de cada colaborador, para a rentabilidade das obras
async function carregarCol() {
  try {
    try { const sc = await getDoc(doc(db, 'config', 'custos')); custos = sc.exists() ? { hora: {}, ...sc.data() } : { hora: {} }; } catch (e) { /* sem custos */ }
    const snap = await getDocs(query(collection(db, 'colaboradores'), limit(100)));
    colaboradores = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.ativo ? 1 : 0) - (a.ativo ? 1 : 0) || a.nome.localeCompare(b.nome, 'pt'));
    renderCol();
  } catch (e) { $('#listaCol').innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`; }
}
function renderCol() {
  $('#listaCol').innerHTML = colaboradores.map((p, i) => `
    <div class="lista-item" data-col="${i}" style="${p.ativo ? '' : 'opacity:.55'}">
      <div class="li-topo"><span class="li-titulo">${esc(p.nome)}</span><span class="badge">${esc(p.funcao)}${p.externo ? ' · externo' : ''}</span></div>
      <div class="li-sub">${p.uid ? 'Utilizador: ' + esc((lista.find((u) => u.uid === p.uid) || {}).nome || p.uid) : '<span class="muted">Sem utilizador associado</span>'}${p.ativo ? '' : ' · Inativo'}
        · ${custos.hora[p.id] ? 'custo ' + esc(Number(custos.hora[p.id]).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' })) + '/h' : '<span class="txt-erro">sem custo/hora</span>'}</div>
    </div>`).join('') || `<div class="vazio">Sem colaboradores.<br><button class="btn" id="btnColIniciais" style="margin-top:10px">Criar lista inicial</button></div>`;
  if ($('#btnColIniciais')) $('#btnColIniciais').onclick = () => comBotao($('#btnColIniciais'), criarColIniciais);
}
// Equipa atual (2026-11): os três técnicos + equipas externas + aprendiz. Associa ao utilizador pelo nome, se existir.
async function criarColIniciais() {
  const base = [['Paulo Duarte', 'Técnico', false], ['Ricardo Pereira', 'Técnico', false], ['Pascoal Rodrigues', 'Técnico', false],
    ['Equipa externa — técnico', 'Técnico', true], ['Equipa externa — ajudante', 'Ajudante', true], ['Aprendiz', 'Aprendiz', false]];
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  try {
    const b = writeBatch(db);
    for (const [nome, funcao, externo] of base) {
      const u = lista.find((x) => norm(x.nome) === norm(nome));
      b.set(doc(collection(db, 'colaboradores')), { nome, funcao, externo, uid: u ? u.uid : '', ativo: true, criadoEm: serverTimestamp() });
    }
    await b.commit();
    toast('Lista criada. Verifique as funções e as associações.', 'ok');
    carregarCol();
  } catch (e) { toast(erroFirebase(e), 'erro'); }
}
function formCol(p) {
  const ed = !!p;
  const c = abrirModal(ed ? 'Editar colaborador' : 'Novo colaborador', `
    <label class="campo"><span>Nome *</span><input id="cNome" maxlength="120" value="${esc(p?.nome || '')}" autocomplete="off"></label>
    <label class="campo"><span>Função *</span><select id="cFuncao">${FUNCOES.map((f) => `<option ${p?.funcao === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
    <label class="campo"><span>Utilizador da plataforma</span><select id="cUid"><option value="">— nenhum —</option>${lista.filter((u) => u.ativo).map((u) => `<option value="${esc(u.uid)}" ${p?.uid === u.uid ? 'selected' : ''}>${esc(u.nome)}</option>`).join('')}</select></label>
 <label class="campo"><span>Custo/hora (€, salário com encargos) — só o Master vê</span><input type="number" id="cCusto" min="0" step="0.01" inputmode="decimal" value="${esc(String(p && custos.hora[p.id] != null ? custos.hora[p.id] : ''))}" placeholder="Ex.: 14,50"></label>
    <label class="campo" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="cExt" style="width:auto;min-height:0" ${p?.externo ? 'checked' : ''}><span style="margin:0">Equipa externa</span></label>
    <label class="campo" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="cAtivo" style="width:auto;min-height:0" ${!ed || p.ativo ? 'checked' : ''}><span style="margin:0">Ativo</span></label>
    <div class="msg-erro" id="cErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="cGuardar">Guardar</button></div>`);
  $('#cGuardar', c).onclick = () => {
    const nome = $('#cNome', c).value.trim();
    if (nome.length < 2) { $('#cErro', c).textContent = 'Indique o nome.'; return; }
    const dados = { nome, funcao: $('#cFuncao', c).value, uid: $('#cUid', c).value, externo: $('#cExt', c).checked, ativo: $('#cAtivo', c).checked, atualizadoEm: serverTimestamp() };
    comBotao($('#cGuardar', c), async () => {
      try {
        const ref = ed ? doc(db, 'colaboradores', p.id) : doc(collection(db, 'colaboradores'));
        if (ed) await updateDoc(ref, dados);
        else await setDoc(ref, { ...dados, criadoEm: serverTimestamp() });
        const ch = String($('#cCusto', c).value).replace(',', '.');
        const novo = ch === '' ? null : Math.max(0, Number(ch) || 0);
        if (novo !== (custos.hora[ref.id] ?? null)) {
          custos.hora[ref.id] = novo;
          await setDoc(doc(db, 'config', 'custos'), { hora: { ...custos.hora }, atualizadoEm: serverTimestamp() }, { merge: true });
        }
        fecharModal();
        toast('Colaborador guardado.', 'ok');
        carregarCol();
      } catch (e) { $('#cErro', c).textContent = erroFirebase(e); }
    });
  };
}
$('#listaCol').addEventListener('click', (ev) => { const it = ev.target.closest('[data-col]'); if (it) formCol(colaboradores[+it.dataset.col]); });
$('#btnNovoCol').onclick = () => formCol(null);

carregar().then(carregarCol);
