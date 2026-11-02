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
    if (p.length < 3 || !(preco > 0) || !tecnicos || tecnicos + ajudantes !== partes.length) { ignoradas.push(l); continue; }
    const tipo = /manuten/i.test(p[0]) ? 'Manutenção' : 'AT/Instalação';
    const i = linhas.findIndex((x) => x.tipo === tipo && x.tecnicos === tecnicos && x.ajudantes === ajudantes);
    const nova = { tipo, composicao: p[1], tecnicos, ajudantes, preco: Math.round(preco * 100) / 100 };
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
      Ex.: <code>Manutenção;Técnico-Técnico-Ajudante;51,00</code> · <code>AT/Instalação;Técnico;22,80</code></p>
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

carregar();
