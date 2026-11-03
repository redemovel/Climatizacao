// Fase 2 — trabalho no local: registo de tempos, material aplicado, tarefas, relatório e assinatura do cliente.
// Tudo fica na própria folha (campos tempos, materiais, tarefas, relatorio, assinatura).
// Sem preços: o valor da mão de obra é calculado só para o Master, com a tabela em config/precosHora.

function tarefasPadrao() {
  return ['Cliente no local', 'Limpeza do local', 'Cliente satisfeito', 'Ficha de fluorados', 'Relatório de visita'];
}
function unidadesMaterial() { return ['un', 'm', 'kg', 'l', 'cx', 'rolo']; }

// O técnico regista trabalho enquanto a folha está em curso ou pendente; master/backoffice em qualquer estado aberto.
function podeRegistarTrabalho(f) {
  if (tecnico) return f.tecnicoUid === sessao.uid && ['Em curso', 'Pendente'].includes(f.estado);
  if (sessao.perfil === 'master') return f.estado !== 'Faturada' && f.estado !== 'Anulada';
  return staff && !ESTADOS_MASTER.includes(f.estado);
}

function fmtHoras(h) { return (Math.round((Number(h) || 0) * 100) / 100).toLocaleString('pt-PT') + ' h'; }
function pessoasTempo(t) { return (t.equipa || []).length || ((t.tecnicos || 1) + (t.ajudantes || 0) + (t.aprendizes || 0)); }
function equipaTexto(t) {
  if ((t.equipa || []).length) return t.equipa.map((p) => p.nome).join(', ');
  const p = [`${t.tecnicos || 1} técnico${(t.tecnicos || 1) > 1 ? 's' : ''}`];
  if (t.ajudantes) p.push(`${t.ajudantes} ajudante${t.ajudantes > 1 ? 's' : ''}`);
  return p.join(' + ');
}
function novoIdItem() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Altera a folha numa transação (vários técnicos/backoffice podem estar a escrever ao mesmo tempo).
async function alterarTrabalho(fn, msgOk) {
  const ref = doc(db, 'folhas', atual.id);
  try {
    const res = await runTransaction(db, async (tx) => {
      const s = await tx.get(ref);
      const d = s.data();
      const alt = fn(d);
      if (!alt) return null;
      alt.atualizadoEm = serverTimestamp();
      alt.atualizadoPor = sessao.uid;
      tx.update(ref, alt);
      return { ...d, ...alt, atualizadoEm: Timestamp.now() };
    });
    if (!res) return false;
    atual = { id: atual.id, ...res };
    const i = lista.findIndex((x) => x.id === atual.id);
    if (i >= 0) lista[i] = atual;
    if (msgOk) toast(msgOk, 'ok');
    renderDetalhe();
    return true;
  } catch (e) { toast(erroFirebase(e), 'erro', 5000); return false; }
}

