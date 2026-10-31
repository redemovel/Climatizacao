const AG_LIMITE = 50;
let vista = 'dia';
try { vista = localStorage.getItem('agenda.vista') || 'dia'; } catch (e) { /* sem storage */ }
let base = inicioDia(new Date());
let filtroTec = '';
let itens = [];
let cursor = null;

const sessao = await iniciarPagina({ perfis: ['master', 'backoffice', 'tecnico'] });
const staff = ehStaff(sessao.perfil);

if (staff) {
  $('#barraTec').classList.remove('oculto');
  try {
    const tecs = await carregarTecnicos();
    $('#selTec').insertAdjacentHTML('beforeend', tecs.map((t) => `<option value="${esc(t.uid)}">${esc(t.nome)}</option>`).join(''));
  } catch (e) { toast(erroFirebase(e), 'erro'); }
  $('#selTec').onchange = () => { filtroTec = $('#selTec').value; carregar(); };
}

function intervalo() {
  const ini = vista === 'dia' ? inicioDia(base) : inicioSemana(base);
  return { ini, fim: addDias(ini, vista === 'dia' ? 1 : 7) };
}

function marcarVista() {
  $$('#segVista button').forEach((b) => b.classList.toggle('ativo', b.dataset.v === vista));
  const { ini, fim } = intervalo();
  $('#periodo').textContent = vista === 'dia'
    ? fmtDiaSemana(ini)
    : `${fmtData(ini, { day: 'numeric', month: 'short' })} – ${fmtData(addDias(fim, -1), { day: 'numeric', month: 'short' })}`;
}

async function carregar(mais = false) {
  marcarVista();
  if (!mais) { itens = []; cursor = null; $('#lista').innerHTML = '<div class="vazio">A carregar…</div>'; }
  const { ini, fim } = intervalo();
  const tec = staff ? filtroTec : sessao.uid;
  const c = [];
  if (tec) c.push(where('tecnicoUid', '==', tec));
  c.push(where('dataPrevista', '>=', Timestamp.fromDate(ini)), where('dataPrevista', '<', Timestamp.fromDate(fim)), orderBy('dataPrevista'));
  if (cursor) c.push(startAfter(cursor));
  c.push(limit(AG_LIMITE));
  try {
    const snap = await getDocs(query(collection(db, 'folhas'), ...c));
    itens = itens.concat(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    cursor = snap.docs[snap.docs.length - 1] || cursor;
    $('#maisWrap').classList.toggle('oculto', snap.docs.length < AG_LIMITE);
    render();
  } catch (e) {
    $('#lista').innerHTML = `<div class="vazio">${esc(erroFirebase(e))}</div>`;
  }
}

function cartao(f) {
  const est = classeEstado(f.estado).replace('estado-', 'b-');
  const tel = linkTel(f.telefone);
  const mapa = linkMapa(f);
  return `<div class="lista-item ${est}" data-id="${esc(f.id)}">
    <div class="ag-item">
      <div class="hora">${esc(fmtHora(f.dataPrevista))}</div>
      <div class="ag-corpo">
        <div class="li-topo"><span class="li-titulo">${esc(f.clienteNome)}</span>${badgeEstado(f.estado)}</div>
        <div class="li-sub">${esc([f.morada, f.localidade].filter(Boolean).join(', ') || 'Sem morada')}</div>
        <div class="li-meta"><span class="tipo">${esc(TIPO_NOME[f.tipo] || f.tipo)}</span><span>${esc(f.numero || '')}</span>
          ${staff ? `<span>· ${esc(f.tecnicoNome || '')}</span>` : ''}</div>
        ${f.descricao ? `<div class="li-sub">${esc(f.descricao.length > 120 ? f.descricao.slice(0, 120) + '…' : f.descricao)}</div>` : ''}
        ${(tel || mapa) ? `<div class="ag-acoes">
          ${tel ? `<a class="btn btn-peq btn-sec" href="${esc(tel)}" data-ext>Ligar</a>` : ''}
          ${mapa ? `<a class="btn btn-peq btn-sec" href="${esc(mapa)}" target="_blank" rel="noopener" data-ext>Navegar</a>` : ''}</div>` : ''}
      </div>
    </div></div>`;
}

function render() {
  const { ini } = intervalo();
  const dias = vista === 'dia' ? 1 : 7;
  const hoje = isoLocal(new Date());
  const porDia = {};
  for (const f of itens) { const k = isoLocal(paraData(f.dataPrevista)); (porDia[k] = porDia[k] || []).push(f); }
  let html = '';
  for (let i = 0; i < dias; i++) {
    const d = addDias(ini, i);
    const k = isoLocal(d);
    const lista = porDia[k] || [];
    const fimDeSemana = d.getDay() === 0 || d.getDay() === 6;
    if (vista === 'semana' && fimDeSemana && !lista.length) continue;
    if (vista === 'semana') html += `<div class="dia-cab ${k === hoje ? 'hoje' : ''}"><span>${esc(fmtDiaSemana(d))}</span><span class="muted">${lista.length || ''}</span></div>`;
    html += lista.length ? lista.map(cartao).join('') : `<div class="vazio" style="padding:${vista === 'dia' ? 28 : 8}px">Sem trabalhos agendados.</div>`;
  }
  $('#lista').innerHTML = html;
}

$('#lista').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-ext]')) return;
  const it = ev.target.closest('[data-id]');
  if (it) location.href = pagina('folhas', { id: it.dataset.id });
});
$$('#segVista button').forEach((b) => b.onclick = () => {
  vista = b.dataset.v;
  try { localStorage.setItem('agenda.vista', vista); } catch (e) { /* sem storage */ }
  carregar();
});
$('#ant').onclick = () => { base = addDias(base, vista === 'dia' ? -1 : -7); carregar(); };
$('#seg').onclick = () => { base = addDias(base, vista === 'dia' ? 1 : 7); carregar(); };
$('#hoje').onclick = () => { base = inicioDia(new Date()); carregar(); };
$('#btnMais').onclick = () => comBotao($('#btnMais'), () => carregar(true));

carregar();
