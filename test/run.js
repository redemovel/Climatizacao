#!/usr/bin/env node
// Testes automáticos: node test/run.js  (ou npm test)
//   1) gera as páginas (build.js)
//   2) verifica a sintaxe do JavaScript de cada página
//   3) abre as páginas no Chromium (Playwright) com o Firebase simulado e dados de exemplo,
//      com cada perfil, em telemóvel (375px e 414px) e desktop
//   4) (opcional) confirma que o SDK real do Firebase exporta tudo o que o código importa
// Opções: --so=texto (corre só os testes cujo nome contém o texto), --capturas (grava PNG em test/capturas)
process.env.TZ = 'Europe/Lisbon';
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const seed = require('./seed');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const SO = (args.find((a) => a.startsWith('--so=')) || '').slice(5);
const CAPTURAS = args.includes('--capturas');
const DIR_CAP = path.join(__dirname, 'capturas');
const INDICES = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8')).indexes;
const PAGINAS = ['index', 'agenda', 'folhas', 'clientes', 'utilizadores'];

// ---------- 1 e 2: build + sintaxe ----------
execFileSync('node', [path.join(ROOT, 'build.js')], { stdio: 'inherit' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clim-'));
for (const p of PAGINAS) for (const suf of ['', '-dev']) {
  const html = fs.readFileSync(path.join(ROOT, p + suf + '.html'), 'utf8');
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Sem <script type="module"> em ' + p + suf);
  const f = path.join(tmp, p + suf + '.mjs');
  fs.writeFileSync(f, m[1]);
  execFileSync('node', ['--check', f]);
  if (/@@[A-Z]+@@|\{\{[A-Z]+\}\}/.test(html)) throw new Error('Marcador por substituir em ' + p + suf);
}
console.log('✔ sintaxe OK (' + PAGINAS.length * 2 + ' páginas)');

// ---------- servidor estático ----------
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const servidor = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

// ---------- mini framework ----------
const resultados = [];
const testes = [];
const teste = (nome, fn) => testes.push({ nome, fn });
function assert(c, msg) { if (!c) throw new Error('Falhou: ' + msg); }
function igual(a, b, msg) { if (a !== b) throw new Error(`Falhou: ${msg} (esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)})`); }

let BASE;
let browser;
const MOVEIS = [{ width: 375, height: 740 }, { width: 414, height: 860 }];
const DESKTOP = { width: 1280, height: 860 };

async function contexto({ viewport = MOVEIS[0], sdkReal = false } = {}) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'Europe/Lisbon', locale: 'pt-PT', hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
  const { db, users } = seed.gerar();
  await ctx.addInitScript(({ db, users, idx }) => {
    window.__fakeIndexes = idx;
    if (!localStorage.getItem('__fake_seeded')) {
      localStorage.setItem('__fake_db', JSON.stringify(db));
      localStorage.setItem('__fake_auth_users', JSON.stringify(users));
      localStorage.setItem('__fake_seeded', '1');
    }
  }, { db, users, idx: INDICES });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
    const url = route.request().url();
    const m = url.match(/^https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/(firebase-[a-z]+\.js)$/);
    if (m) {
      const f = sdkReal ? path.join(ROOT, 'node_modules', 'firebase', m[1]) : path.join(__dirname, 'fake', m[1]);
      return route.fulfill({ path: f, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    return route.abort();
  });
  const page = await ctx.newPage();
  global.__ultimaPagina = page;
  page._erros = [];
  page.on('pageerror', (e) => page._erros.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_FAILED/.test(m.text())) page._erros.push('console: ' + m.text()); });
  page.on('dialog', (d) => { page._erros.push('dialog nativo: ' + d.message()); d.dismiss(); });
  return { ctx, page };
}

async function entrar(page, quem, { dev = false } = {}) {
  const u = seed.USERS[quem];
  await page.goto(`${BASE}/index${dev ? '-dev' : ''}.html`);
  await page.fill('#email', u.email);
  await page.fill('#pass', seed.PASS);
  await page.click('#btnEntrar');
  if (!u.semPerfil && u.ativo !== false) await page.waitForURL(new RegExp(`agenda${dev ? '-dev' : ''}\\.html`));
}
const fake = (page, expr, arg) => page.evaluate(expr, arg);
async function semOverflow(page, rotulo) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert(r.sw <= r.w + 1, `${rotulo}: conteúdo mais largo que o ecrã (${r.sw}px > ${r.w}px)`);
}
async function captura(page, nome) {
  if (!CAPTURAS) return;
  fs.mkdirSync(DIR_CAP, { recursive: true });
  await page.screenshot({ path: path.join(DIR_CAP, nome + '.png'), fullPage: true });
}
const semErros = (page) => assert(!page._erros.length, 'erros na página:\n  ' + page._erros.join('\n  '));
const contar = (page, sel) => page.locator(sel).count();

