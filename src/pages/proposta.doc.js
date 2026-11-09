// Documento da proposta (orçamento) tal como o cliente o vê. Partilhado pela página pública «proposta» e por «orcamentos».
// Sem custos nem margens: só o que vai para o cliente.
function totalLinha(l) { return Math.round((Number(l.qtd) || 0) * (Number(l.preco) || 0) * (1 - (Number(l.desconto) || 0) / 100) * 100) / 100; }
function totaisProposta(linhas, ivaTaxa) {
  const base = Math.round((linhas || []).reduce((s, l) => s + totalLinha(l), 0) * 100) / 100;
  const iva = Math.round(base * (Number(ivaTaxa) || 0)) / 100;
  return { base, iva, total: Math.round((base + iva) * 100) / 100 };
}
const eurP = (v) => (Number(v) || 0).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
const qtdP = (v) => (Number(v) || 0).toLocaleString('pt-PT', { maximumFractionDigits: 3 });

function htmlProposta(p) {
  const e = esc;
  const t = totaisProposta(p.linhas, p.ivaTaxa);
  const temDesc = (p.linhas || []).some((l) => Number(l.desconto));
  const th = 'style="text-align:left;padding:6px 4px;border-bottom:2px solid #008689;font-size:12px;color:#475569;font-weight:600"';
  const td = 'style="padding:6px 4px;border-bottom:1px solid #e2e8f0;font-size:13px;vertical-align:top"';
  const tdn = 'style="padding:6px 4px;border-bottom:1px solid #e2e8f0;font-size:13px;vertical-align:top;text-align:right;white-space:nowrap"';
  return `<div class="doc-proposta" style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:760px;margin:0 auto;background:#fff">
    ${cabecalhoEmail('Proposta ' + p.numero)}
    <div style="padding:16px 18px">
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px"><tr>
        <td style="vertical-align:top;padding:0 8px 0 0"><div style="color:#64748b;font-size:12px">Cliente</div><b>${e(p.clienteNome)}</b>${p.clienteNif ? `<br>NIF ${e(p.clienteNif)}` : ''}
          ${p.morada ? `<br>${e(p.morada)}` : ''}${p.localidade ? `<br>${e([p.codigoPostal, p.localidade].filter(Boolean).join(' '))}` : ''}</td>
        <td style="vertical-align:top;text-align:right;white-space:nowrap"><div style="color:#64748b;font-size:12px">Data</div>${e(p.data ? fmtData(p.data) : fmtData(new Date()))}
          <div style="color:#64748b;font-size:12px;margin-top:6px">Válida até</div>${e(p.validade ? fmtData(p.validade) : '—')}</td></tr></table>
      ${p.assunto ? `<p style="margin:0 0 12px;font-size:15px"><b>${e(p.assunto)}</b></p>` : ''}
      ${p.introducao ? `<p style="margin:0 0 12px;font-size:13px;white-space:pre-wrap">${e(p.introducao)}</p>` : ''}
      <table style="width:100%;border-collapse:collapse">
        <tr><th ${th}>Descrição</th><th ${th} style="text-align:right">Qtd.</th><th ${th} style="text-align:right">Preço</th>${temDesc ? `<th ${th} style="text-align:right">Desc.</th>` : ''}<th ${th} style="text-align:right">Total</th></tr>
        ${(p.linhas || []).map((l) => `<tr><td ${td}>${e(l.descricao)}${l.ref ? `<br><span style="font-size:11px;color:#64748b">${e(l.ref)}</span>` : ''}</td>
          <td ${tdn}>${e(qtdP(l.qtd))} ${e(l.unidade || '')}</td><td ${tdn}>${e(eurP(l.preco))}</td>${temDesc ? `<td ${tdn}>${Number(l.desconto) ? e(qtdP(l.desconto)) + '%' : ''}</td>` : ''}<td ${tdn}>${e(eurP(totalLinha(l)))}</td></tr>`).join('')}
      </table>
      <table style="margin:10px 0 0 auto;border-collapse:collapse;font-size:13px">
        <tr><td style="padding:3px 12px 3px 0;color:#475569">Total sem IVA</td><td style="text-align:right">${e(eurP(t.base))}</td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#475569">IVA ${e(qtdP(p.ivaTaxa))}%</td><td style="text-align:right">${e(eurP(t.iva))}</td></tr>
        <tr><td style="padding:6px 12px 3px 0;font-size:15px"><b>Total</b></td><td style="text-align:right;font-size:15px;padding-top:6px"><b>${e(eurP(t.total))}</b></td></tr>
      </table>
      ${p.condicoes ? `<div style="margin-top:16px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:12px;color:#334155"><b>Condições</b><div style="white-space:pre-wrap;margin-top:4px">${e(p.condicoes)}</div></div>` : ''}
      <p style="margin:18px 0 0;font-size:11px;color:#64748b">ARPURO &amp; REDEMÓVEL, LDA · NIF 503198749 · São João da Madeira</p>
    </div></div>`;
}
