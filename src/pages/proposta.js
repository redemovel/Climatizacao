// Página pública da proposta: o cliente abre o link do email (sem conta), vê, imprime/guarda em PDF e aceita ou rejeita.
// Só lê propostas/{código de 32 caracteres}; as regras só deixam marcar «visto» e responder enquanto estiver «Enviado» e válida.
const codigo = new URLSearchParams(location.search).get('c') || '';
let prop = null;

async function carregarProposta() {
  const box = $('#prop');
  if (!/^[A-Za-z0-9]{32}$/.test(codigo)) { box.innerHTML = '<div class="vazio">Link inválido. Confirme o endereço recebido por email.</div>'; return; }
  try {
    const s = await getDoc(doc(db, 'propostas', codigo));
    if (!s.exists()) { box.innerHTML = '<div class="vazio">Esta proposta não existe ou foi retirada.</div>'; return; }
    prop = s.data();
    render();
    if (!prop.vistoEm) updateDoc(doc(db, 'propostas', codigo), { vistoEm: serverTimestamp() }).catch(() => {});
  } catch (e) { box.innerHTML = `<div class="vazio">Não foi possível abrir a proposta (${esc(erroFirebase(e))}).</div>`; }
}

function expirada() { return prop.validade && paraData(prop.validade) < new Date(); }

function render() {
  const p = prop;
  let estado = '';
  if (p.estado === 'Aceite') estado = `<div class="prop-estado ok">Proposta aceite por <b>${esc(p.respostaNome)}</b>${p.respondidoEm ? ' em ' + esc(fmtDataHora(p.respondidoEm)) : ''}. Obrigado! Vamos entrar em contacto para agendar.</div>`;
  else if (p.estado === 'Rejeitado') estado = `<div class="prop-estado">Proposta não aceite (${esc(p.respostaNome)}). Obrigado pela resposta.</div>`;
  else if (p.estado === 'Retirada') estado = '<div class="prop-estado">Esta proposta foi retirada. Contacte-nos para uma nova versão.</div>';
  else if (expirada()) estado = '<div class="prop-estado">O prazo de validade desta proposta terminou. Contacte-nos para a renovar.</div>';
  const pode = p.estado === 'Enviado' && !expirada();
  $('#prop').innerHTML = `${estado}
    <div class="prop-acoes nao-imprimir">
      ${pode ? '<button class="btn btn-primario" id="btnAceitar">Aceitar proposta</button><button class="btn" id="btnRejeitar">Não aceitar</button>' : ''}
      <button class="btn" id="btnImprimir">Imprimir / PDF</button></div>
    <div class="prop-folha">${htmlProposta(p)}</div>
    <p class="muted nao-imprimir" style="text-align:center;font-size:.85rem">Dúvidas? Responda ao email que recebeu ou contacte a Arpuro.</p>`;
  $('#btnImprimir').onclick = () => window.print();
  if (pode) { $('#btnAceitar').onclick = () => responder(true); $('#btnRejeitar').onclick = () => responder(false); }
}

function responder(aceitar) {
  const c = abrirModal(aceitar ? 'Aceitar a proposta ' + prop.numero : 'Não aceitar a proposta', `
    ${aceitar ? `<p style="margin-top:0">Total: <b>${esc(eurP(totaisProposta(prop.linhas, prop.ivaTaxa).total))}</b> (IVA incluído)</p>` : ''}
    <label class="campo"><span>O seu nome *</span><input id="rNome" autocomplete="name" maxlength="120"></label>
    ${aceitar ? '<label class="campo"><span>N.º da nota de encomenda (se a vossa empresa usar)</span><input id="rNE" maxlength="60" autocomplete="off"></label>' : ''}
    <label class="campo"><span>${aceitar ? 'Observações (ex.: melhor altura para a intervenção)' : 'Motivo (opcional)'}</span><textarea id="rNota" maxlength="1000"></textarea></label>
    ${aceitar ? '<label class="campo" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="rOk" style="width:auto;min-height:0"><span style="margin:0">Li e aceito a proposta e as condições indicadas.</span></label>' : ''}
    <div class="msg-erro" id="rErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="rEnviar">${aceitar ? 'Confirmar aceitação' : 'Enviar resposta'}</button></div>`);
  $('#rEnviar', c).onclick = () => {
    const nome = $('#rNome', c).value.trim();
    if (nome.length < 2) { $('#rErro', c).textContent = 'Indique o seu nome.'; return; }
    if (aceitar && !$('#rOk', c).checked) { $('#rErro', c).textContent = 'Confirme que aceita a proposta e as condições.'; return; }
    const alt = { estado: aceitar ? 'Aceite' : 'Rejeitado', respostaNome: nome, respostaNota: $('#rNota', c).value.trim().slice(0, 1000),
      respostaNE: aceitar ? $('#rNE', c).value.trim().slice(0, 60) : '', respondidoEm: serverTimestamp(), notificar: 'sim' };
    comBotao($('#rEnviar', c), async () => {
      try {
        await updateDoc(doc(db, 'propostas', codigo), alt);
        fecharModal();
        prop = { ...prop, ...alt, respondidoEm: Timestamp.now() };
        render();
        toast(aceitar ? 'Proposta aceite. Obrigado!' : 'Resposta enviada. Obrigado!', 'ok', 6000);
      } catch (e) { $('#rErro', c).textContent = 'Não foi possível registar a resposta (' + erroFirebase(e) + '). Tente de novo ou responda ao email.'; }
    });
  };
}

carregarProposta();
