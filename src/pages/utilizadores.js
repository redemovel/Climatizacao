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
      <div class="li-topo"><span class="li-titulo">${esc(u.nome)}</span><span class="badge">${esc(PERFIS[u.perfil] || u.perfil)}</span></div>
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
      ${ed ? `<label class="campo" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="uAtivo" style="width:auto;min-height:0" ${u.ativo ? 'checked' : ''} ${proprio ? 'disabled' : ''}><span style="margin:0">Ativo (pode entrar na plataforma)</span></label>`
        : `<details style="margin-bottom:12px"><summary class="muted">Já existe no Firebase Authentication?</summary>
            <label class="campo" style="margin-top:8px"><span>UID existente</span><input id="uUid" placeholder="Deixe vazio para criar a conta" autocomplete="off"></label></details>`}
      ${proprio ? '<p class="muted">Não pode alterar o seu próprio perfil nem desativar-se.</p>' : ''}
      <div class="msg-erro" id="uErro"></div>
      <div class="acoes"><button type="button" class="btn" data-fechar>Cancelar</button>
        <button type="submit" class="btn btn-primario" id="uGuardar">${ed ? 'Guardar' : 'Criar e enviar convite'}</button></div>
    </form>`);
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
          const alt = { nome, telefone: $('#uTel', corpo).value.trim(), atualizadoEm: serverTimestamp() };
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
          const novo = { nome, email, telefone: $('#uTel', corpo).value.trim(), perfil, ativo: true, criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp() };
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

carregar();