// ---------- HTML dos cartões (chamado por renderDetalhe) ----------
function htmlTrabalho(f) {
  const pode = podeRegistarTrabalho(f);
  const tempos = f.tempos || [];
  const mats = f.materiais || [];
  const tarefas = f.tarefas || {};
  const total = tempos.reduce((s, t) => s + (Number(t.horas) || 0) * pessoasTempo(t), 0);
  const podeApagar = (x) => pode && (staff || x.uid === sessao.uid);
  const ass = f.assinatura;
  return `
    <div class="cartao" id="cartaoTempos">
      <div class="cab-cartao"><h3>Registo de tempos</h3>${pode ? '<button class="btn btn-peq btn-primario" id="btnTempo">+ Tempo</button>' : ''}</div>
      ${tempos.length ? `<ul class="hist">${tempos.map((t) => `
        <li data-tempo="${esc(t.id)}"><b>${esc(fmtHoras(t.horas))}</b>
          <span><b class="equipa">${esc(equipaTexto(t))}</b><br>${esc(fmtData(t.data))}${t.inicio ? ` · das ${esc(t.inicio)} às ${esc(t.fim)}` : ''}${t.nota ? `<br><span class="muted">${esc(t.nota)}</span>` : ''}</span>
          <span class="muted">${esc(t.nome || '')}${podeApagar(t) ? ` <button class="lixo" data-apagar-tempo="${esc(t.id)}" aria-label="Apagar">✕</button>` : ''}</span></li>`).join('')}</ul>
        <p class="muted" style="margin:6px 0 0" id="totalHoras">Total: ${esc(fmtHoras(total))} de mão de obra (horas × pessoas)</p>`
        : '<p class="muted" style="margin:0">Sem tempos registados.</p>'}
      ${sessao.perfil === 'master' && tempos.length ? '<div id="valorMO" class="valor-mo"><p class="muted" style="margin:0">A calcular o valor…</p></div>' : ''}
    </div>
    <div class="cartao" id="cartaoMateriais">
      <div class="cab-cartao"><h3>Material aplicado</h3>${pode ? '<button class="btn btn-peq btn-primario" id="btnMaterial">+ Material</button>' : ''}</div>
      ${mats.length ? `<ul class="hist">${mats.map((m) => `
        <li><b>${esc(String(m.qtd).replace('.', ','))} ${esc(m.unidade || '')}</b><span>${esc(m.descricao)}${m.ref ? `<br><span class="muted">${esc(m.ref)}</span>` : ''}</span>
          <span class="muted">${esc(m.nome || '')}${podeApagar(m) ? ` <button class="lixo" data-apagar-mat="${esc(m.id)}" aria-label="Apagar">✕</button>` : ''}</span></li>`).join('')}</ul>`
        : '<p class="muted" style="margin:0">Sem material registado.</p>'}
    </div>
    <div class="cartao" id="cartaoTarefas">
      <h3 style="margin-top:0">Tarefas</h3>
      <div class="tarefas">${tarefasPadrao().map((t) => `
        <label class="tarefa"><input type="checkbox" data-tarefa="${esc(t)}" ${tarefas[t] ? 'checked' : ''} ${pode ? '' : 'disabled'}><span>${esc(t)}</span></label>`).join('')}</div>
    </div>
    <div class="cartao" id="cartaoRelatorio">
      <h3 style="margin-top:0">Relatório de intervenção</h3>
      ${pode ? `<textarea id="relatorio" placeholder="O que foi feito, o que foi encontrado, recomendações ao cliente…">${esc(f.relatorio || '')}</textarea>
        <div class="acoes"><button class="btn" id="btnRelatorio">Guardar relatório</button></div>`
        : `<p style="white-space:pre-wrap;margin:0">${esc(f.relatorio || '—')}</p>`}
      ${ass ? `<div class="assinatura" id="assinaturaCli">
        ${ass.ausente ? '<p style="margin:0"><b>Cliente ausente</b> — sem assinatura.</p>'
          : `<img src="${esc(ass.imagem || '')}" alt="Assinatura do cliente"><p style="margin:4px 0 0"><b>${esc(ass.nome || '')}</b></p>`}
        <p class="muted" style="margin:2px 0 0">${esc(fmtDataHora(ass.em))}${ass.registadoPor ? ' · ' + esc(ass.registadoPor) : ''}</p></div>` : ''}
    </div>`;
}

function ligarTrabalho() {
  if ($('#btnTempo')) $('#btnTempo').onclick = () => formTempo();
  if ($('#btnMaterial')) $('#btnMaterial').onclick = () => formMaterial();
  if ($('#btnRelatorio')) $('#btnRelatorio').onclick = () => comBotao($('#btnRelatorio'), guardarRelatorio);
  if ($('#valorMO')) mostrarValorMO();   // automático, só para o Master (a tabela de preços nunca chega aos outros perfis)
  $$('[data-apagar-tempo]').forEach((b) => b.onclick = async () => {
    if (!(await confirmar('Apagar este registo de tempo?', { ok: 'Apagar', perigo: true }))) return;
    alterarTrabalho((d) => ({ tempos: (d.tempos || []).filter((t) => t.id !== b.dataset.apagarTempo) }), 'Tempo apagado.');
  });
  $$('[data-apagar-mat]').forEach((b) => b.onclick = async () => {
    if (!(await confirmar('Apagar este material?', { ok: 'Apagar', perigo: true }))) return;
    alterarTrabalho((d) => ({ materiais: (d.materiais || []).filter((m) => m.id !== b.dataset.apagarMat) }), 'Material apagado.');
  });
  $$('[data-tarefa]').forEach((c) => c.onchange = () => {
    const t = c.dataset.tarefa, v = c.checked;
    alterarTrabalho((d) => ({ tarefas: { ...(d.tarefas || {}), [t]: v } }));
  });
}

