$('#versao').textContent = (ENV === 'dev' ? 'DESENVOLVIMENTO · ' : '') + 'build ' + BUILD;

function formLogin(msg = '') {
  $('#caixa').innerHTML = `
    <form id="fLogin" novalidate>
      <label class="campo"><span>Email</span><input type="email" id="email" autocomplete="username" inputmode="email" required></label>
      <label class="campo"><span>Palavra-passe</span><input type="password" id="pass" autocomplete="current-password" required></label>
      <div class="msg-erro" id="erro">${esc(msg)}</div>
      <button class="btn btn-primario btn-bloco" id="btnEntrar" type="submit">Entrar</button>
      <p style="text-align:center;margin:14px 0 0"><a href="#" id="esqueci">Esqueci-me da palavra-passe</a></p>
    </form>`;
  $('#fLogin').onsubmit = (ev) => {
    ev.preventDefault();
    const email = $('#email').value.trim();
    const pass = $('#pass').value;
    if (!email || !pass) { $('#erro').textContent = 'Indique o email e a palavra-passe.'; return; }
    comBotao($('#btnEntrar'), async () => {
      try { await signInWithEmailAndPassword(auth, email, pass); }
      catch (e) { $('#erro').textContent = erroFirebase(e); }
    });
  };
  $('#esqueci').onclick = async (ev) => {
    ev.preventDefault();
    const email = $('#email').value.trim();
    if (!email) { $('#erro').textContent = 'Escreva primeiro o seu email.'; return; }
    try { await sendPasswordResetEmail(auth, email); toast('Se o email existir, recebe uma mensagem para definir a palavra-passe.', 'ok', 6000); }
    catch (e) { $('#erro').textContent = erroFirebase(e); }
  };
}

function semPerfil(user, inativo) {
  $('#caixa').innerHTML = `
    <h2>${inativo ? 'Conta desativada' : 'Sem perfil atribuído'}</h2>
    <p class="muted">Sessão iniciada como <b>${esc(user.email)}</b>, mas ${inativo ? 'esta conta está desativada' : 'ainda não tem perfil na plataforma'}.
    Envie ao administrador este identificador (UID):</p>
    <code class="uid" id="uid">${esc(user.uid)}</code>
    <button class="btn btn-bloco" id="btnSairSP">Terminar sessão</button>`;
  $('#btnSairSP').onclick = () => signOut(auth);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { formLogin(); return; }
  $('#caixa').innerHTML = '<div class="vazio">A verificar perfil…</div>';
  try {
    const snap = await getDoc(doc(db, 'utilizadores', user.uid));
    if (!snap.exists()) { semPerfil(user, false); return; }
    if (snap.data().ativo !== true) { semPerfil(user, true); return; }
    location.replace(pagina('agenda'));
  } catch (e) {
    console.error(e);
    $('#caixa').innerHTML = `<div class="msg-erro">${esc(erroFirebase(e))}</div><button class="btn btn-bloco" id="btnSairSP">Terminar sessão</button>`;
    $('#btnSairSP').onclick = () => signOut(auth);
  }
});
