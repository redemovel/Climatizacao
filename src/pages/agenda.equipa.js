// Vista «Equipa» da agenda (Master/backoffice): o dia de cada técnico numa grelha horária, com blocos do tamanho
// da duração prevista e a ocupação de cada um. Mover/agendar: arrastar (computador) ou botão ⇄ / «Agendar» (telemóvel).
// As folhas «Por agendar» aparecem por baixo e podem ser arrastadas para a grelha.
const EQ_H0 = 7, EQ_H1 = 20, EQ_PX = 44, EQ_JORNADA = 8;
let eqPorAgendar = null;   // lido uma vez por visita (só a pedido da vista Equipa)

function duracaoDe(f) { return Number(f.duracaoPrevista) || duracaoTipo(f.tipo); }
function horaDecimal(d) { const x = paraData(d); return x.getHours() + x.getMinutes() / 60; }

async function colunasEquipa() {
  const tecs = await carregarTecnicos().catch(() => []);
  const cols = tecs.map((t) => ({ uid: t.uid, nome: t.nome }));
  for (const f of itens) if (f.tecnicoUid && !cols.some((c) => c.uid === f.tecnicoUid)) cols.push({ uid: f.tecnicoUid, nome: f.tecnicoNome || 'Sem nome', externo: true });
  if (itens.some((f) => !f.tecnicoUid)) cols.push({ uid: '', nome: 'Por atribuir' });
  return cols;
}

async function renderEquipa() {
  const box = $('#equipa');
  const [cols] = await Promise.all([colunasEquipa(), duracaoSugerida('', 'AT')]);
  const horas = [];
  for (let h = EQ_H0; h < EQ_H1; h++) horas.push(h);
  const altura = (EQ_H1 - EQ_H0) * EQ_PX;
  const colHtml = cols.map((c) => {
    const l = itens.filter((f) => (f.tecnicoUid || '') === c.uid).sort((a, b) => horaDecimal(a.dataPrevista) - horaDecimal(b.dataPrevista));
    // faixas para trabalhos sobrepostos
    const fins = [];
    const pos = l.map((f) => {
      const ini = horaDecimal(f.dataPrevista), fim = ini + duracaoDe(f);
      let faixa = fins.findIndex((x) => x <= ini + 0.001);
      if (faixa < 0) { faixa = fins.length; fins.push(fim); } else fins[faixa] = fim;
      return { f, ini, fim, faixa };
    });
    const nf = Math.max(1, fins.length);
    const ocup = l.reduce((s, f) => s + duracaoDe(f), 0);
    const blocos = pos.map(({ f, ini, faixa }) => {
      const top = Math.max(0, (ini - EQ_H0) * EQ_PX);
      const h = Math.max(24, Math.min(altura - top, duracaoDe(f) * EQ_PX) - 2);
      const est = classeEstado(f.estado).replace('estado-', 'b-');
      return `<div class="eq-bloco ${est}" data-id="${esc(f.id)}" draggable="true" style="top:${top}px;height:${h}px;left:calc(${(100 / nf) * faixa}% + 2px);width:calc(${100 / nf}% - 4px)"
        title="${esc(f.numero + ' · ' + f.clienteNome)}">
        <b>${esc(fmtHora(f.dataPrevista))}</b> ${esc(f.clienteNome)}<br><span>${esc(f.localidade || '')} · ${esc(fmtHorasD(duracaoDe(f)))}${f.duracaoPrevista ? '' : ' (est.)'}</span>
        <button class="eq-mover" data-mover="${esc(f.id)}" aria-label="Mover">⇄</button></div>`;
    }).join('');
    return `<div class="eq-coluna" data-tec="${esc(c.uid)}">
      <div class="eq-cab"><b>${esc(c.nome)}</b><span class="${ocup > EQ_JORNADA ? 'txt-erro' : 'muted'}">${esc(fmtHorasD(ocup))} / ${EQ_JORNADA} h</span></div>
      <div class="eq-corpo" data-tec="${esc(c.uid)}" style="height:${altura}px;background-size:100% ${EQ_PX}px">${blocos}</div></div>`;
  }).join('');
  box.innerHTML = `<div class="eq-wrap"><div class="eq-grade">
      <div class="eq-horas"><div class="eq-cab"></div><div style="height:${altura}px;position:relative">${horas.map((h) => `<span style="top:${(h - EQ_H0) * EQ_PX}px">${h}h</span>`).join('')}</div></div>
      ${colHtml}</div></div>
    <p class="muted" style="margin:6px 4px 12px;font-size:.85rem">Arraste um trabalho para outra hora ou técnico (no telemóvel use ⇄). Duração «est.» = duração real habitual do tipo (PHC).</p>
    <div class="cartao" id="eqPorAgendar"><h3 style="margin-top:0">Por agendar</h3><div class="vazio">A carregar…</div></div>`;
  carregarPorAgendar();
}