// Colaboradores (nome + função: Técnico/Ajudante/Aprendiz) — lidos uma vez por página.
let colaboradoresCache = null;
async function carregarColaboradores() {
  if (colaboradoresCache) return colaboradoresCache;
  const snap = await getDocs(query(collection(db, 'colaboradores'), where('ativo', '==', true), limit(60)));
  colaboradoresCache = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.externo ? 1 : 0) - (b.externo ? 1 : 0) || a.nome.localeCompare(b.nome, 'pt'));
  return colaboradoresCache;
}
function contarFuncoes(equipa) {
  const n = (f) => equipa.filter((p) => p.funcao === f).length;
  return { tecnicos: n('Técnico'), ajudantes: n('Ajudante'), aprendizes: n('Aprendiz') };
}

async function formTempo() {
  let cols;
  try { cols = await carregarColaboradores(); } catch (e) { toast(erroFirebase(e), 'erro'); return; }
  if (!cols.length) { toast('Ainda não há colaboradores definidos (Utilizadores › Colaboradores).', 'erro', 6000); return; }
  const hoje = isoLocal(new Date());
  const euMesmo = cols.find((p) => p.uid === sessao.uid) || cols.find((p) => p.uid && p.uid === atual.tecnicoUid);
  const c = abrirModal('Registar tempo', `
    <div class="campo"><span>Quem esteve presente *</span>
      <div class="tarefas" id="tEquipa">${cols.map((p) => `
        <label class="tarefa"><input type="checkbox" value="${esc(p.id)}" ${euMesmo && euMesmo.id === p.id ? 'checked' : ''}>
          <span>${esc(p.nome)} <span class="muted">· ${esc(p.funcao)}</span></span></label>`).join('')}</div></div>
    <label class="campo"><span>Dia *</span><input type="date" id="tData" value="${hoje}" max="${hoje}"></label>
    <div class="grelha-2">
      <label class="campo"><span>Das *</span><input type="time" id="tIni" step="300"></label>
      <label class="campo"><span>Às *</span><input type="time" id="tFim" step="300"></label>
    </div>
    <label class="campo"><span>Nota</span><input id="tNota" maxlength="300" placeholder="Opcional"></label>
    <p class="muted" id="tResumo" style="margin:0 0 8px"></p>
    <div class="msg-erro" id="tErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="tGuardar">Guardar</button></div>`);
  const horas = () => {
    const a = $('#tIni', c).value, b = $('#tFim', c).value;
    if (!a || !b) return null;
    const [h1, m1] = a.split(':').map(Number), [h2, m2] = b.split(':').map(Number);
    return ((h2 * 60 + m2) - (h1 * 60 + m1)) / 60;
  };
  const escolhidos = () => $$('#tEquipa input:checked', c).map((i) => cols.find((p) => p.id === i.value));
  const resumo = () => {
    const h = horas(), n = escolhidos().length;
    $('#tResumo', c).textContent = h > 0 ? `Duração: ${fmtHoras(h)}${n > 1 ? ` × ${n} pessoas = ${fmtHoras(h * n)}` : ''}` : '';
  };
  $('#tIni', c).oninput = resumo; $('#tFim', c).oninput = resumo; $('#tEquipa', c).onchange = resumo;
  $('#tGuardar', c).onclick = () => {
    const erro = (m) => { $('#tErro', c).textContent = m; };
    const dia = $('#tData', c).value;
    const h = horas();
    const equipa = escolhidos().map((p) => ({ id: p.id, nome: p.nome, funcao: p.funcao }));
    if (!equipa.length) return erro('Indique quem esteve presente.');
    if (!equipa.some((p) => p.funcao === 'Técnico')) return erro('Tem de estar pelo menos um técnico.');
    if (!dia) return erro('Indique o dia.');
    if (dia > hoje) return erro('Não pode registar tempo num dia futuro.');
    if (h === null) return erro('Indique a hora de início e de fim.');
    if (h <= 0) return erro('A hora de fim tem de ser depois da de início.');
    if (h > 16) return erro('Mais de 16 horas num só registo? Verifique as horas.');
    const t = {
      id: novoIdItem(), data: Timestamp.fromDate(deIsoLocal(dia, '12:00')), inicio: $('#tIni', c).value, fim: $('#tFim', c).value,
      horas: Math.round(h * 100) / 100, equipa, ...contarFuncoes(equipa),
      nota: $('#tNota', c).value.trim(), uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now(),
    };
    comBotao($('#tGuardar', c), async () => {
      if (await alterarTrabalho((d) => {
        if ((d.tempos || []).length >= 200) { erro('Limite de registos atingido.'); return null; }
        return { tempos: [...(d.tempos || []), t] };
      }, 'Tempo registado.')) fecharModal();
    });
  };
}