// =====================================================================
// LOGIN
// =====================================================================
teste('login: palavra-passe errada mostra erro', async () => {
  const { ctx, page } = await contexto();
  await page.goto(BASE + '/index.html');
  await page.fill('#email', 'rbastos@redemovel.pt');
  await page.fill('#pass', 'errada');
  await page.click('#btnEntrar');
  await page.waitForFunction(() => document.querySelector('#erro').textContent.length > 0);
  igual(await page.textContent('#erro'), 'Email ou palavra-passe incorretos.', 'mensagem de erro');
  assert(await page.$eval('.login .logo img', (i) => i.complete && i.naturalWidth > 0), 'logótipo carregado');
  for (const href of await page.$$eval('link[rel~=icon], link[rel=apple-touch-icon], link[rel=manifest]', (l) => l.map((x) => x.href))) {
    const r = await page.request.get(href);
    igual(r.status(), 200, 'ícone/manifest ' + href);
  }
  await semOverflow(page, 'login');
  await captura(page, 'login-375');
  semErros(page); await ctx.close();
});

teste('login: utilizador sem perfil vê o UID para enviar ao administrador', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'semPerfil');
  await page.waitForSelector('#uid');
  igual(await page.textContent('#uid'), 'u-novo', 'UID mostrado');
  // e não consegue abrir páginas internas
  await page.goto(BASE + '/agenda.html');
  await page.waitForURL(/index\.html/);
  semErros(page); await ctx.close();
});

teste('login: utilizador inativo é bloqueado', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'inativo');
  await page.waitForSelector('#uid');
  assert((await page.textContent('#caixa')).includes('desativada'), 'mensagem de conta desativada');
  semErros(page); await ctx.close();
});

teste('sessão: sem login, páginas internas redirecionam para o login', async () => {
  const { ctx, page } = await contexto();
  for (const p of ['agenda', 'folhas', 'clientes', 'utilizadores']) {
    await page.goto(`${BASE}/${p}.html`);
    await page.waitForURL(/index\.html/);
  }
  semErros(page); await ctx.close();
});

// =====================================================================
// MENU POR PERFIL
// =====================================================================
for (const [quem, menus] of [['master', ['agenda', 'folhas', 'clientes', 'utilizadores']], ['backoffice', ['agenda', 'folhas', 'clientes']], ['tecnico1', ['agenda', 'folhas']]]) {
  teste(`menu: ${quem} vê ${menus.join(', ')}`, async () => {
    const { ctx, page } = await contexto();
    await entrar(page, quem);
    await page.waitForSelector('#nav a');
    const ids = await page.$$eval('#nav a', (as) => as.map((a) => a.dataset.menu));
    igual(ids.join(','), menus.join(','), 'itens do menu');
    semErros(page); await ctx.close();
  });
}

teste('acesso: técnico não entra em Clientes nem Utilizadores; backoffice não entra em Utilizadores', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  for (const p of ['clientes', 'utilizadores']) {
    await page.goto(`${BASE}/${p}.html`);
    await page.waitForSelector('text=Não tem acesso a esta página.');
  }
  await page.click('#btnSair');
  await page.waitForURL(/index\.html/);
  await entrar(page, 'backoffice');
  await page.goto(`${BASE}/utilizadores.html`);
  await page.waitForSelector('text=Não tem acesso a esta página.');
  semErros(page); await ctx.close();
});

// =====================================================================
// AGENDA
// =====================================================================
teste('agenda técnico: hoje mostra só os seus 3 trabalhos, ordenados por hora, poucas leituras', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  await page.evaluate(() => localStorage.setItem('agenda.vista', 'dia'));
  await page.waitForSelector('#lista .lista-item');
  await fake(page, () => window.__fake.zerarLeituras());
  await page.reload();
  await page.waitForSelector('#lista .lista-item');
  igual(await contar(page, '#lista .lista-item'), 3, 'n.º de trabalhos hoje');
  const horas = await page.$$eval('#lista .hora', (h) => h.map((x) => x.textContent));
  igual(horas.join(' '), '09:00 11:00 15:00', 'ordem por hora');
  assert(await page.locator('#barraTec').isHidden(), 'técnico não vê seletor de técnicos');
  const leituras = await fake(page, () => window.__fake.leituras());
  assert(leituras <= 6, 'leituras ao abrir a agenda: ' + leituras);
  for (const vp of MOVEIS) { await page.setViewportSize(vp); await semOverflow(page, 'agenda ' + vp.width); await captura(page, 'agenda-tecnico-' + vp.width); }
  semErros(page); await ctx.close();
});