async function carregarPorAgendar() {
  try {
    if (!eqPorAgendar) {
      const snap = await getDocs(query(collection(db, 'folhas'), where('estado', '==', 'Por agendar'), orderBy('criadoEm', 'desc'), limit(20)));
      eqPorAgendar = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }
    const box = $('#eqPorAgendar');
    if (!box) return;
    box.innerHTML = `<h3 style="margin-top:0">Por agendar <span class="muted">${eqPorAgendar.length}${eqPorAgendar.length === 20 ? '+' : ''}</span></h3>` + (eqPorAgendar.length
      ? eqPorAgendar.map((f) => `<div class="eq-pa lista-item b-por-agendar" draggable="true" data-pa="${esc(f.id)}">
          <div><b>${esc(f.numero)}</b> · ${esc(f.clienteNome)}<div class="muted">${esc(TIPO_NOME[f.tipo] || f.tipo)} · ${esc(f.localidade || '')}${f.dataPrevista ? ' · sugerido ' + esc(fmtData(f.dataPrevista)) : ''}${f.tecnicoNome ? ' · ' + esc(f.tecnicoNome) : ''}</div></div>
          <button class="btn btn-peq btn-primario" data-agendar="${esc(f.id)}">Agendar</button></div>`).join('')
      : '<p class="muted" style="margin:0">Nada por agendar.</p>');
  } catch (e) { const b = $('#eqPorAgendar'); if (b) b.innerHTML = `<p class="msg-erro">${esc(erroFirebase(e))}</p>`; }
}

const eqFolha = (id) => itens.find((f) => f.id === id) || (eqPorAgendar || []).find((f) => f.id === id);

// arrastar (computador): blocos e cartões «Por agendar» → coluna do técnico, à hora onde se larga (de 15 em 15 min)
$('#equipa').addEventListener('dragstart', (ev) => {
  const el = ev.target.closest('[data-id],[data-pa]');
  if (!el) return;
  ev.dataTransfer.setData('text/plain', el.dataset.id || el.dataset.pa);
  ev.dataTransfer.effectAllowed = 'move';
});
$('#equipa').addEventListener('dragover', (ev) => { if (ev.target.closest('.eq-corpo')) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; } });
$('#equipa').addEventListener('drop', (ev) => {
  const col = ev.target.closest('.eq-corpo');
  if (!col) return;
  ev.preventDefault();
  const f = eqFolha(ev.dataTransfer.getData('text/plain'));
  if (!f) return;
  const y = ev.clientY - col.getBoundingClientRect().top;
  const h = Math.min(EQ_H1 - 0.25, Math.max(EQ_H0, EQ_H0 + Math.round((y / EQ_PX) * 4) / 4));
  const quando = new Date(base);
  quando.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
  moverFolha(f, { tecUid: col.dataset.tec, quando });
});
$('#equipa').addEventListener('click', (ev) => {
  const m = ev.target.closest('[data-mover],[data-agendar]');
  if (m) { ev.stopPropagation(); const f = eqFolha(m.dataset.mover || m.dataset.agendar); if (f) moverFolha(f, {}); return; }
  const b = ev.target.closest('.eq-bloco,[data-pa]');
  if (b) location.href = pagina('folhas', { id: b.dataset.id || b.dataset.pa });
});

