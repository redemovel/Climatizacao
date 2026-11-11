// Fase 2 — trabalho no local: registo de tempos, material aplicado, tarefas, relatório e assinatura do cliente.
// Tudo fica na própria folha (campos tempos, materiais, tarefas, relatorio, assinatura).
// Sem preços: o valor da mão de obra é calculado só para o Master, com a tabela em config/precosHora.

function tarefasPadrao(f) {
  const base = ['Cliente no local', 'Limpeza do local', 'Cliente satisfeito', 'Ficha de fluorados', 'Relatório de visita'];
  // tarefas definidas no contrato de manutenção vêm primeiro
  const extra = (f && f.tarefasExtra) || [];
  return [...extra, ...base.filter((t) => !extra.includes(t))];
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
// fn(d, guia) devolve as alterações da folha, ou { alt, mov, exige, guiaId, guiaAlt } quando mexe em stock/guias.
// series: n.º de série a ler na mesma transação (fn recebe { idSerie: dados|null }); r.seriesSet / r.seriesDel gravam/apagam.
async function alterarTrabalho(fn, msgOk, { guiaId = null, series = [] } = {}) {
  const ref = doc(db, 'folhas', atual.id);
  try {
    const res = await runTransaction(db, async (tx) => {
      const s = await tx.get(ref);
      const d = s.data();
      let guia = null;
      if (guiaId) { const g = await tx.get(doc(db, 'guias', guiaId)); guia = g.exists() ? { id: g.id, ...g.data() } : null; }
      const sers = {};
      for (const sr of series) { const x = await tx.get(doc(db, 'series', idSerie(sr))); sers[idSerie(sr)] = x.exists() ? x.data() : null; }
      let r = fn(d, guia, sers);
      if (!r) return null;
      if (!r.alt) r = { alt: r };
      const aplicar = r.mov && Object.keys(r.mov).length ? await aplicarReservas(tx, r.mov, r.exige || new Set()) : null;
      const alt = r.alt;
      alt.atualizadoEm = serverTimestamp();
      alt.atualizadoPor = sessao.uid;
      tx.update(ref, alt);
      if (r.guiaAlt && guia) tx.update(doc(db, 'guias', guia.id), { ...r.guiaAlt, atualizadoEm: serverTimestamp(), atualizadoPor: sessao.uid });
      for (const [k, v] of Object.entries(r.seriesSet || {})) tx.set(doc(db, 'series', k), { ...v, atualizadoEm: serverTimestamp(), uid: sessao.uid });
      for (const k of r.seriesDel || []) tx.delete(doc(db, 'series', k));
      if (aplicar) aplicar();
      return { ...d, ...alt, atualizadoEm: Timestamp.now() };
    });
    if (!res) return false;
    atual = { id: atual.id, ...res };
    const i = lista.findIndex((x) => x.id === atual.id);
    if (i >= 0) lista[i] = atual;
    if (msgOk) toast(msgOk, 'ok');
    renderDetalhe();
    return true;
  } catch (e) { toast(['stock', 'artigo', 'guia', 'serie'].includes(e.code) ? e.message : erroFirebase(e), 'erro', 6000); return false; }
}
const erroSerie = (m) => Object.assign(new Error(m), { code: 'serie' });
// Um n.º de série só pode estar numa guia aberta ou aplicado numa folha.
function verificarSerieLivre(sr, info, permitirGuiaId = null) {
  if (!info) return;
  if (info.estado === 'folha') throw erroSerie(`O n.º de série ${sr} já foi aplicado na ${info.folhaNumero || 'outra folha'}.`);
  if (info.estado === 'guia' && info.guiaId !== permitirGuiaId) throw erroSerie(`O n.º de série ${sr} está na guia ${info.guiaNumero || '(por comunicar)'}: use «Importar da guia».`);
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
      ${tempos.length ? `<ul class="tempos">${tempos.map((t) => `
        <li data-tempo="${esc(t.id)}"><div class="t-cab"><b>${esc(fmtData(t.data, { day: '2-digit', month: '2-digit' }))}</b>
            <span>${t.inicio ? esc(t.inicio + '–' + t.fim) : ''}</span><b class="t-h">${esc(fmtHoras(t.horas))}</b>
            ${podeApagar(t) ? `<button class="lixo" data-apagar-tempo="${esc(t.id)}" aria-label="Apagar">✕</button>` : ''}</div>
          <div class="t-eq">${esc(equipaTexto(t))}${t.nota ? ` · <span class="muted">${esc(t.nota)}</span>` : ''}</div></li>`).join('')}</ul>
        <p class="muted" style="margin:6px 0 0" id="totalHoras">Total: ${esc(fmtHoras(total))} (soma das horas de cada pessoa)</p>`
        : '<p class="muted" style="margin:0">Sem tempos registados.</p>'}
      ${sessao.perfil === 'master' && tempos.length ? '<div id="valorMO" class="valor-mo"><p class="muted" style="margin:0">A calcular o valor…</p></div>' : ''}
    </div>
    ${sessao.perfil === 'master' && (tempos.length || mats.length) ? '<div class="cartao" id="cartaoRent"><h3 style="margin-top:0">Rentabilidade <span class="muted" style="font-weight:400">· só o Master vê</span></h3><p class="muted" style="margin:0">A calcular…</p></div>' : ''}
    <div class="cartao" id="cartaoMateriais">
      <div class="cab-cartao"><h3>Material aplicado</h3>${pode ? '<button class="btn btn-peq btn-primario" id="btnMaterial">+ Material</button>' : ''}</div>
      ${pode ? `<div class="acoes-mat"><button class="btn btn-peq" id="btnImportarGuia">Importar da guia</button>
        <a class="btn btn-peq" id="btnNovaGuia" href="${pagina('guias', { nova: 1, folha: f.id })}">Nova guia de transporte</a></div>` : ''}
      ${mats.length ? `<ul class="hist">${mats.map((m) => `
        <li><b>${esc(fmtQtd(m.qtd))} ${esc(m.unidade || '')}</b><span>${esc(m.descricao)}${m.ref ? `<br><span class="muted">${esc(m.ref)}${m.guiaNumero ? ' · guia ' + esc(m.guiaNumero) : m.artigoId ? ' · do stock' : ' · fora do stock'}</span>` : ''}${(m.series || []).length ? `<br>${m.series.map((x) => `<span class="serie-tag">${esc(x)}</span>`).join('')}` : ''}</span>
          <span class="muted">${esc(m.nome || '')}${podeApagar(m) ? ` <button class="lixo" data-apagar-mat="${esc(m.id)}" aria-label="Apagar">✕</button>` : ''}</span></li>`).join('')}</ul>`
        : '<p class="muted" style="margin:0">Sem material registado.</p>'}
    </div>
    <div class="cartao" id="cartaoTarefas">
      <h3 style="margin-top:0">Tarefas</h3>
      <div class="tarefas">${tarefasPadrao(f).map((t) => `
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
  if ($('#cartaoRent')) mostrarRentabilidade();
  $$('[data-apagar-tempo]').forEach((b) => b.onclick = async () => {
    if (!(await confirmar('Apagar este registo de tempo?', { ok: 'Apagar', perigo: true }))) return;
    alterarTrabalho((d) => ({ tempos: (d.tempos || []).filter((t) => t.id !== b.dataset.apagarTempo) }), 'Tempo apagado.');
  });
  if ($('#btnImportarGuia')) $('#btnImportarGuia').onclick = () => comBotao($('#btnImportarGuia'), importarDaGuia);
  $$('[data-apagar-mat]').forEach((b) => b.onclick = async () => {
    const m0 = (atual.materiais || []).find((m) => m.id === b.dataset.apagarMat);
    if (!m0) return;
    if (!(await confirmar(m0.guiaId ? 'Apagar este material? Volta a ficar disponível na guia.' : 'Apagar este material?', { ok: 'Apagar', perigo: true }))) return;
    alterarTrabalho((d, guia) => {
      const m = (d.materiais || []).find((x) => x.id === m0.id);
      if (!m) return null;
      const r = { alt: { materiais: (d.materiais || []).filter((x) => x.id !== m.id) }, mov: {}, seriesSet: {}, seriesDel: [] };
      const volta = !!(m.guiaId && guia && guia.estado === 'Comunicada');   // guia ainda aberta: o material volta para a guia
      if (m.artigoId) {
        r.mov[m.artigoId] = { resFolhas: -m.qtd, resGuias: volta ? m.qtd : 0 };
        if (volta) r.guiaAlt = { linhas: guia.linhas.map((l) => l.id !== m.guiaLinha ? l
          : { ...l, consumido: r3((l.consumido || 0) - m.qtd), consumos: (l.consumos || []).filter((c) => c.materialId !== m.id),
            seriesUsadas: (l.seriesUsadas || []).filter((x) => !(m.series || []).includes(x)) }) };
      }
      for (const sr of m.series || []) {
        if (volta) r.seriesSet[idSerie(sr)] = { serie: sr, artigoId: m.artigoId || '', ref: m.ref || '', estado: 'guia', guiaId: guia.id, guiaNumero: guia.numero || '', folhaId: '', folhaNumero: '' };
        else r.seriesDel.push(idSerie(sr));
      }
      return r;
    }, 'Material apagado.', { guiaId: m0.guiaId || null });
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
  let artigo = null;
  let seriesIniciais = [];
  const c = abrirModal('Registar material', `
    <label class="campo"><span>Procurar no stock (referência, nome ou n.º de série)</span>
      <div style="display:flex;gap:8px"><input id="mProc" autocomplete="off" placeholder="Referência, nome ou n.º de série"><button class="btn" id="mProcBtn" type="button">Procurar</button></div></label>
    <div id="mRes"></div>
    <div id="mEscolhido"></div>
    <label class="campo"><span>Descrição *</span><input id="mDesc" maxlength="200" placeholder="Ou escreva, se não for material do stock"></label>
    <label class="campo"><span>Referência</span><input id="mRef" maxlength="60" placeholder="Opcional" autocomplete="off"></label>
    <div class="grelha-2">
      <label class="campo"><span>Quantidade *</span><input id="mQtd" type="number" inputmode="decimal" min="0" step="any"></label>
      <label class="campo"><span>Unidade</span><select id="mUn">${unidadesMaterial().map((u) => `<option>${u}</option>`).join('')}</select></label>
    </div>
    <div id="mSeries" class="series-campos"></div>
    <div class="msg-erro" id="mErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="mGuardar">Guardar</button></div>`);
  // equipamentos: um n.º de série por unidade
  const desenharSeries = () => {
    const box = $('#mSeries', c);
    if (!artigo || !artigo.comSerie) { box.innerHTML = ''; return; }
    const n = Math.max(0, Math.min(50, Math.floor(Number(String($('#mQtd', c).value).replace(',', '.')) || 0)));
    const atuais = $$('input[data-serie]', c).map((i) => i.value);
    box.innerHTML = n ? Array.from({ length: n }, (_, i) => `<input data-serie="${i}" autocomplete="off" placeholder="N.º de série ${i + 1} *" value="${esc(atuais[i] || seriesIniciais[i] || '')}">`).join('')
      : '<p class="muted" style="margin:0">Equipamento com n.º de série: indique a quantidade (em unidades).</p>';
  };
  $('#mQtd', c).oninput = desenharSeries;
  const escolher = (a, serie) => {
    artigo = a;
    seriesIniciais = serie ? [serie] : [];
    $('#mRes', c).innerHTML = '';
    $('#mDesc', c).value = a.design; $('#mRef', c).value = a.ref;
    $('#mDesc', c).disabled = true; $('#mRef', c).disabled = true;
    const un = $('#mUn', c);
    if (a.unidade && ![...un.options].some((o) => o.value === a.unidade)) un.insertAdjacentHTML('beforeend', `<option>${esc(a.unidade)}</option>`);
    if (a.unidade) un.value = a.unidade;
    un.disabled = true;
    $('#mEscolhido', c).innerHTML = `<p class="stock-info" id="mDisp">Stock ${esc(fmtQtd(a.stock))} · disponível <b>${esc(fmtQtd(disponivel(a)))} ${esc(a.unidade || '')}</b>${a.comSerie ? ' · <b>com n.º de série</b>' : ''}
      <button type="button" class="btn btn-peq" id="mOutro">Outro</button></p>`;
    $('#mOutro', c).onclick = () => { artigo = null; $('#mEscolhido', c).innerHTML = ''; ['#mDesc', '#mRef', '#mUn'].forEach((k) => { $(k, c).disabled = false; }); $('#mDesc', c).value = ''; $('#mRef', c).value = ''; desenharSeries(); };
    if (serie) $('#mQtd', c).value = 1;
    desenharSeries();
    $('#mQtd', c).focus();
  };
  const procurar = () => comBotao($('#mProcBtn', c), async () => {
    const t = $('#mProc', c).value.trim();
    if (t.length < 2) return;
    try {
      // 1.º: é um n.º de série? (já usado numa guia/folha, ou em armazém no PHC → artigo encontrado de imediato)
      if (t.length >= 3 && !/\s/.test(t)) {
        const r = await procurarSerie(t);
        if (r && r.uso) {
          const x = r.uso;
          $('#mRes', c).innerHTML = x.estado === 'guia'
            ? `<p class="aviso-concl">O n.º de série ${esc(x.serie)} está na guia ${esc(x.guiaNumero || '(por comunicar)')}. Use «Importar da guia».</p>`
            : `<p class="aviso-concl">O n.º de série ${esc(x.serie)} já foi aplicado na ${esc(x.folhaNumero || 'outra folha')}.</p>`;
          return;
        }
        if (r && r.artigo) { escolher(r.artigo, r.serie); toast(`N.º de série ${r.serie}: ${r.artigo.ref} (em armazém).`, 'ok'); return; }
      }
      const l = await pesquisarArtigos(t);
      $('#mRes', c).innerHTML = l.length ? `<div class="lista-artigos">${l.map((x, i) => `
        <button type="button" class="artigo-op" data-i="${i}"><b>${esc(x.ref)}</b> ${esc(x.design)}${x.comSerie ? ' <span class="serie-tag">N.º série</span>' : ''}<span class="${disponivel(x) > 0 ? 'disp' : 'disp zero'}">${esc(fmtQtd(disponivel(x)))} ${esc(x.unidade || '')} disp.</span></button>`).join('')}</div>`
        : '<p class="muted">Nenhum artigo encontrado. Se é um n.º de série de um equipamento novo, procure o equipamento pelo nome ou referência.</p>';
      $$('.artigo-op', c).forEach((bt) => bt.onclick = () => escolher(l[+bt.dataset.i]));
    } catch (e) { toast(erroFirebase(e), 'erro'); }
  });
  $('#mProcBtn', c).onclick = procurar;
  $('#mProc', c).onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); procurar(); } };
  $('#mGuardar', c).onclick = () => {
    const erro = (m) => { $('#mErro', c).textContent = m; };
    const descricao = $('#mDesc', c).value.trim();
    const qtd = r3(String($('#mQtd', c).value).replace(',', '.'));
    if (descricao.length < 2) return erro('Indique a descrição do material.');
    if (!(qtd > 0)) return erro('Indique a quantidade.');
    if (artigo && qtd > disponivel(artigo) + 0.0005) return erro(`Só há ${fmtQtd(disponivel(artigo))} ${artigo.unidade || ''} disponíveis.`);
    let series = [];
    if (artigo && artigo.comSerie) {
      if (!Number.isInteger(qtd)) return erro('Equipamentos com n.º de série: a quantidade tem de ser em unidades.');
      series = $$('input[data-serie]', c).map((i) => limparSerie(i.value));
      if (series.length !== qtd || series.some((x) => x.length < 3)) return erro('Indique o n.º de série de cada unidade.');
      if (new Set(series.map(idSerie)).size !== series.length) return erro('Há números de série repetidos.');
    }
    const m = { id: novoIdItem(), descricao, ref: $('#mRef', c).value.trim(), qtd, unidade: $('#mUn', c).value, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() };
    if (artigo) m.artigoId = artigo.id;
    if (series.length) m.series = series;
    comBotao($('#mGuardar', c), async () => {
      if (await alterarTrabalho((d, g, sers) => {
        if ((d.materiais || []).length >= 300) { erro('Limite de linhas atingido.'); return null; }
        const seriesSet = {};
        for (const sr of series) { verificarSerieLivre(sr, sers[idSerie(sr)]); seriesSet[idSerie(sr)] = { serie: sr, artigoId: artigo.id, ref: artigo.ref, estado: 'folha', folhaId: atual.id, folhaNumero: d.numero, guiaId: '', guiaNumero: '' }; }
        const alt = { materiais: [...(d.materiais || []), m] };
        return artigo ? { alt, mov: { [artigo.id]: { resFolhas: qtd } }, exige: new Set([artigo.id]), seriesSet } : alt;
      }, 'Material registado.', { series })) fecharModal();
    });
  };
}