function formMaterial() {
  const c = abrirModal('Registar material', `
    <label class="campo"><span>Descrição *</span><input id="mDesc" maxlength="200" placeholder="Ex.: Tubo cobre 1/4&quot;"></label>
    <label class="campo"><span>Referência</span><input id="mRef" maxlength="60" placeholder="Opcional" autocomplete="off"></label>
    <div class="grelha-2">
      <label class="campo"><span>Quantidade *</span><input id="mQtd" type="number" inputmode="decimal" min="0" step="any"></label>
      <label class="campo"><span>Unidade</span><select id="mUn">${unidadesMaterial().map((u) => `<option>${u}</option>`).join('')}</select></label>
    </div>
    <div class="msg-erro" id="mErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="mGuardar">Guardar</button></div>`);
  $('#mGuardar', c).onclick = () => {
    const erro = (m) => { $('#mErro', c).textContent = m; };
    const descricao = $('#mDesc', c).value.trim();
    const qtd = Number(String($('#mQtd', c).value).replace(',', '.'));
    if (descricao.length < 2) return erro('Indique a descrição do material.');
    if (!(qtd > 0)) return erro('Indique a quantidade.');
    const m = { id: novoIdItem(), descricao, ref: $('#mRef', c).value.trim(), qtd, unidade: $('#mUn', c).value, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() };
    comBotao($('#mGuardar', c), async () => {
      if (await alterarTrabalho((d) => {
        if ((d.materiais || []).length >= 300) { erro('Limite de linhas atingido.'); return null; }
        return { materiais: [...(d.materiais || []), m] };
      }, 'Material registado.')) fecharModal();
    });
  };
}

async function guardarRelatorio() {
  const txt = $('#relatorio').value.trim();
  await alterarTrabalho(() => ({ relatorio: txt }), 'Relatório guardado.');
}

// ---------- Conclusão: relatório + assinatura do cliente ----------
// Devolve { relatorio, assinatura } ou null se cancelar.
function pedirConclusao(f) {
  return new Promise((resolve) => {
    const semTempos = !(f.tempos || []).length;
    const c = abrirModal('Concluir trabalho', `
      ${semTempos ? '<p class="aviso-concl">Ainda não registou tempos nesta folha.</p>' : ''}
      <label class="campo"><span>Relatório de intervenção *</span><textarea id="cRel" placeholder="O que foi feito…">${esc(($('#relatorio') && $('#relatorio').value) || f.relatorio || '')}</textarea></label>
      <label class="campo"><span>Nome de quem assina *</span><input id="cNome" maxlength="120" autocomplete="off" value="${esc(f.contacto || '')}"></label>
      <div class="campo"><span>Assinatura do cliente *</span>
        <canvas id="cAss" class="quadro-ass" width="600" height="240"></canvas>
        <button type="button" class="btn btn-peq" id="cLimpar" style="margin-top:6px">Limpar</button></div>
      <label class="campo" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="cAusente" style="width:auto;min-height:0"><span style="margin:0">Cliente ausente (sem assinatura)</span></label>
      <div class="msg-erro" id="cErro"></div>
      <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="cOk">Concluir</button></div>`,
    { aoFechar: () => resolve(null) });
    const cv = $('#cAss', c);
    const ctx = cv.getContext('2d');
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0f172a';
    let desenhou = false, ativo = false;
    const pos = (ev) => { const r = cv.getBoundingClientRect(); return [(ev.clientX - r.left) * cv.width / r.width, (ev.clientY - r.top) * cv.height / r.height]; };
    cv.addEventListener('pointerdown', (ev) => { ativo = true; cv.setPointerCapture(ev.pointerId); const [x, y] = pos(ev); ctx.beginPath(); ctx.moveTo(x, y); ev.preventDefault(); });
    cv.addEventListener('pointermove', (ev) => { if (!ativo) return; const [x, y] = pos(ev); ctx.lineTo(x, y); ctx.stroke(); desenhou = true; ev.preventDefault(); });
    const parar = () => { ativo = false; };
    cv.addEventListener('pointerup', parar); cv.addEventListener('pointercancel', parar);
    $('#cLimpar', c).onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); desenhou = false; };
    $('#cAusente', c).onchange = () => { const a = $('#cAusente', c).checked; cv.classList.toggle('desativado', a); $('#cNome', c).disabled = a; };
    $('#cOk', c).onclick = () => {
      const erro = (m) => { $('#cErro', c).textContent = m; };
      const relatorio = $('#cRel', c).value.trim();
      const ausente = $('#cAusente', c).checked;
      const nome = $('#cNome', c).value.trim();
      if (relatorio.length < 3) return erro('Escreva o relatório de intervenção.');
      if (!ausente && nome.length < 2) return erro('Indique o nome de quem assina.');
      if (!ausente && !desenhou) return erro('Peça ao cliente para assinar, ou marque «Cliente ausente».');
      const assinatura = { ausente, nome: ausente ? '' : nome, imagem: ausente ? '' : reduzirAssinatura(cv), em: Timestamp.now(), uid: sessao.uid, registadoPor: sessao.nome || sessao.email };
      fecharModal();
      resolve({ relatorio, assinatura });
    };
  });
}