teste('agenda: trabalhos em atraso aparecem no topo quando o período inclui hoje', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  await page.evaluate(() => localStorage.setItem('agenda.vista', 'dia'));
  await page.reload();
  await page.waitForSelector('#atrasos .atrasos');
  igual(await contar(page, '#atrasos .lista-item'), 1, 'um trabalho em atraso do João');
  assert((await page.textContent('#atrasos')).includes('Ginásio FitPorto'), 'é a folha pendente');
  await semOverflow(page, 'agenda com atrasos');
  await captura(page, 'agenda-atrasos-375');
  await page.click('#seg');
  await page.waitForFunction(() => document.querySelector('#atrasos').innerHTML === '');
  await page.click('#hoje');
  await page.waitForSelector('#atrasos .atrasos');
  await page.click('#atrasos .lista-item .li-titulo');
  await page.waitForURL(/folhas\.html\?id=fo027/);
  await page.click('#btnSair');
  await page.waitForURL(/index\.html/);
  await entrar(page, 'tecnico2');
  await page.waitForSelector('#lista .lista-item');
  await page.waitForTimeout(200);
  igual(await contar(page, '#atrasos .lista-item'), 0, 'Pedro sem atrasos');
  semErros(page); await ctx.close();
});

teste('agenda técnico: vista semana e navegação', async () => {
  const { ctx, page } = await contexto({ viewport: MOVEIS[1] });
  await entrar(page, 'tecnico1');
  await page.click('#segVista button[data-v=semana]');
  await page.waitForSelector('.dia-cab');
  const n = await contar(page, '#lista .lista-item');
  const esperado = await fake(page, () => {
    const db = window.__fake.db();
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const seg = new Date(hoje); seg.setDate(seg.getDate() - ((seg.getDay() + 6) % 7));
    const fim = new Date(seg); fim.setDate(fim.getDate() + 7);
    return Object.entries(db).filter(([k, v]) => k.startsWith('folhas/') && v.tecnicoUid === 'u-tec1' && v.dataPrevista.__ts >= seg.getTime() && v.dataPrevista.__ts < fim.getTime()).length;
  });
  igual(n, esperado, 'trabalhos da semana');
  await semOverflow(page, 'agenda semana');
  await captura(page, 'agenda-semana-414');
  await page.click('#seg');
  await page.waitForFunction(() => !document.querySelector('#lista').textContent.includes('A carregar'));
  await page.click('#hoje');
  await page.waitForSelector('.dia-cab.hoje');
  semErros(page); await ctx.close();
});

teste('agenda backoffice: todos os técnicos e filtro por técnico', async () => {
  const { ctx, page } = await contexto({ viewport: DESKTOP });
  await entrar(page, 'backoffice');
  await page.evaluate(() => localStorage.setItem('agenda.vista', 'dia'));
  await page.reload();
  await page.waitForSelector('#lista .lista-item');
  igual(await contar(page, '#lista .lista-item'), 5, 'todos hoje');
  await page.waitForFunction(() => document.querySelectorAll('#selTec option').length > 1);
  await page.selectOption('#selTec', 'u-tec2');
  await page.waitForFunction(() => document.querySelectorAll('#lista .lista-item').length === 2);
  await captura(page, 'agenda-backoffice-desktop');
  semErros(page); await ctx.close();
});

// =====================================================================
// FOLHAS DE OBRA
// =====================================================================
teste('folhas técnico: só vê as suas; muda estados pelo fluxo e fica registado', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  await page.goto(BASE + '/folhas.html');
  await page.waitForSelector('#lista .lista-item');
  igual(await page.textContent('#tituloLista'), 'As minhas folhas', 'título');
  const ids = await page.$$eval('#lista [data-id]', (a) => a.map((x) => x.dataset.id));
  const tecs = await fake(page, (ids) => ids.map((i) => window.__fake.doc('folhas/' + i).tecnicoUid), ids);
  assert(tecs.length > 0 && tecs.every((t) => t === 'u-tec1'), 'todas do técnico');
  assert(await page.locator('#btnNova').isHidden(), 'técnico não cria folhas');
  await semOverflow(page, 'folhas lista');
  await captura(page, 'folhas-tecnico-375');

  // abre a folha fo001 (Agendada) a partir da agenda
  await page.goto(BASE + '/folhas.html?id=fo001');
  await page.waitForSelector('#detNumero');
  const botoes = await page.$$eval('[data-estado]', (b) => b.map((x) => x.dataset.estado));
  igual(botoes.join(','), 'Em curso', 'ações em Agendada');
  assert(!(await page.locator('#selCorrigir').count()), 'técnico não corrige estados');
  assert(!(await page.locator('#btnEditar').count()), 'técnico não edita a folha');
  await semOverflow(page, 'folha detalhe');
  await captura(page, 'folha-detalhe-tecnico-375');
  await page.click('[data-estado="Em curso"]');
  await page.waitForSelector('.badge.estado-em-curso');
  // pendente exige motivo
  await page.click('[data-estado="Pendente"]');
  await page.click('#pOk');
  igual(await page.textContent('#pErro'), 'Escolha o motivo.', 'motivo obrigatório');
  await page.check('input[name=motivo][value="Orçamento"]', { force: true });
  await page.fill('#pNota', 'Compressor avariado, orçamentar.');
  await captura(page, 'folha-pendente-modal-375');
  await page.click('#pOk');
  await page.waitForSelector('#pendencia');
  assert((await page.textContent('#pendencia')).includes('Pendente — Orçamento'), 'mostra motivo');
  await page.click('[data-estado="Em curso"]');
  await page.waitForSelector('.det-cab .estado-em-curso');
  igual(await contar(page, '#pendencia'), 0, 'pendência fechada ao retomar');
  await page.click('[data-estado="Concluída"]');
  await page.click('.modal [data-r="1"]');
  await page.waitForSelector('.det-cab .estado-concluida');
  await page.fill('#obs', 'Filtros limpos. Pressões OK.');
  await page.click('#btnObs');
  await page.waitForSelector('.toast-ok >> text=Observações guardadas.');
  const f = await fake(page, () => window.__fake.doc('folhas/fo001'));
  igual(f.estado, 'Concluída', 'estado final');
  igual(f.historico.length, 5, 'histórico com 5 registos');
  igual(f.historico[2].motivo, 'Orçamento', 'motivo no histórico');
  igual(f.historico[4].uid, 'u-tec1', 'quem mudou');
  assert(f.historico[4].em && f.historico[4].em.seconds > 0, 'timestamp no histórico');
  igual(f.pendencia, null, 'pendência limpa');
  igual(f.observacoesTecnico, 'Filtros limpos. Pressões OK.', 'observações');
  // concluída: técnico já não tem ações (Faturada é só backoffice/master)
  igual(await contar(page, '[data-estado]'), 0, 'sem ações após concluída');
  semErros(page); await ctx.close();
});