// ---------- Importar da guia de transporte: só o que foi gasto passa para a folha ----------
function seriesPorUsar(l) { return (l.series || []).filter((x) => !(l.seriesUsadas || []).includes(x)); }
async function importarDaGuia() {
  const f = atual;
  const c0 = [where('clienteId', '==', f.clienteId), where('estado', '==', 'Comunicada')];
  if (tecnico) c0.unshift(where('tecnicoUid', '==', sessao.uid));
  let guias;
  try {
    const snap = await getDocs(query(collection(db, 'guias'), ...c0, limit(10)));
    guias = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((g) => (g.linhas || []).some((l) => saldoLinha(l) > 0.0005));
  } catch (e) { toast(erroFirebase(e), 'erro'); return; }
  if (!guias.length) { toast('Não há guias comunicadas à AT com material por gastar para este cliente.', 'erro', 6000); return; }
  const c = abrirModal('Importar da guia', `
    <p class="muted" style="margin-top:0">Indique só o que foi gasto nesta obra. O resto fica na guia.</p>
    ${guias.map((g) => `<div class="guia-imp">
      <h3 style="margin:8px 0 4px">${esc(g.numero || 'Guia')} · ${esc(g.viatura || '')} · ${esc(fmtData(g.dataSaida))}</h3>
      ${(g.linhas || []).filter((l) => saldoLinha(l) > 0.0005).map((l) => (l.series || []).length ? `
        <div class="linha-imp" style="grid-template-columns:1fr"><span><b>${esc(l.ref)}</b> ${esc(l.design)}<br><span class="muted">marque os n.º de série aplicados</span></span>
          ${seriesPorUsar(l).map((sr) => `<label class="tarefa"><input type="checkbox" data-g="${esc(g.id)}" data-l="${esc(l.id)}" data-s="${esc(sr)}"><span class="serie-tag">${esc(sr)}</span></label>`).join('')}</div>` : `
        <label class="linha-imp"><span><b>${esc(l.ref)}</b> ${esc(l.design)}<br><span class="muted">levou ${esc(fmtQtd(l.qtd))} · por gastar ${esc(fmtQtd(saldoLinha(l)))} ${esc(l.unidade || '')}</span></span>
          <input type="number" inputmode="decimal" min="0" step="any" max="${saldoLinha(l)}" data-g="${esc(g.id)}" data-l="${esc(l.id)}" placeholder="0"></label>`).join('')}
    </div>`).join('')}
    <div class="msg-erro" id="iErro"></div>
    <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="iOk">Importar</button></div>`);
  $('#iOk', c).onclick = () => {
    const erro = (m) => { $('#iErro', c).textContent = m; };
    const pedidos = $$('input[type=number][data-g]', c).map((i) => ({ g: i.dataset.g, l: i.dataset.l, q: r3(String(i.value).replace(',', '.')), s: [] })).filter((x) => x.q > 0);
    for (const cb of $$('input[type=checkbox][data-g]:checked', c)) {
      let p = pedidos.find((x) => x.g === cb.dataset.g && x.l === cb.dataset.l);
      if (!p) pedidos.push(p = { g: cb.dataset.g, l: cb.dataset.l, q: 0, s: [] });
      p.s.push(cb.dataset.s); p.q = p.s.length;
    }
    if (!pedidos.length) return erro('Indique a quantidade gasta em pelo menos uma linha.');
    const porGuia = [...new Set(pedidos.map((p) => p.g))];
    comBotao($('#iOk', c), async () => {
      let ok = true;
      for (const gid of porGuia) {   // uma transação por guia
        const seriesDaGuia = pedidos.filter((p) => p.g === gid).flatMap((p) => p.s);
        ok = ok && await alterarTrabalho((d, guia, sers) => {
          if (!guia || guia.estado !== 'Comunicada') throw Object.assign(new Error('A guia já não está aberta.'), { code: 'guia' });
          const novos = [], mov = {}, seriesSet = {};
          const linhas = guia.linhas.map((l) => {
            const p = pedidos.find((x) => x.g === gid && x.l === l.id);
            if (!p) return l;
            if (p.q > saldoLinha(l) + 0.0005) throw Object.assign(new Error(`${l.ref}: só há ${fmtQtd(saldoLinha(l))} ${l.unidade || ''} por gastar na guia.`), { code: 'guia' });
            for (const sr of p.s) {
              if (!seriesPorUsar(l).includes(sr)) throw erroSerie(`O n.º de série ${sr} já não está disponível na guia.`);
              verificarSerieLivre(sr, sers[idSerie(sr)], guia.id);
              seriesSet[idSerie(sr)] = { serie: sr, artigoId: l.artigoId, ref: l.ref, estado: 'folha', folhaId: atual.id, folhaNumero: d.numero, guiaId: guia.id, guiaNumero: guia.numero || '' };
            }
            const m = { id: novoIdItem(), descricao: l.design, ref: l.ref, qtd: p.q, unidade: l.unidade || '', artigoId: l.artigoId,
              guiaId: guia.id, guiaNumero: guia.numero || '', guiaLinha: l.id, uid: sessao.uid, nome: sessao.nome || sessao.email, em: Timestamp.now() };
            if (p.s.length) m.series = p.s;
            novos.push(m);
            const mv = (mov[l.artigoId] = mov[l.artigoId] || { resFolhas: 0, resGuias: 0 });
            mv.resFolhas += p.q; mv.resGuias -= p.q;   // passa de «na guia» para «na folha»: o disponível não muda
            return { ...l, consumido: r3((l.consumido || 0) + p.q), seriesUsadas: [...(l.seriesUsadas || []), ...p.s],
              consumos: [...(l.consumos || []), { folhaId: atual.id, numero: d.numero, materialId: m.id, qtd: p.q }] };
          });
          return { alt: { materiais: [...(d.materiais || []), ...novos] }, mov, guiaAlt: { linhas }, seriesSet };
        }, null, { guiaId: gid, series: seriesDaGuia });
      }
      if (ok) { fecharModal(); toast('Material importado da guia.', 'ok'); }
    });
  };
}
function saldoLinha(l) { return r3((l.qtd || 0) - (l.consumido || 0) - (l.devolvido || 0)); }

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
      <label class="campo"><span>Email do cliente (recebe o relatório) *</span><input id="cEmail" type="email" inputmode="email" autocomplete="off" value="${esc(emailDoCliente(f))}" placeholder="email@cliente.pt"></label>
      <p class="muted" style="margin:-6px 0 10px">O relatório é sempre enviado, com cópia para a Arpuro.</p>
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
      const enviarPara = $('#cEmail', c).value.trim();
      if (!emailValido(enviarPara)) return erro('Indique o email do cliente: o relatório é sempre enviado.');
      const assinatura = { ausente, nome: ausente ? '' : nome, imagem: ausente ? '' : reduzirAssinatura(cv), em: Timestamp.now(), uid: sessao.uid, registadoPor: sessao.nome || sessao.email };
      fecharModal();
      resolve({ relatorio, assinatura, enviarRelatorioPara: enviarPara });
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
// Tipo da folha → tipos da tabela, por ordem de preferência (Instalação sem linha própria usa a de Assistência Técnica).
function tiposPreco(tipo) {
  if (tipo === 'Manutenção') return ['Manutenção'];
  if (tipo === 'Instalação') return ['Instalação', 'AT/Instalação', 'Assistência Técnica'];
  return ['Assistência Técnica', 'AT/Instalação'];
}
function valorTempo(t, tipoFolha, tabela) {
  const mesmaEquipa = (l) => l.tecnicos === (t.tecnicos || 1) && (l.ajudantes || 0) === (t.ajudantes || 0) && (l.aprendizes || 0) === (t.aprendizes || 0);
  let linha = null;
  for (const tp of tiposPreco(tipoFolha)) { linha = (tabela.linhas || []).find((l) => l.tipo === tp && mesmaEquipa(l)); if (linha) break; }
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

// ---------- Rentabilidade da obra (só Master): venda e custo da mão de obra e do material ----------
// Mão de obra: venda pela tabela de preço/hora; custo = horas × custo/hora de cada pessoa (config/custos).
// Material: venda pelo PVP do PHC e custo pelo preço de custo (artigos/{id}/privado/custo). Deslocação: a acrescentar.
let custosCache = null;
async function mostrarRentabilidade() {
  const eur = (v) => (Number(v) || 0).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
  const box = $('#cartaoRent');
  try {
    if (!tabelaPrecosCache) { const s = await getDoc(doc(db, 'config', 'precosHora')); tabelaPrecosCache = s.exists() ? s.data() : { linhas: [] }; }
    if (!custosCache) { const s = await getDoc(doc(db, 'config', 'custos')); custosCache = s.exists() ? s.data() : { hora: {} }; }
    const avisos = [];
    // mão de obra
    let vMO = 0, cMO = 0;
    for (const t of atual.tempos || []) {
      const r = valorTempo(t, atual.tipo, tabelaPrecosCache);
      if (r) vMO += r.valor; else avisos.push(`tempo de ${fmtData(t.data)} sem preço na tabela`);
      const h = Number(t.horas) || 0;
      if ((t.equipa || []).length) {
        for (const p of t.equipa) {
          const ch = (custosCache.hora || {})[p.id];
          if (ch == null) avisos.push(`${p.nome} sem custo/hora`); else cMO += h * ch;
        }
      } else avisos.push(`tempo de ${fmtData(t.data)} sem equipa identificada`);
    }
    // material
    let vMat = 0, cMat = 0;
    const ids = [...new Set((atual.materiais || []).filter((m) => m.artigoId).map((m) => m.artigoId))];
    const priv = {};
    await Promise.all(ids.map(async (id) => { try { const s = await getDoc(doc(db, 'artigos', id, 'privado', 'custo')); priv[id] = s.exists() ? s.data() : {}; } catch (e) { priv[id] = {}; } }));
    for (const m of atual.materiais || []) {
      const q = Number(m.qtd) || 0;
      const p = m.artigoId ? priv[m.artigoId] || {} : {};
      if (p.custo != null) cMat += q * p.custo; else avisos.push(`${m.ref || m.descricao}: sem preço de custo`);
      if (p.pvp) vMat += q * p.pvp; else avisos.push(`${m.ref || m.descricao}: sem PVP`);
    }
    const venda = vMO + vMat, custo = cMO + cMat, margem = venda - custo, pct = venda ? (margem / venda) * 100 : 0;
    const lin = (n, v, c) => `<tr><td>${n}</td><td class="num">${esc(eur(v))}</td><td class="num">${esc(eur(c))}</td><td class="num">${esc(eur(v - c))}</td></tr>`;
    box.innerHTML = `<h3 style="margin-top:0">Rentabilidade <span class="muted" style="font-weight:400">· só o Master vê</span></h3>
      <table class="tab-rent"><tr><th></th><th class="num">Venda</th><th class="num">Custo</th><th class="num">Margem</th></tr>
        ${lin('Mão de obra', vMO, cMO)}${lin('Material', vMat, cMat)}
        <tr class="tot"><td>Total</td><td class="num">${esc(eur(venda))}</td><td class="num">${esc(eur(custo))}</td><td class="num" id="rentMargem">${esc(eur(margem))} <span class="${margem < 0 ? 'txt-erro' : ''}">(${esc(pct.toFixed(0))}%)</span></td></tr></table>
      <p class="muted" style="margin:6px 0 0;font-size:.82rem">Valores s/IVA. Deslocação ainda não incluída.${avisos.length ? ' Incompleto: ' + esc([...new Set(avisos)].slice(0, 6).join('; ')) + '.' : ''}</p>`;
  } catch (e) { box.innerHTML = `<p class="msg-erro">${esc(erroFirebase(e))}</p>`; }
}

// ---------- Relatório para o cliente (email pela PontePHC e versão para imprimir/PDF) ----------

// HTML do relatório (estilos em linha, para o Outlook). assinaturaSrc: 'cid:assinatura' no email, data URL ao imprimir.
function relatorioHtml(f, assinaturaSrc) {
  const e = esc;
  const linha = (rot, val) => val ? `<tr><td style="${'"+F+"'}padding:4px 8px 4px 0;color:#64748b;vertical-align:top;white-space:nowrap">${e(rot)}</td><td style="${'"+F+"'}padding:4px 0">${val}</td></tr>` : '';
  const concl = (f.historico || []).filter((h) => h.estado === 'Concluída').pop();
  const tarefas = tarefasPadrao(f).filter((t) => (f.tarefas || {})[t]);
  const tempos = f.tempos || [];
  const mats = f.materiais || [];
  const ass = f.assinatura;
  const th = 'style="font-family:Arial,Helvetica,sans-serif;text-align:left;padding:6px 4px;border-bottom:1px solid #cbd5e1;font-size:13px;color:#475569"';
  const td = 'style="font-family:Arial,Helvetica,sans-serif;padding:6px 4px;border-bottom:1px solid #e2e8f0;font-size:14px;vertical-align:top"';
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:680px;margin:0 auto">
  ${cabecalhoEmail('Relatório de intervenção · ' + f.numero)}
  <div style="padding:16px 18px">
  <p style="margin:0 0 12px;padding:8px 10px;background:#fef9c3;border-radius:6px;font-size:13px;color:#713f12"><b>Documento informativo, para conferência.</b>
    Os tempos e os materiais aqui indicados são provisórios e podem ser ajustados na conferência final, antes da faturação. Este documento não substitui a fatura.</p>
  <table style="font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;font-size:14px;margin-bottom:12px">
    ${linha('Cliente', e(f.clienteNome) + (f.clienteNif ? ` · NIF ${e(f.clienteNif)}` : ''))}
    ${linha('Local', e([f.morada, [f.codigoPostal, f.localidade].filter(Boolean).join(' ')].filter(Boolean).join(', ')))}
    ${linha('Tipo', e(TIPO_NOME[f.tipo] || f.tipo))}
    ${linha('Técnico', e(f.tecnicoNome || ''))}
    ${linha('Concluída', concl ? e(fmtDataHora(concl.em)) : e(fmtDataHora(new Date())))}
    ${f.encomendaCliente ? linha('V/ Encomenda', e(f.encomendaCliente)) : ''}
  </table>
  ${f.descricao ? `<h3 style="font-size:15px;margin:14px 0 4px">Trabalho solicitado</h3><p style="margin:0;white-space:pre-wrap;font-size:14px">${e(f.descricao)}</p>` : ''}
  <h3 style="font-size:15px;margin:14px 0 4px">Trabalho realizado</h3><p style="margin:0;white-space:pre-wrap;font-size:14px">${e(f.relatorio || '—')}</p>
  ${tarefas.length ? `<h3 style="font-size:15px;margin:14px 0 4px">Verificações</h3><p style="margin:0;font-size:14px">${tarefas.map((t) => '✔ ' + e(t)).join('<br>')}</p>` : ''}
  ${tempos.length ? `<h3 style="font-size:15px;margin:14px 0 4px">Tempos</h3><table style="font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;width:100%"><tr><th ${th}>Dia</th><th ${th}>Horário</th><th ${th}>Equipa</th><th ${th}>Horas</th></tr>
    ${tempos.map((t) => `<tr><td ${td}>${e(fmtData(t.data))}</td><td ${td}>${t.inicio ? e(t.inicio + '–' + t.fim) : ''}</td><td ${td}>${e(equipaTexto(t))}</td><td ${td}>${e(fmtHoras(t.horas))}</td></tr>`).join('')}</table>` : ''}
  ${mats.length ? `<h3 style="font-size:15px;margin:14px 0 4px">Material aplicado</h3><table style="font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;width:100%"><tr><th ${th}>Qtd.</th><th ${th}>Descrição</th><th ${th}>Ref.</th></tr>
    ${mats.map((m) => `<tr><td ${td}>${e(fmtQtd(m.qtd))} ${e(m.unidade || '')}</td><td ${td}>${e(m.descricao)}${(m.series || []).length ? `<br><span style="font-size:12px;color:#475569">N.º série: ${m.series.map(e).join(', ')}</span>` : ''}</td><td ${td}>${e(m.ref || '')}</td></tr>`).join('')}</table>` : ''}
  <h3 style="font-size:15px;margin:14px 0 4px">Cliente</h3>
  ${ass && !ass.ausente ? `<img src="${e(assinaturaSrc || ass.imagem || '')}" alt="Assinatura" width="300" height="120" style="border:1px solid #e2e8f0;border-radius:6px"><p style="margin:4px 0 0;font-size:14px">${e(ass.nome || '')} · ${e(fmtDataHora(ass.em))}</p>`
    : `<p style="margin:0;font-size:14px">${ass && ass.ausente ? 'Cliente ausente no fim da intervenção (sem assinatura).' : '—'}</p>`}
  <p style="margin:18px 0 0;font-size:12px;color:#64748b">ARPURO &amp; REDEMÓVEL, LDA · NIF 503198749 · São João da Madeira<br>Para qualquer questão, responda a este email.</p>
  </div></div>`;
}
function relatorioTexto(f) {
  const l = [`Arpuro Climatização — Relatório de intervenção ${f.numero}`, '', `Cliente: ${f.clienteNome}`, `Técnico: ${f.tecnicoNome || ''}`, ''];
  if (f.descricao) l.push('Trabalho solicitado:', f.descricao, '');
  l.push('Trabalho realizado:', f.relatorio || '—', '');
  for (const t of f.tempos || []) l.push(`Tempo: ${fmtData(t.data)} ${t.inicio || ''}–${t.fim || ''} · ${equipaTexto(t)} · ${fmtHoras(t.horas)}`);
  for (const m of f.materiais || []) l.push(`Material: ${fmtQtd(m.qtd)} ${m.unidade || ''} ${m.descricao}${m.ref ? ' (' + m.ref + ')' : ''}${(m.series || []).length ? ' — n.º série ' + m.series.join(', ') : ''}`);
  l.push('', 'Documento informativo, para conferência: tempos e materiais provisórios, podem ser ajustados antes da faturação.');
  l.push('', 'ARPURO & REDEMÓVEL, LDA · NIF 503198749');
  return l.join('\n');
}
// Documento do email (a PontePHC envia pelo Exchange, de noreply@arpuro.pt, e marca a folha como enviada).
function dadosEmailRelatorio(f, para) {
  return {
    tipo: 'relatorio', estado: 'Pendente', para: para.trim(), folhaId: f.id, folhaNumero: f.numero,
    assunto: `Relatório de intervenção ${f.numero} — Arpuro Climatização`,
    html: relatorioHtml(f, 'cid:assinatura'), texto: relatorioTexto(f),
    assinaturaPng: f.assinatura && !f.assinatura.ausente ? (f.assinatura.imagem || '') : '',
    criadoPor: sessao.uid, criadoPorNome: sessao.nome || sessao.email, criadoEm: serverTimestamp(),
  };
}

function htmlRelatorioCliente(f) {
  if (!['Concluída', 'Revista', 'Aguarda NE', 'Faturada'].includes(f.estado)) return '';
  const env = f.relatorioEnviado, ped = f.relatorioCliente;
  const estado = env ? (env.estado === 'Enviado' ? `Enviado para ${esc(env.para)} em ${esc(fmtDataHora(env.em))}` : `<span style="color:#b91c1c">Não foi enviado (${esc(env.erro || 'erro')})</span>`)
    : ped ? `A enviar para ${esc(ped.para)}…` : 'Ainda não foi enviado.';
  return `<div class="cartao" id="cartaoRelCliente">
    <h3 style="margin-top:0">Relatório para o cliente</h3>
    <p class="muted" style="margin:0 0 10px" id="estadoRelatorio">${estado}</p>
    <div class="acoes-mat"><button class="btn btn-peq" id="btnVerRelatorio">Ver / imprimir</button>
      ${staff ? '<button class="btn btn-peq btn-primario" id="btnEnviarRelatorio">Enviar por email</button>' : ''}</div>
  </div>`;
}
function ligarRelatorioCliente() {
  if ($('#btnVerRelatorio')) $('#btnVerRelatorio').onclick = () => mostrarRelatorio(atual);
  if ($('#btnEnviarRelatorio')) $('#btnEnviarRelatorio').onclick = async () => {
    const c = abrirModal('Enviar relatório ao cliente', `
      <label class="campo"><span>Email do cliente *</span><input id="eRel" type="email" inputmode="email" value="${esc(emailDoCliente(atual))}" autocomplete="off"></label>
      <p class="muted" style="margin-top:0">Enviado de noreply@arpuro.pt; as respostas vão para rbastos@arpuro.pt.</p>
      <div class="msg-erro" id="eErro"></div>
      <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="eOk">Enviar</button></div>`);
    if (!emailDoCliente(atual) && atual.clienteId) {
      try { const s = await getDoc(doc(db, 'clientes', atual.clienteId)); if (s.exists() && s.data().email && !$('#eRel', c).value) $('#eRel', c).value = s.data().email; } catch (e) { /* sem acesso */ }
    }
    $('#eOk', c).onclick = () => {
      const para = $('#eRel', c).value.trim();
      if (!emailValido(para)) { $('#eErro', c).textContent = 'Email inválido.'; return; }
      comBotao($('#eOk', c), async () => {
        try {
          await setDoc(doc(collection(db, 'emails')), dadosEmailRelatorio(atual, para));
          fecharModal();
          toast('Relatório em fila de envio (a PontePHC envia em poucos minutos).', 'ok', 6000);
          $('#estadoRelatorio').textContent = `A enviar para ${para}…`;
        } catch (e) { $('#eErro', c).textContent = erroFirebase(e); }
      });
    };
  };
}


// Vista do relatório em ecrã inteiro (lê-se bem no telemóvel); «Imprimir / PDF» imprime só o relatório.
function mostrarRelatorio(f) {
  fecharRelatorio();
  const v = document.createElement('div');
  v.id = 'vRelatorio';
  v.innerHTML = `<div class="rel-barra"><button class="btn" id="relFechar">‹ Voltar</button><button class="btn btn-primario" id="relImprimir" style="margin-left:auto">Imprimir / PDF</button></div>
    <div class="rel-corpo">${relatorioHtml(f)}</div>`;
  document.body.appendChild(v);
  document.body.style.overflow = 'hidden';
  $('#relFechar').onclick = fecharRelatorio;
  $('#relImprimir').onclick = () => {
    document.body.classList.add('a-imprimir');
    window.print();
    setTimeout(() => document.body.classList.remove('a-imprimir'), 500);
  };
}
function fecharRelatorio() {
  const v = $('#vRelatorio');
  if (v) v.remove();
  document.body.style.overflow = '';
}

// ---------- Aviso de agendamento ao cliente (ao agendar e ao reagendar) ----------
// Devolve o email (enviar), '' (não enviar) ou null (cancelar a ação).