// PNG pequeno (300×120) para caber folgado no documento da folha.
function reduzirAssinatura(cv) {
  const o = document.createElement('canvas');
  o.width = 300; o.height = 120;
  const x = o.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, o.width, o.height);
  x.drawImage(cv, 0, 0, o.width, o.height);
  return o.toDataURL('image/png');
}

// ---------- Valor da mão de obra (só Master) ----------
// Tabela em config/precosHora: linhas { tipo: 'Manutenção' | 'AT/Instalação', composicao, tecnicos, ajudantes, aprendizes, preco },
// acréscimos em %: primeiraHora, segundaHora, fimDeSemana.
function chaveTipoPreco(tipo) { return tipo === 'Manutenção' ? 'Manutenção' : 'AT/Instalação'; }
function valorTempo(t, tipoFolha, tabela) {
  const linha = (tabela.linhas || []).find((l) => l.tipo === chaveTipoPreco(tipoFolha) && l.tecnicos === (t.tecnicos || 1)
    && (l.ajudantes || 0) === (t.ajudantes || 0) && (l.aprendizes || 0) === (t.aprendizes || 0));
  if (!linha) return null;
  const p = linha.preco, h = Number(t.horas) || 0;
  const a1 = 1 + (tabela.primeiraHora ?? 20) / 100, a2 = 1 + (tabela.segundaHora ?? 10) / 100;
  let v = p * (Math.min(h, 1) * a1 + Math.min(Math.max(h - 1, 0), 1) * a2 + Math.max(h - 2, 0));
  const dow = paraData(t.data).getDay();
  const fds = dow === 0 || dow === 6;
  if (fds) v *= 1 + (tabela.fimDeSemana ?? 100) / 100;
  return { preco: p, valor: Math.round(v * 100) / 100, fds, composicao: linha.composicao || '' };
}
let tabelaPrecosCache = null;
async function mostrarValorMO() {
  const eur = (v) => (Number(v) || 0).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
  try {
    if (!tabelaPrecosCache) { const s = await getDoc(doc(db, 'config', 'precosHora')); tabelaPrecosCache = s.exists() ? s.data() : { linhas: [] }; }
    const tab = tabelaPrecosCache;
    if (!$('#valorMO')) return;
    if (!(tab.linhas || []).length) { $('#valorMO').innerHTML = '<p class="muted" style="margin:0">Falta a tabela de preço/hora (Utilizadores › Preço/hora).</p>'; return; }
    let total = 0, falta = false;
    const linhas = (atual.tempos || []).map((t) => {
      const r = valorTempo(t, atual.tipo, tab);
      if (!r) { falta = true; return `<li><span>${esc(fmtData(t.data))}</span><span>${esc(equipaTexto(t))}</span><b class="muted">sem preço</b></li>`; }
      total += r.valor;
      return `<li><span>${esc(fmtData(t.data))}${r.fds ? ' (fim de semana)' : ''}</span><span>${esc(fmtHoras(t.horas))} · ${esc(r.composicao)} · ${esc(eur(r.preco))}/h</span><b>${esc(eur(r.valor))}</b></li>`;
    }).join('');
    $('#valorMO').innerHTML = `<h3>Valor da mão de obra <span class="muted" style="font-weight:400">· só o Master vê</span></h3><ul class="hist">${linhas}</ul>
      <p style="text-align:right;margin:8px 0 0"><b id="totalMO">Total: ${esc(eur(total))}</b> <span class="muted">s/IVA</span></p>
      <p class="muted" style="margin:4px 0 0">1.ª hora +${esc(String(tab.primeiraHora ?? 20))}%, 2.ª hora +${esc(String(tab.segundaHora ?? 10))}%, fim de semana +${esc(String(tab.fimDeSemana ?? 100))}%.${falta ? ' Há equipas sem preço na tabela.' : ''}</p>`;
  } catch (e) { toast(erroFirebase(e), 'erro'); }
}