teste('folhas técnico: não abre folha de outro técnico', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  await page.goto(BASE + '/folhas.html?id=fo004');
  await page.waitForSelector('text=Sem permissão para esta operação.');
  semErros(page); await ctx.close();
});

teste('folhas: agenda → detalhe → voltar regressa à agenda', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  await page.waitForSelector('#lista .lista-item');
  await page.click('#lista .lista-item .li-titulo');
  await page.waitForSelector('#detNumero');
  await page.click('#btnVoltar');
  await page.waitForURL(/agenda\.html/);
  semErros(page); await ctx.close();
});

teste('folhas backoffice: filtros, paginação e pesquisa por número', async () => {
  const { ctx, page } = await contexto({ viewport: MOVEIS[1] });
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/folhas.html');
  await page.waitForSelector('#lista .lista-item');
  const abertas = await fake(page, () => Object.entries(window.__fake.db()).filter(([k, v]) => k.startsWith('folhas/') && ['Por agendar', 'Agendada', 'Em curso', 'Pendente'].includes(v.estado)).length);
  igual(await contar(page, '#lista .lista-item'), abertas, 'abertas');
  await page.selectOption('#fEstado', '');
  await page.waitForFunction(() => document.querySelectorAll('#lista .lista-item').length === 20);
  assert(await page.locator('#maisWrap').isVisible(), 'botão carregar mais');
  await page.click('#btnMais');
  await page.waitForFunction(() => document.querySelectorAll('#lista .lista-item').length === 28);
  await page.selectOption('#fEstado', 'Concluída');
  await page.waitForFunction(() => [...document.querySelectorAll('#lista .badge')].every((b) => b.textContent === 'Concluída'));
  await page.selectOption('#fTec', 'u-tec2');
  await page.waitForFunction(() => document.querySelectorAll('#lista .lista-item').length > 0);
  await page.fill('#pNum', '3');
  await page.click('#fPesq button');
  await page.waitForFunction(() => document.querySelectorAll('#lista .lista-item').length === 1);
  assert((await page.textContent('#lista')).includes('-0003'), 'encontrou FO-…-0003');
  await semOverflow(page, 'folhas backoffice');
  semErros(page); await ctx.close();
});