// confirmação (e escolha no telemóvel): técnico, dia, hora, duração e aviso ao cliente
async function moverFolha(f, { tecUid, quando }) {
  const tecs = await carregarTecnicos().catch(() => []);
  const agendar = f.estado === 'Por agendar';
  const q = quando || (f.dataPrevista ? paraData(f.dataPrevista) : (() => { const d = new Date(base); d.setHours(9, 0, 0, 0); return d; })());
  const tSel = tecUid !== undefined && tecUid !== '' ? tecUid : (f.tecnicoUid || '');
  const sug = await duracaoSugerida(f.clienteId, f.tipo);
  const dur = Number(f.duracaoPrevista) || sug.h;
  const c = abrirModal(agendar ? 'Agendar ' + f.numero : 'Mover ' + f.numero, `
    <p style="margin-top:0"><b>${esc(f.clienteNome)}</b><br><span class="muted">${esc(TIPO_NOME[f.tipo] || f.tipo)} · ${esc([f.morada, f.localidade].filter(Boolean).join(', '))}</span></p>
    <label class="campo"><span>Técnico *</span><select id="mTec"><option value="">Escolher…</option>${tecs.map((t) => `<option value="${esc(t.uid)}" ${t.uid === tSel ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}
      ${tSel && !tecs.some((t) => t.uid === tSel) ? `<option value="${esc(tSel)}" selected>${esc(f.tecnicoNome || tSel)}</option>` : ''}</select></label>
    <div class="linha2">
      <label class="campo"><span>Dia *</span><input type="date" id="mData" value="${isoLocal(q)}"></label>
      <label class="campo"><span>Hora *</span><input type="time" id="mHora" step="900" value="${String(q.getHours()).padStart(2, '0')}:${String(q.getMinutes()).padStart(2, '0')}"></label>
    </div>
    <label class="campo"><span>Duração prevista (h)</span><input type="number" id="mDur" min="0.5" max="200" step="0.5" inputmode="decimal" value="${esc(String(dur))}">
      <small class="muted">${esc(sug.fonte === 'cliente' ? `Real neste cliente: ${fmtHorasD(sug.h)} (${sug.n} intervenções)` : sug.fonte === 'tipo' ? `Real deste tipo: ${fmtHorasD(sug.h)} (${sug.n} intervenções)` : `Habitual: ${fmtHorasD(sug.h)}`)}</small></label>
    <label class="campo"><span>Avisar o cliente por email</span><input type="email" id="mEmail" inputmode="email" autocomplete="off" value="${esc(emailDoCliente(f))}" placeholder="email@cliente.pt"></label>
    <label class="campo" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="mSem" style="width:auto;min-height:0"><span style="margin:0">Não enviar aviso desta vez</span></label>
    <div class="msg-erro" id="mErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="mOk">${agendar ? 'Agendar' : 'Mover'}</button></div>`);
  $('#mOk', c).onclick = () => {
    const erro = (m) => { $('#mErro', c).textContent = m; };
    const uid = $('#mTec', c).value;
    if (!uid) return erro('Escolha o técnico.');
    if (!$('#mData', c).value || !$('#mHora', c).value) return erro('Indique o dia e a hora.');
    const [hh, mm] = $('#mHora', c).value.split(':').map(Number);
    const d = deIsoLocal($('#mData', c).value); d.setHours(hh, mm, 0, 0);
    const duracao = Math.max(0, Math.min(200, Number(String($('#mDur', c).value).replace(',', '.')) || 0));
    const sem = $('#mSem', c).checked;
    const para = $('#mEmail', c).value.trim();
    if (!sem && !emailValido(para)) return erro('Indique o email do cliente, ou marque «Não enviar aviso desta vez».');
    const nome = (tecs.find((t) => t.uid === uid) || {}).nome || f.tecnicoNome || '';
    comBotao($('#mOk', c), async () => {
      try {
        await gravarMovimento(f, { uid, nome, quando: d, duracao, avisoPara: sem ? '' : para });
        fecharModal();
        toast(`${f.numero} ${agendar ? 'agendada' : 'movida'} para ${fmtDiaSemana(d)}, ${fmtHora(Timestamp.fromDate(d))}${sem ? '' : ' · aviso a enviar para ' + para}.`, 'ok', 5000);
        if (agendar) eqPorAgendar = null;
        carregar();
      } catch (e) { erro(erroFirebase(e)); }
    });
  };
}

async function gravarMovimento(f, { uid, nome, quando, duracao, avisoPara }) {
  const ref = doc(db, 'folhas', f.id);
  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    const d = s.data();
    if (!['Por agendar', 'Agendada'].includes(d.estado)) throw Object.assign(new Error(`${f.numero} já está «${d.estado}»: abra a folha para a alterar.`), { code: 'estado' });
    const alt = { dataPrevista: Timestamp.fromDate(quando), tecnicoUid: uid, tecnicoNome: nome, atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid };
    if (duracao) alt.duracaoPrevista = duracao;
    if (d.estado === 'Por agendar') {
      alt.estado = 'Agendada';
      alt.historico = [...(d.historico || []), { estado: 'Agendada', de: d.estado, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() }];
      alt.estadoAlteradoEm = serverTimestamp();
    }
    if (avisoPara) {
      const eRef = doc(collection(db, 'emails'));
      tx.set(eRef, dadosEmailAgendamento({ id: f.id, ...d, ...alt, dataPrevista: alt.dataPrevista }, avisoPara, d.estado !== 'Por agendar'));
      alt.avisoAgendamento = { para: avisoPara, emailId: eRef.id, pedidoEm: Timestamp.now(), uid: sessao.uid };
    }
    tx.update(ref, alt);
  });
}
