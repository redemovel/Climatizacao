// Aviso de agendamento/reagendamento ao cliente (email pela PontePHC). Partilhado pelas páginas Folhas e Agenda.
function emailValido(e) { return /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(String(e || '').trim()); }
function emailDoCliente(f) { return (f.emailContacto || f.clienteEmail || '').trim(); }
function pedirAvisoAgendamento(f, reagendar = false) {
  return new Promise((resolve) => {
    const em = emailDoCliente(f);
    const c = abrirModal(reagendar ? 'Reagendar' : 'Agendar', `
      <p style="margin-top:0">${esc(TIPO_NOME[f.tipo] || f.tipo)} · ${f.dataPrevista ? `<b>${esc(fmtDiaSemana(paraData(f.dataPrevista)))}, ${esc(fmtHora(f.dataPrevista))}</b>` : ''} · ${esc(f.tecnicoNome || '')}</p>
      <label class="campo"><span>Enviar aviso ao cliente para</span><input id="aEmail" type="email" inputmode="email" autocomplete="off" value="${esc(em)}" placeholder="email@cliente.pt"></label>
      <label class="campo" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="aSem" style="width:auto;min-height:0"><span style="margin:0">Não enviar aviso desta vez</span></label>
      <div class="msg-erro" id="aErro"></div>
      <div class="acoes"><button class="btn" data-fechar>Cancelar</button><button class="btn btn-primario" id="aOk">${reagendar ? 'Reagendar' : 'Agendar'}</button></div>`,
    { aoFechar: () => resolve(null) });
    $('#aOk', c).onclick = () => {
      if ($('#aSem', c).checked) { fecharModal(); resolve(''); return; }
      const para = $('#aEmail', c).value.trim();
      if (!emailValido(para)) { $('#aErro', c).textContent = 'Indique o email do cliente, ou marque «Não enviar aviso desta vez».'; return; }
      fecharModal();
      resolve(para);
    };
  });
}
function avisoAgendamentoHtml(f, reagendar) {
  const e = esc;
  const quando = f.dataPrevista ? `${fmtDiaSemana(paraData(f.dataPrevista))}, às ${fmtHora(f.dataPrevista)}` : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:680px;margin:0 auto">
  ${cabecalhoEmail((reagendar ? 'Intervenção reagendada' : 'Intervenção agendada') + ' · ' + f.numero)}
  <div style="padding:16px 18px;font-size:14px">
  <p style="margin:0 0 12px">Informamos que a intervenção ${reagendar ? 'foi reagendada' : 'está agendada'} para <b>${e(quando)}</b> (hora prevista de chegada).</p>
  <table style="font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;font-size:14px">
    <tr><td style="font-family:Arial,Helvetica,sans-serif;padding:3px 8px 3px 0;color:#64748b">Cliente</td><td>${e(f.clienteNome)}</td></tr>
    <tr><td style="font-family:Arial,Helvetica,sans-serif;padding:3px 8px 3px 0;color:#64748b">Local</td><td>${e([f.morada, [f.codigoPostal, f.localidade].filter(Boolean).join(' ')].filter(Boolean).join(', '))}</td></tr>
    <tr><td style="font-family:Arial,Helvetica,sans-serif;padding:3px 8px 3px 0;color:#64748b">Tipo</td><td>${e(TIPO_NOME[f.tipo] || f.tipo)}</td></tr>
    <tr><td style="font-family:Arial,Helvetica,sans-serif;padding:3px 8px 3px 0;color:#64748b">Técnico</td><td>${e(f.tecnicoNome || '')}</td></tr>
    ${f.descricao ? `<tr><td style="font-family:Arial,Helvetica,sans-serif;padding:3px 8px 3px 0;color:#64748b;vertical-align:top">Trabalho</td><td style="white-space:pre-wrap">${e(f.descricao)}</td></tr>` : ''}
  </table>
  <p style="margin:14px 0 0">Se esta data não for conveniente, responda a este email para combinarmos outra.</p>
  <p style="margin:18px 0 0;font-size:12px;color:#64748b">ARPURO &amp; REDEMÓVEL, LDA · NIF 503198749 · São João da Madeira</p>
  </div></div>`;
}
function dadosEmailAgendamento(f, para, reagendar = false) {
  const quando = f.dataPrevista ? `${fmtDiaSemana(paraData(f.dataPrevista))}, às ${fmtHora(f.dataPrevista)}` : '';
  return {
    tipo: 'agendamento', estado: 'Pendente', para: para.trim(), folhaId: f.id, folhaNumero: f.numero,
    assunto: `${reagendar ? 'Intervenção reagendada' : 'Intervenção agendada'} ${f.numero} — ${quando} — Arpuro Climatização`,
    html: avisoAgendamentoHtml(f, reagendar),
    texto: `Arpuro Climatização — ${reagendar ? 'intervenção reagendada' : 'intervenção agendada'} ${f.numero}\n\nData prevista: ${quando}\nCliente: ${f.clienteNome}\nTécnico: ${f.tecnicoNome || ''}\n${f.descricao ? 'Trabalho: ' + f.descricao + '\n' : ''}\nSe esta data não for conveniente, responda a este email.`,
    assinaturaPng: '', criadoPor: sessao.uid, criadoPorNome: sessao.nome || sessao.email, criadoEm: serverTimestamp(),
  };
}