teste('folhas backoffice: cria folha (cliente, tipo, técnico, data) com número sequencial', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/folhas.html');
  await page.click('#btnNova');
  await page.waitForSelector('#fFolha');
  // validação: sem cliente
  await page.click('#ffGuardar');
  igual(await page.textContent('#ffErro'), 'Escolha o cliente.', 'valida cliente');
  await page.fill('#cliQ', 'meli');
  await page.click('#cliProcurar');
  await page.waitForSelector('#cliRes [data-i]');
  await page.click('#cliRes [data-i="0"]');
  igual(await page.inputValue('#ffLoc'), 'Aveiro', 'morada preenchida do cliente');
  await page.waitForFunction(() => document.querySelectorAll('#ffTec option').length > 1);
  const opts = await page.$$eval('#ffTec option', (o) => o.map((x) => x.textContent));
  assert(!opts.includes('Rui Antigo'), 'técnico inativo não aparece');
  await page.selectOption('#ffTec', 'u-tec2');
  await page.check('input[name=tipo][value=AT]', { force: true });
  await page.fill('#ffHora', '16:30');
  await page.fill('#ffDesc', 'Fuga de água na unidade interior.');
  await semOverflow(page, 'form nova folha');
  await captura(page, 'folha-nova-375');
  await page.click('#ffGuardar');
  await page.waitForSelector('#detNumero');
  const num = await page.textContent('#detNumero');
  igual(num, `FO-${new Date().getFullYear()}-0029`, 'número sequencial');
  const id = new URL(page.url()).searchParams.get('id');
  const f = await fake(page, (id) => window.__fake.doc('folhas/' + id), id);
  igual(f.estado, 'Agendada', 'estado inicial');
  igual(f.tecnicoNome, 'Pedro Costa', 'técnico');
  igual(f.tipo, 'AT', 'tipo');
  igual(f.clienteId, 'cli001', 'cliente');
  igual(f.historico.length, 1, 'histórico inicial');
  igual(new Date(f.dataPrevista.seconds * 1000).getHours(), 16, 'hora prevista');
  // backoffice não faz revisão nem faturação (só o Master)
  await page.goto(BASE + '/folhas.html?id=fo010');
  await page.waitForSelector('#detNumero');
  igual(await contar(page, '[data-estado]'), 0, 'backoffice sem ações numa concluída');
  const optsC = await page.$$eval('#selCorrigir option', (o) => o.map((x) => x.value).filter(Boolean));
  assert(!optsC.some((o) => ['Revista', 'Aguarda NE', 'Faturada'].includes(o)), 'backoffice não corrige para estados do Master: ' + optsC);
  semErros(page); await ctx.close();
});

teste('folhas master: revê, aguarda NE e fatura com n.º de fatura', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'master');
  await page.goto(BASE + '/folhas.html?id=fo010');
  await page.click('[data-estado="Revista"]');
  await page.waitForSelector('.det-cab .estado-revista');
  await page.click('[data-estado="Aguarda NE"]');
  await page.waitForSelector('.det-cab .estado-aguarda-ne');
  await page.click('[data-estado="Faturada"]');
  await page.fill('#tVal', 'FT 2026/123');
  await page.click('#tOk');
  await page.waitForSelector('.det-cab .estado-faturada');
  assert((await page.textContent('#vDetalhe')).includes('Fatura FT 2026/123'), 'mostra n.º da fatura');
  const f = await fake(page, () => window.__fake.doc('folhas/fo010'));
  igual(f.historico.map((h) => h.estado).slice(-3).join(','), 'Revista,Aguarda NE,Faturada', 'histórico');
  igual(f.numeroFatura, 'FT 2026/123', 'n.º da fatura gravado');
  await captura(page, 'folha-faturada-375');
  semErros(page); await ctx.close();
});

teste('folhas: «Por agendar» sem técnico/data; agendar ao atribuir técnico e data', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/folhas.html?id=fo028');
  await page.waitForSelector('#detNumero');
  assert((await page.textContent('#vDetalhe')).includes('Por atribuir'), 'mostra técnico por atribuir');
  await page.click('[data-estado="Agendada"]');
  await page.waitForSelector('#fFolha');
  await page.waitForFunction(() => document.querySelectorAll('#ffTec option').length > 2);
  const nomes = await page.$$eval('#ffTec option', (o) => o.map((x) => x.textContent));
  assert(nomes.includes('Ana Ferreira'), 'backoffice marcado como técnico aparece na lista');
  await page.selectOption('#ffTec', 'u-tec2');
  await page.fill('#ffData', '2030-02-01');
  await page.click('#ffGuardar');
  await page.waitForSelector('.det-cab .estado-agendada');
  const f = await fake(page, () => window.__fake.doc('folhas/fo028'));
  igual(f.estado, 'Agendada', 'agendada');
  igual(f.historico[f.historico.length - 1].de, 'Por agendar', 'histórico');
  // nova folha sem técnico fica «Por agendar»
  await page.goto(BASE + '/folhas.html?nova=1&cliente=cli003');
  await page.waitForSelector('.cliente-escolhido');
  await page.fill('#ffData', '');
  await page.click('#ffGuardar');
  await page.waitForSelector('.det-cab .estado-por-agendar');
  semErros(page); await ctx.close();
});

teste('folhas master: edita folha (reagendar) e corrige estado de faturada', async () => {
  const { ctx, page } = await contexto({ viewport: DESKTOP });
  await entrar(page, 'master');
  await page.goto(BASE + '/folhas.html?id=fo011');
  await page.waitForSelector('#selCorrigir');
  await page.selectOption('#selCorrigir', 'Concluída');
  await page.click('.modal [data-r="1"]');
  await page.waitForSelector('.det-cab .estado-concluida');
  await page.click('#btnEditar');
  await page.waitForFunction(() => document.querySelector('#ffTec')?.value === 'u-tec2');
  await page.fill('#ffData', '2030-01-15');
  await page.fill('#ffHora', '10:15');
  await page.click('#ffGuardar');
  await page.waitForSelector('.toast-ok >> text=Folha atualizada.');
  const f = await fake(page, () => window.__fake.doc('folhas/fo011'));
  const d = new Date(f.dataPrevista.seconds * 1000);
  igual(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`, '2030-1-15 10:15', 'nova data');
  igual(f.historico[f.historico.length - 1].de, 'Faturada', 'histórico regista origem');
  await captura(page, 'folha-detalhe-master-desktop');
  semErros(page); await ctx.close();
});

// =====================================================================
// CLIENTES
// =====================================================================
teste('clientes: lista paginada, pesquisa por nome/localidade/NIF', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/clientes.html');
  await page.waitForFunction(() => document.querySelectorAll('#lista .lista-item').length === 20);
  await page.click('#btnMais');
  await page.waitForFunction(() => document.querySelectorAll('#lista .lista-item').length === 27);
  await page.fill('#q', 'ovar');
  await page.click('#fPesq button');
  await page.waitForFunction(() => document.querySelectorAll('#lista .lista-item').length === 1);
  await page.fill('#q', 'clin sorr');
  await page.click('#fPesq button');
  await page.waitForFunction(() => document.querySelector('#lista').textContent.includes('Clínica Dentária Sorriso'));
  await page.fill('#q', '503 198 749');
  await page.click('#fPesq button');
  await page.waitForFunction(() => document.querySelector('#lista').textContent.includes('Hotel Meliá Ria'));
  await semOverflow(page, 'clientes');
  await captura(page, 'clientes-375');
  semErros(page); await ctx.close();
});

teste('clientes: NIF obrigatório, validado e único; criar e editar', async () => {
  const { ctx, page } = await contexto({ viewport: MOVEIS[1] });
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/clientes.html');
  await page.click('#btnNovo');
  await page.fill('#cNome', 'Teste Climatização Lda');
  await page.click('#cGuardar');
  igual(await page.textContent('#cErro'), 'O NIF é obrigatório.', 'NIF obrigatório');
  await page.fill('#cNif', '503198748');
  await page.click('#cGuardar');
  igual(await page.textContent('#cErro'), 'NIF inválido (dígito de controlo errado).', 'dígito de controlo');
  await page.fill('#cNif', '503198749');
  await page.click('#cGuardar');
  await page.waitForFunction(() => document.querySelector('#cErro').textContent.includes('Já existe'));
  await page.fill('#cNif', 'es b12345678');
  await page.fill('#cCP', '3700-123');
  await page.fill('#cLoc', 'São João da Madeira');
  await captura(page, 'cliente-novo-414');
  await page.click('#cGuardar');
  await page.waitForSelector('#fichaNome');
  igual(await page.textContent('#fichaNome'), 'Teste Climatização Lda', 'ficha aberta');
  const id = new URL(page.url()).searchParams.get('id');
  const c = await fake(page, (id) => window.__fake.doc('clientes/' + id), id);
  igual(c.nif, 'ESB12345678', 'NIF estrangeiro normalizado');
  assert(c.pesquisa.includes('joa') && c.pesquisa.includes('te'), 'tokens de pesquisa');
  // NIF português válido gerado
  await page.click('#btnEditar');
  await page.fill('#cNif', '123456789');
  await page.click('#cGuardar');
  await page.waitForSelector('.toast-ok >> text=Cliente atualizado.');
  igual((await fake(page, (id) => window.__fake.doc('clientes/' + id), id)).nif, '123456789', 'NIF editado');
  // ficha → folhas do cliente → nova folha com cliente pré-escolhido
  await page.click('#btnVerFolhas');
  await page.waitForSelector('text=Sem folhas de obra.');
  await page.click('text=+ Folha de obra');
  await page.waitForSelector('.cliente-escolhido');
  assert((await page.textContent('.cliente-escolhido')).includes('Teste Climatização Lda'), 'cliente pré-escolhido');
  await semOverflow(page, 'ficha cliente');
  semErros(page); await ctx.close();
});

teste('clientes: importação de CSV do PHC (ignora existentes, inválidos e repetidos)', async () => {
  const { ctx, page } = await contexto({ viewport: MOVEIS[1] });
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/clientes.html');
  await page.waitForSelector('#lista .lista-item');
  const csv = [
    'Nº;Nome;Nº Contribuinte;Morada;Cód.Postal;Local;Telefone;Email',
    '101;"Café Central, Lda";501234560;Rua A 1;3700-001;São João da Madeira;256000001;cafe@x.pt',
    '102;Oficina Ribeiro;504000004;Rua B;3800-002;Aveiro;;',
    '103;Hotel Meliá Ria (repetido na BD);503198749;;;;;',
    '104;NIF errado;123456780;;;;;',
    '105;Consumidor final;999999990;;;;;',
    '106;Café Central filial;501234560;;;;;',
    '107;Empresa Espanhola;ES B12345678;;;Vigo;;',
    ';;;;;;;',
  ].join('\r\n');
  // ficheiro em Windows-1252 (como o Excel/PHC costumam gravar)
  const buf = Buffer.from(csv, 'latin1');
  await page.click('#btnImportar');
  await page.setInputFiles('#impFich', { name: 'clientes.csv', mimeType: 'text/csv', buffer: buf });
  await page.waitForSelector('#impNovos');
  igual(await page.textContent('#impNovos'), '3', 'clientes novos');
  igual(await contar(page, '#impErros li'), 2, 'linhas com problemas (NIF errado + consumidor final)');
  await captura(page, 'clientes-importar-414');
  await page.click('#impOk');
  await page.waitForSelector('.toast-ok >> text=3 clientes importados.');
  const r = await fake(page, () => Object.values(window.__fake.db()).filter((c) => c.origem === 'importacao'));
  igual(r.length, 3, 'gravados');
  const cafe = r.find((c) => c.nif === '501234560');
  igual(cafe.nome, 'Café Central, Lda', 'acentos e vírgula entre aspas');
  igual(cafe.localidade, 'São João da Madeira', 'localidade');
  igual(cafe.phcId, '101', 'n.º PHC');
  assert(r.some((c) => c.nif === 'ESB12345678'), 'NIF estrangeiro');
  await page.fill('#q', 'oficina');
  await page.click('#fPesq button');
  await page.waitForFunction(() => document.querySelector('#lista').textContent.includes('Oficina Ribeiro'));
  semErros(page); await ctx.close();
});

teste('clientes do PHC: só leitura na plataforma; inativos não aparecem ao criar folha', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/clientes.html');
  await page.fill('#q', 'santa clara');
  await page.click('#fPesq button');
  await page.waitForFunction(() => document.querySelectorAll('#lista .lista-item').length === 2);
  assert((await page.textContent('#lista')).includes('Inativo'), 'inativo assinalado na lista');
  await page.goto(BASE + '/clientes.html?id=phc-1234');
  await page.waitForSelector('#avisoPhc');
  igual(await contar(page, '#btnEditar'), 0, 'sem botão Editar');
  assert((await page.textContent('.det-cab')).includes('PHC 1234'), 'mostra n.º PHC');
  await captura(page, 'cliente-phc-375');
  // as regras (simuladas) também recusam alterar um cliente do PHC
  const erro = await page.evaluate(async () => {
    const m = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js');
    try { await m.updateDoc(m.doc({ type: 'firestore' }, 'clientes', 'phc-1234'), { nome: 'Alterado' }); return 'gravou'; } catch (e) { return e.code; }
  });
  igual(erro, 'permission-denied', 'regras recusam editar cliente do PHC');
  // ao criar folha, o inativo não aparece
  await page.goto(BASE + '/folhas.html?nova=1');
  await page.waitForSelector('#cliQ');
  await page.fill('#cliQ', 'santa clara');
  await page.click('#cliProcurar');
  await page.waitForSelector('#cliRes [data-i]');
  igual(await contar(page, '#cliRes [data-i]'), 1, 'só o cliente ativo');
  assert((await page.textContent('#cliRes')).includes('Lar de Idosos'), 'é o Lar de Idosos');
  semErros(page); await ctx.close();
});

teste('clientes: ficha mostra folhas do cliente (índice clienteId + criadoEm)', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'master');
  await page.goto(BASE + '/clientes.html?id=cli001');
  await page.click('#btnVerFolhas');
  await page.waitForFunction(() => document.querySelectorAll('#folhasCli .lista-item').length === 2);
  await captura(page, 'cliente-ficha-375');
  semErros(page); await ctx.close();
});

// =====================================================================
// UTILIZADORES
// =====================================================================
teste('utilizadores: master cria técnico (convite por email) sem perder a sessão', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'master');
  await page.goto(BASE + '/utilizadores.html');
  await page.waitForSelector('#lista .lista-item');
  igual(await contar(page, '#lista .lista-item'), 5, 'utilizadores com perfil');
  await page.click('#btnNovo');
  await page.fill('#uNome', 'Carlos Novo');
  await page.fill('#uEmail', 'Carlos.Novo@redemovel.pt');
  await page.selectOption('#uPerfil', 'tecnico');
  await captura(page, 'utilizador-novo-375');
  await page.click('#uGuardar');
  await page.waitForSelector('.toast-ok');
  igual(await contar(page, '#lista .lista-item'), 6, 'novo na lista');
  const r = await fake(page, () => {
    const db = window.__fake.db();
    const e = Object.entries(db).find(([k, v]) => k.startsWith('utilizadores/') && v.email === 'carlos.novo@redemovel.pt');
    return { perfil: e && e[1].perfil, ativo: e && e[1].ativo, emails: window.__fake.emails(), cur: localStorage.getItem('__fake_auth_cur') };
  });
  igual(r.perfil, 'tecnico', 'perfil gravado');
  igual(r.ativo, true, 'ativo');
  igual(r.emails[0].email, 'carlos.novo@redemovel.pt', 'email de convite enviado');
  igual(r.emails[0].lingua, 'pt', 'email em português');
  igual(r.cur, 'u-master', 'sessão do master mantida');
  // o próprio master não pode mudar o seu perfil
  await page.click('#lista .lista-item:has-text("Ricardo Bastos")');
  assert(await page.locator('#uPerfil').isDisabled(), 'perfil próprio bloqueado');
  await page.click('[data-fechar]');
  // associar UID existente (utilizador já criado no Authentication)
  await page.click('#btnNovo');
  await page.fill('#uNome', 'Novo Backoffice');
  await page.fill('#uEmail', 'novo@redemovel.pt');
  await page.selectOption('#uPerfil', 'backoffice');
  await page.click('summary');
  await page.fill('#uUid', 'u-novo');
  await page.click('#uGuardar');
  await page.waitForSelector('.toast-ok >> text=Perfil associado.');
  igual((await fake(page, () => window.__fake.doc('utilizadores/u-novo'))).perfil, 'backoffice', 'UID associado');
  await semOverflow(page, 'utilizadores');
  semErros(page); await ctx.close();
});

teste('utilizadores: desativar técnico bloqueia o acesso dele', async () => {
  const { ctx, page } = await contexto({ viewport: DESKTOP });
  await entrar(page, 'master');
  await page.goto(BASE + '/utilizadores.html');
  await page.click('#lista .lista-item:has-text("Pedro Costa")');
  await page.uncheck('#uAtivo');
  await page.click('#uGuardar');
  await page.waitForSelector('.toast-ok');
  await page.click('#btnSair');
  await page.waitForURL(/index\.html/);
  await page.fill('#email', seed.USERS.tecnico2.email);
  await page.fill('#pass', seed.PASS);
  await page.click('#btnEntrar');
  await page.waitForSelector('text=Conta desativada');
  semErros(page); await ctx.close();
});

// =====================================================================
// DEV / PRODUÇÃO
// =====================================================================
teste('dev: páginas -dev ligam entre si e mostram a etiqueta DEV', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'master', { dev: true });
  await page.waitForSelector('.tag-dev');
  const links = await page.$$eval('#nav a', (a) => a.map((x) => x.getAttribute('href')));
  assert(links.every((l) => l.includes('-dev.html')), 'links do menu para -dev: ' + links.join(','));
  await page.click('#nav a[data-menu=folhas]');
  await page.waitForURL(/folhas-dev\.html/);
  await page.waitForSelector('#lista .lista-item');
  await captura(page, 'dev-folhas-375');
  semErros(page); await ctx.close();
});

teste('produção: páginas sem etiqueta DEV e links sem -dev', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'master');
  await page.waitForSelector('#nav a');
  igual(await contar(page, '.tag-dev'), 0, 'sem DEV');
  const links = await page.$$eval('#nav a', (a) => a.map((x) => x.getAttribute('href')));
  assert(links.every((l) => !l.includes('-dev')), 'links de produção');
  semErros(page); await ctx.close();
});

// =====================================================================
// SDK REAL: confirma que as funções importadas existem no Firebase 12.19.0
// =====================================================================
teste('sdk real: o Firebase verdadeiro carrega e exporta tudo o que o código importa', async () => {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'firebase', 'firebase-app.js'))) { console.log('   (ignorado: corra «npm install» para ativar este teste)'); return; }
  const { ctx, page } = await contexto({ sdkReal: true });
  await page.goto(BASE + '/index.html');
  await page.waitForSelector('#fLogin, #uid, .msg-erro', { timeout: 15000 });
  const erros = page._erros.filter((e) => /does not provide an export|SyntaxError|is not a function|is not defined/.test(e));
  assert(!erros.length, 'erros com o SDK real:\n  ' + erros.join('\n  '));
  await ctx.close();
});

// =====================================================================
(async () => {
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + servidor.address().port;
  browser = await chromium.launch();
  const lista = testes.filter((t) => !SO || t.nome.includes(SO));
  for (const t of lista) {
    const t0 = Date.now();
    try { await t.fn(); resultados.push({ nome: t.nome, ok: true }); console.log(`✔ ${t.nome} (${Date.now() - t0}ms)`); }
    catch (e) { resultados.push({ nome: t.nome, ok: false, e }); if (global.__ultimaPagina) console.log("   erros:", global.__ultimaPagina._erros); console.log(`✘ ${t.nome}\n   ${String(e.message || e).split('\n').join('\n   ')}`); }
  }
  await browser.close();
  servidor.close();
  const falhas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - falhas}/${resultados.length} testes OK${CAPTURAS ? ' · capturas em test/capturas/' : ''}`);
  process.exit(falhas ? 1 : 0);
})();
