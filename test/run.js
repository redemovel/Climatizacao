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
const PAGINAS = ['index', 'agenda', 'folhas', 'guias', 'clientes', 'utilizadores'];

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
  for (const p of ['agenda', 'folhas', 'guias', 'clientes', 'utilizadores']) {
    await page.goto(`${BASE}/${p}.html`);
    await page.waitForURL(/index\.html/);
  }
  semErros(page); await ctx.close();
});

// =====================================================================
// MENU POR PERFIL
// =====================================================================
for (const [quem, menus] of [['master', ['agenda', 'folhas', 'guias', 'clientes', 'utilizadores']], ['backoffice', ['agenda', 'folhas', 'guias', 'clientes']], ['tecnico1', ['agenda', 'folhas', 'guias']]]) {
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
    return Object.entries(db).filter(([k, v]) => k.startsWith('folhas/') && v.tecnicoUid === 'u-tec1' && ['Por agendar', 'Agendada', 'Em curso', 'Pendente'].includes(v.estado) && v.dataPrevista.__ts >= seg.getTime() && v.dataPrevista.__ts < fim.getTime()).length;
  });
  igual(n, esperado, 'trabalhos da semana (só por fazer)');
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


teste('agenda: só trabalho por fazer; «Mostrar concluídas» mostra o resto; atrasos só dos últimos 60 dias', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  await page.evaluate(() => localStorage.setItem('agenda.vista', 'semana'));
  await page.reload();
  await page.waitForSelector('#lista .lista-item');
  await page.click('#ant');
  await page.waitForFunction(() => !document.querySelector('#lista').textContent.includes('A carregar'));
  assert(!(await page.locator('#lista .estado-concluida').count()), 'semana passada sem concluídas');
  await page.check('#mostrarConcl');
  await page.waitForSelector('#lista .estado-concluida');
  await page.click('#hoje');
  await page.waitForSelector('#atrasos .atrasos');
  igual(await contar(page, '#atrasos .lista-item'), 1, 'só o atraso recente (a folha de há 90 dias fica de fora)');
  assert(!(await page.textContent('#atrasos')).includes('Ver folhas abertas'), 'técnico não vê a ligação às antigas');
  await page.uncheck('#mostrarConcl');
  semErros(page); await ctx.close();
});

teste('folhas master: abertas há mais de 60 dias e fecho em lote com histórico', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'master');
  await page.evaluate(() => localStorage.setItem('agenda.vista', 'dia'));
  await page.reload();
  await page.waitForSelector('#atrasos a[href*="filtro=antigas"]');
  await page.click('#atrasos a[href*="filtro=antigas"]');
  await page.waitForSelector('#barraLote');
  igual(await contar(page, '#lista .lista-item'), 2, 'duas folhas antigas abertas');
  for (const vp of MOVEIS) { await page.setViewportSize(vp); await semOverflow(page, 'lote ' + vp.width); await captura(page, 'folhas-antigas-' + vp.width); }
  await page.click('#selTodas');
  igual(await page.textContent('#nSel'), '2 selecionadas', 'selecionadas');
  await page.selectOption('#loteEstado', 'Concluída');
  await page.click('#btnLote');
  await page.click('[data-r="1"]');
  await page.waitForSelector('.toast-ok');
  await page.waitForFunction(() => document.querySelector('#lista').textContent.includes('Não há folhas'));
  const ano = new Date().getFullYear() - 1;
  const f = await fake(page, (id) => window.__fake.doc('folhas/' + id), `phc-${ano}-0901`);
  igual(f.estado, 'Concluída', 'estado');
  const h = f.historico[f.historico.length - 1];
  igual(h.de + '→' + h.estado + ' ' + h.uid, 'Em curso→Concluída u-master', 'histórico');
  semErros(page); await ctx.close();
});

teste('folhas backoffice: vê as antigas mas sem fecho em lote', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/folhas.html?filtro=antigas');
  await page.waitForSelector('#lista .lista-item');
  igual(await contar(page, '#lista .lista-item'), 2, 'antigas');
  igual(await contar(page, '#barraLote'), 0, 'sem barra de lote');
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
  // Fase 2: tempos, material, tarefas e relatório
  await page.click('#btnTempo');
  await page.waitForSelector('#tEquipa');
  assert(await page.locator('#tEquipa input[value=col1]').isChecked(), 'o próprio técnico vem marcado');
  assert(!(await page.textContent('#tEquipa')).includes('Antigo Colaborador'), 'inativos não aparecem');
  await page.fill('#tIni', '09:00');
  await page.fill('#tFim', '08:00');
  await page.click('#tGuardar');
  igual(await page.textContent('#tErro'), 'A hora de fim tem de ser depois da de início.', 'valida horas');
  await page.fill('#tFim', '11:30');
  await page.uncheck('#tEquipa input[value=col1]');
  await page.check('#tEquipa input[value=col4]');
  await page.click('#tGuardar');
  igual(await page.textContent('#tErro'), 'Tem de estar pelo menos um técnico.', 'pelo menos um técnico');
  await page.check('#tEquipa input[value=col1]');
  await page.check('#tEquipa input[value=col2]');
  for (const vp of MOVEIS) { await page.setViewportSize(vp); await semOverflow(page, 'modal tempo ' + vp.width); }
  await captura(page, 'folha-tempo-modal-414');
  await page.setViewportSize(MOVEIS[0]);
  await page.click('#tGuardar');
  await page.waitForSelector('.toast-ok >> text=Tempo registado.');
  assert((await page.textContent('#cartaoTempos')).includes('João Silva, Pedro Costa, Equipa externa — ajudante'), 'nomes da equipa');
  assert((await page.textContent('#cartaoTempos')).includes('09:00–11:30'), 'horas');
  assert((await page.textContent('#totalHoras')).includes('7,5 h'), 'total 2,5 h × 3 pessoas');
  await page.click('#btnMaterial');
  await page.click('#mGuardar');
  igual(await page.textContent('#mErro'), 'Indique a descrição do material.', 'valida material');
  await page.fill('#mDesc', 'Tubo de cobre 1/4"');
  await page.fill('#mRef', 'TC14');
  await page.fill('#mQtd', '3,5'.replace(',', '.'));
  await page.selectOption('#mUn', 'm');
  await page.click('#mGuardar');
  await page.waitForSelector('.toast-ok >> text=Material registado.');
  await page.check('[data-tarefa="Limpeza do local"]');
  await page.waitForFunction(() => window.__fake.doc('folhas/fo001').tarefas?.['Limpeza do local'] === true);
  await page.fill('#relatorio', 'Limpeza de filtros e verificação de pressões.');
  await page.click('#btnRelatorio');
  await page.waitForSelector('.toast-ok >> text=Relatório guardado.');
  assert(!(await page.textContent('#vDetalhe')).includes('€'), 'técnico não vê valores');
  for (const vp of MOVEIS) { await page.setViewportSize(vp); await semOverflow(page, 'folha trabalho ' + vp.width); await captura(page, 'folha-trabalho-' + vp.width); }
  await page.setViewportSize(MOVEIS[0]);
  // concluir: relatório + assinatura obrigatórios
  await page.click('[data-estado="Concluída"]');
  await page.waitForSelector('#cAss');
  await page.fill('#cNome', 'Sr. Manuel');
  await page.click('#cOk');
  igual(await page.textContent('#cErro'), 'Peça ao cliente para assinar, ou marque «Cliente ausente».', 'assinatura obrigatória');
  const box = await page.locator('#cAss').boundingBox();
  await page.mouse.move(box.x + 30, box.y + 60);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 30 + i * 25, box.y + 60 + (i % 2 ? 30 : -20));
  await page.mouse.up();
  igual(await page.inputValue('#cEmail'), 'geral@cliente-teste.pt', 'email do cliente');
  await page.fill('#cEmail', '');
  await page.click('#cOk');
  igual(await page.textContent('#cErro'), 'Indique o email do cliente: o relatório é sempre enviado.', 'relatório obrigatório');
  await page.fill('#cEmail', 'geral@cliente-teste.pt');
  await semOverflow(page, 'modal concluir');
  await captura(page, 'folha-concluir-375');
  await page.click('#cOk');
  await page.waitForSelector('.det-cab .estado-concluida');
  await page.waitForSelector('#assinaturaCli img');
  igual(await contar(page, '#btnTempo'), 0, 'técnico já não regista tempos depois de concluída');
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
  igual(f.tempos.length + ' ' + f.tempos[0].horas + ' ' + f.tempos[0].tecnicos + ' ' + f.tempos[0].ajudantes + ' ' + f.tempos[0].aprendizes, '1 2.5 2 1 0', 'tempo gravado');
  igual(f.tempos[0].equipa.map((p) => p.nome + '/' + p.funcao).join(','), 'João Silva/Técnico,Pedro Costa/Técnico,Equipa externa — ajudante/Ajudante', 'equipa gravada');
  igual(f.materiais[0].descricao + ' ' + f.materiais[0].qtd + ' ' + f.materiais[0].unidade, 'Tubo de cobre 1/4" 3.5 m', 'material gravado');
  igual(f.assinatura.nome, 'Sr. Manuel', 'assinatura');
  assert(f.assinatura.imagem.startsWith('data:image/png') && f.assinatura.imagem.length < 200000, 'imagem da assinatura pequena: ' + f.assinatura.imagem.length);
  igual(f.relatorio, 'Limpeza de filtros e verificação de pressões.', 'relatório');
  const em = await fake(page, () => Object.values(window.__fake.db()).filter((v) => v.tipo === 'relatorio'));
  igual(em.length + ' ' + em[0].para + ' ' + em[0].estado + ' ' + em[0].folhaId, '1 geral@cliente-teste.pt Pendente fo001', 'email do relatório em fila');
  assert(em[0].html.includes('cid:assinatura') && em[0].html.includes('Tubo de cobre') && !em[0].html.includes('€') && em[0].assinaturaPng.startsWith('data:image/png'), 'relatório com material, assinatura e sem preços');
  igual(f.relatorioCliente.para, 'geral@cliente-teste.pt', 'folha regista o pedido de envio');
  assert((await page.textContent('#estadoRelatorio')).includes('A enviar para geral@cliente-teste.pt'), 'mostra estado do envio');
  // concluída: técnico já não tem ações (Faturada é só backoffice/master)
  igual(await contar(page, '[data-estado]'), 0, 'sem ações após concluída');
  semErros(page); await ctx.close();
});

teste('fase 2: técnico não regista trabalho em folha agendada; regras recusam concluir sem assinatura', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  await page.goto(BASE + '/folhas.html?id=fo002');
  await page.waitForSelector('#detNumero');
  igual(await contar(page, '#btnTempo'), 0, 'sem «+ Tempo» em Agendada');
  assert(await page.locator('[data-tarefa]').first().isDisabled(), 'tarefas só de leitura');
  const tenta = (id, alt) => page.evaluate(async ([id, alt]) => {
    try { await window.__fake.atualizarComoUtilizador('folhas/' + id, alt); return 'ok'; } catch (e) { return e.code; }
  }, [id, alt]);
  igual(await tenta('fo002', { relatorio: 'x' }), 'permission-denied', 'relatório em Agendada');
  const f3 = await fake(page, () => window.__fake.db()['folhas/fo003']);
  const hist = [...f3.historico, { estado: 'Concluída', de: 'Em curso', uid: 'u-tec1', nome: 'João Silva', em: { seconds: 1 } }];
  igual(await tenta('fo003', { estado: 'Concluída', historico: hist }), 'permission-denied', 'concluir sem assinatura');
  igual(await tenta('fo003', { tempos: [{ id: 'a', horas: 1 }] }), 'ok', 'tempo em curso');
  igual(await tenta('fo003', { tecnicoUid: 'u-tec2' }), 'permission-denied', 'técnico não muda o responsável');
  semErros(page); await ctx.close();
});

teste('colaboradores: master cria lista inicial e edita; técnico só lê', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'master');
  await page.evaluate(() => { const db = window.__fake.db(); for (const k of Object.keys(db)) if (k.startsWith('colaboradores/')) delete db[k]; localStorage.setItem('__fake_db', JSON.stringify(db)); });
  await page.goto(BASE + '/utilizadores.html');
  await page.click('#btnColIniciais');
  await page.waitForSelector('[data-col]');
  igual(await contar(page, '[data-col]'), 6, 'seis colaboradores');
  assert((await page.textContent('#listaCol')).includes('Pascoal Rodrigues'), 'Pascoal');
  await page.click('[data-col] >> text=Aprendiz');
  await page.selectOption('#cFuncao', 'Ajudante');
  await page.click('#cGuardar');
  await page.waitForSelector('.toast-ok >> text=Colaborador guardado.');
  for (const vp of MOVEIS) { await page.setViewportSize(vp); await semOverflow(page, 'colaboradores ' + vp.width); await captura(page, 'colaboradores-' + vp.width); }
  await page.click('#btnSair');
  await page.waitForURL(/index\.html/);
  await entrar(page, 'tecnico1');
  const r = await page.evaluate(async () => {
    const k = Object.keys(window.__fake.db()).find((x) => x.startsWith('colaboradores/'));
    try { await window.__fake.atualizarComoUtilizador(k, { funcao: 'Ajudante' }); return 'ok'; } catch (e) { return e.code; }
  });
  igual(r, 'permission-denied', 'técnico não altera colaboradores');
  semErros(page); await ctx.close();
});

teste('fase 2: master define preço/hora e vê o valor da mão de obra; backoffice não', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'master');
  await page.goto(BASE + '/utilizadores.html');
  await page.click('#btnPrecos');
  await page.fill('#pTab', 'Manutenção;Técnico;20,40\nManutenção;Técnico-Técnico-Ajudante;51,00\nAT/Instalação;Técnico-Aprendiz;30,00\nlinha errada');
  await semOverflow(page, 'preço/hora');
  await captura(page, 'precos-hora-375');
  await page.click('#pGuardar');
  await page.waitForSelector('.toast >> text=3 linhas');
  const t = await fake(page, () => window.__fake.doc('config/precosHora'));
  igual(t.linhas.length, 3, 'linhas');
  igual(JSON.stringify(t.linhas[1]), JSON.stringify({ tipo: 'Manutenção', composicao: 'Técnico-Técnico-Ajudante', tecnicos: 2, ajudantes: 1, aprendizes: 0, preco: 51 }), 'linha equipa');
  igual(t.linhas[2].aprendizes, 1, 'aprendiz contado');
  // folha de manutenção com 2,5 h de 2 técnicos + 1 ajudante num dia útil
  await fake(page, () => {
    const db = window.__fake.db();
    const d = new Date(); d.setHours(12, 0, 0, 0);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    window.__fake.set('folhas/fo006', { ...db['folhas/fo006'], tipo: 'Manutenção', estado: 'Em curso',
      tempos: [{ id: 'x1', data: { __ts: d.getTime() }, inicio: '09:00', fim: '11:30', horas: 2.5, tecnicos: 2, ajudantes: 1, aprendizes: 0, uid: 'u-tec1', nome: 'João Silva',
        equipa: [{ id: 'col1', nome: 'João Silva', funcao: 'Técnico' }, { id: 'col2', nome: 'Pedro Costa', funcao: 'Técnico' }, { id: 'col4', nome: 'Equipa externa — ajudante', funcao: 'Ajudante' }] }] });
  });
  await page.goto(BASE + '/folhas.html?id=fo006');
  await page.waitForSelector('#totalMO');   // automático, sem botão
  assert((await page.textContent('#valorMO')).includes('Técnico-Técnico-Ajudante'), 'linha da tabela usada');
  // 51 × (1×1,2 + 1×1,1 + 0,5) = 142,80
  assert((await page.textContent('#totalMO')).includes('142,80'), 'total MO: ' + await page.textContent('#totalMO'));
  await captura(page, 'valor-mo-375');
  await page.click('#btnSair');
  await page.waitForURL(/index\.html/);
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/folhas.html?id=fo006');
  await page.waitForSelector('#cartaoTempos');
  await page.waitForTimeout(200);
  igual(await contar(page, '#valorMO'), 0, 'backoffice sem valores');
  assert(!(await page.textContent('#vDetalhe')).includes('€'), 'backoffice não vê euros');
  const negado = await page.evaluate(async () => {
    try { await window.__fake.lerComoUtilizador('config/precosHora'); return 'lido'; } catch (e) { return e.code; }
  });
  igual(negado, 'permission-denied', 'backoffice não lê a tabela');
  semErros(page); await ctx.close();
});

teste('folhas importadas do PHC: mostram dossier, estado PHC e linhas (sem preços)', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  await page.goto(BASE + '/folhas.html?id=phc-' + new Date().getFullYear() + '-1785');
  await page.waitForSelector('#cartaoPhc');
  const t = await page.textContent('#cartaoPhc');
  assert(t.includes('Dossier 1785') && t.includes('3-Em Execução') && t.includes('Serviço Técnico (Equipa)') && t.includes('8 h'), 'conteúdo: ' + t);
  assert(!/€|preço/i.test(t), 'sem preços');
  assert(t.includes('Registo de tempos') && t.includes('Ricardo Pereira') && t.includes('Ficha fluorados'), 'tempos e tarefas');
  assert(t.includes('Substituído o ligador') && t.includes('2146895') && t.includes('Em garantia'), 'relatório, V/Encomenda e situação');
  assert(!t.includes('paga a 60 dias'), 'observações internas não aparecem ao técnico');
  igual(await contar(page, '#btnValores'), 0, 'técnico sem botão de valores');
  const neg = await page.evaluate(async () => {
    const m = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js');
    try { await m.getDoc(m.doc({ type: 'firestore' }, 'folhas', 'phc-' + new Date().getFullYear() + '-1785', 'privado', 'phc')); return 'leu'; } catch (e) { return e.code; }
  });
  igual(neg, 'permission-denied', 'técnico não lê os valores (regras)');
  await page.click('[data-estado="Pendente"]');
  await page.check('input[name=motivo][value="Peças"]', { force: true });
  await page.click('#pOk');
  await page.waitForSelector('#pendencia');
  await semOverflow(page, 'folha importada');
  await captura(page, 'folha-importada-375');
  semErros(page); await ctx.close();
});

teste('folhas importadas do PHC: Master vê valores; backoffice não', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'master');
  await page.goto(BASE + '/folhas.html?id=phc-' + new Date().getFullYear() + '-1785');
  await page.click('#btnValores');
  await page.waitForSelector('#totalVenda');
  assert((await page.textContent('#totalVenda')).includes('958,80'), 'total venda');
  assert((await page.textContent('#valoresPhc')).includes('Técnico-Técnico'), 'valor hora');
  await captura(page, 'folha-valores-master-375');
  await page.click('#btnSair');
  await page.waitForURL(/index\.html/);
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/folhas.html?id=phc-' + new Date().getFullYear() + '-1785');
  await page.waitForSelector('#cartaoPhc');
  igual(await contar(page, '#btnValores'), 0, 'backoffice sem valores');
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
  assert((await page.textContent('#lista')).includes('Equipamento não arranca'), 'descrição do trabalho na lista');
  await page.selectOption('#fEstado', '');
  await page.waitForFunction(() => document.querySelectorAll('#lista .lista-item').length === 20);
  assert(await page.locator('#maisWrap').isVisible(), 'botão carregar mais');
  await page.click('#btnMais');
  await page.waitForFunction(() => document.querySelectorAll('#lista .lista-item').length === 31);
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
  igual(f.estado, 'Por agendar', 'estado inicial: Por agendar mesmo com técnico e data');
  igual(f.tecnicoNome, 'Pedro Costa', 'técnico');
  igual(f.tipo, 'AT', 'tipo');
  igual(f.clienteId, 'cli001', 'cliente');
  igual(f.historico.length, 1, 'histórico inicial');
  igual(new Date(f.dataPrevista.seconds * 1000).getHours(), 16, 'hora prevista');
  await page.click('[data-estado="Agendada"]');
  await page.waitForSelector('#aEmail');
  await page.click('#aOk');
  igual(await page.textContent('#aErro'), 'Indique o email do cliente, ou marque «Não enviar aviso desta vez».', 'email do aviso obrigatório');
  await page.fill('#aEmail', 'obra@cliente.pt');
  await captura(page, 'aviso-agendamento-375');
  await page.click('#aOk');
  await page.waitForSelector('.det-cab .estado-agendada');
  const av = await fake(page, () => Object.values(window.__fake.db()).filter((v) => v.tipo === 'agendamento'));
  igual(av.length + ' ' + av[0].para + ' ' + av[0].folhaId, '1 obra@cliente.pt ' + id, 'aviso de agendamento em fila');
  assert(av[0].html.includes('agendada para') && av[0].assunto.includes('Intervenção agendada'), 'conteúdo do aviso');
  assert((await page.textContent('#estadoAviso')).includes('a enviar para obra@cliente.pt'), 'mostra o aviso na folha');
  // backoffice não faz revisão nem faturação (só o Master)
  await page.goto(BASE + '/folhas.html?id=fo010');
  await page.waitForSelector('#detNumero');
  igual(await contar(page, '[data-estado]'), 0, 'backoffice sem ações numa concluída');
  const optsC = await page.$$eval('#selCorrigir option', (o) => o.map((x) => x.value).filter(Boolean));
  assert(!optsC.some((o) => ['Revista', 'Aguarda NE', 'Faturada'].includes(o)), 'backoffice não corrige para estados do Master: ' + optsC);
  semErros(page); await ctx.close();
});

teste('sincronizar PHC agora: staff faz o pedido; técnico não vê o botão', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/folhas.html');
  await page.waitForSelector('#btnSincPHC:not(.oculto)');
  await semOverflow(page, 'folhas com botão PHC');
  await page.click('#btnSincPHC');
  await page.waitForSelector('.toast-ok >> text=Pedido enviado');
  const c = await fake(page, () => window.__fake.doc('controlo/sincronizar'));
  igual(c.estado + ' ' + c.pedidoPor, 'Pedido u-bo', 'pedido gravado');
  await page.click('#btnSair');
  await page.waitForURL(/index\.html/);
  await entrar(page, 'tecnico1');
  await page.goto(BASE + '/folhas.html');
  await page.waitForSelector('#lista .lista-item');
  assert(await page.locator('#btnSincPHC').isHidden(), 'técnico sem botão');
  semErros(page); await ctx.close();
});

teste('relatório ao cliente: ver/imprimir e reenviar por email (staff)', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/folhas.html?id=fo010');
  await page.waitForSelector('#cartaoRelCliente');
  await page.click('#btnVerRelatorio');
  await page.waitForSelector('#vRelatorio');
  const txt = await page.textContent('#vRelatorio');
  assert(txt.includes('Relatório de intervenção') && txt.includes('Documento informativo, para conferência'), 'abre o relatório com o aviso de conferência');
  await semOverflow(page, 'relatório no telemóvel');
  await captura(page, 'relatorio-cliente-375');
  await page.click('#relFechar');
  await page.waitForSelector('#vRelatorio', { state: 'detached' });
  await page.click('#btnEnviarRelatorio');
  await page.fill('#eRel', 'x');
  await page.click('#eOk');
  igual(await page.textContent('#eErro'), 'Email inválido.', 'valida email');
  await page.fill('#eRel', 'cliente@exemplo.pt');
  await page.click('#eOk');
  await page.waitForSelector('.toast-ok >> text=Relatório em fila');
  const em = await fake(page, () => Object.values(window.__fake.db()).filter((v) => v.tipo === 'relatorio'));
  igual(em.length + ' ' + em[0].para + ' ' + em[0].folhaId, '1 cliente@exemplo.pt fo010', 'email em fila');
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
  await page.waitForSelector('#aSem');
  await page.check('#aSem');
  await page.click('#aOk');
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
  await page.waitForFunction(() => document.querySelectorAll('#folhasCli .lista-item').length === 3);
  await captura(page, 'cliente-ficha-375');
  semErros(page); await ctx.close();
});

// =====================================================================
// FASE 3: STOCK E GUIAS DE TRANSPORTE AC
// =====================================================================
teste('fase 3: importar da guia só o gasto (10 de 50); apagar devolve à guia', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  await page.goto(BASE + '/folhas.html?id=fo003');
  await page.click('#btnImportarGuia');
  await page.waitForSelector('input[type=number][data-g=g1]');
  assert((await page.textContent('.modal')).includes('por gastar 50'), 'mostra 50 por gastar');
  for (const vp of MOVEIS) { await page.setViewportSize(vp); await semOverflow(page, 'importar ' + vp.width); await captura(page, 'importar-guia-' + vp.width); }
  await page.fill('input[type=number][data-g=g1]', '60');
  await page.click('#iOk');
  await page.waitForSelector('.toast-erro >> text=só há 50');
  await page.fill('input[type=number][data-g=g1]', '10');
  await page.click('#iOk');
  await page.waitForSelector('.toast-ok >> text=Material importado da guia.');
  assert((await page.textContent('#cartaoMateriais')).includes('guia 353/'), 'material com referência à guia');
  let g = await fake(page, () => window.__fake.doc('guias/g1'));
  let a = await fake(page, () => window.__fake.doc('artigos/TC14'));
  const f = await fake(page, () => window.__fake.doc('folhas/fo003'));
  igual(g.linhas[0].consumido + ' ' + a.resGuias + ' ' + a.resFolhas, '10 40 10', 'guia 10 gastos; reservas passam da guia para a folha');
  igual(f.materiais[0].qtd + ' ' + f.materiais[0].guiaId + ' ' + g.linhas[0].consumos[0].numero, `10 g1 FO-${new Date().getFullYear()}-0003`, 'ligação folha ↔ guia');
  await page.click('[data-apagar-mat]');
  await page.click('[data-r="1"]');
  await page.waitForSelector('.toast-ok >> text=Material apagado.');
  g = await fake(page, () => window.__fake.doc('guias/g1'));
  a = await fake(page, () => window.__fake.doc('artigos/TC14'));
  igual(g.linhas[0].consumido + ' ' + a.resGuias + ' ' + a.resFolhas, '0 50 0', 'apagar devolve à guia');
  semErros(page); await ctx.close();
});

teste('fase 3: material do stock na folha respeita o disponível e reserva; faturar liberta', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'master');
  await page.goto(BASE + '/folhas.html?id=fo003');
  await page.click('#btnMaterial');
  await page.fill('#mProc', 'cobre');
  await page.click('#mProcBtn');
  await page.waitForSelector('.artigo-op');
  const txt = await page.textContent('#mRes');
  assert(txt.includes('TC38') && txt.includes('80 m disp.') && txt.includes('60 m disp.') && !txt.includes('ANTIGO1'), 'disponíveis (TC14: 120−10−50 = 60) e sem inativos: ' + txt);
  await captura(page, 'material-stock-375');
  await page.click('.artigo-op >> text=TC38');
  await page.fill('#mQtd', '81');
  await page.click('#mGuardar');
  igual(await page.textContent('#mErro'), 'Só há 80 m disponíveis.', 'não passa do disponível');
  await page.fill('#mQtd', '5');
  await page.click('#mGuardar');
  await page.waitForSelector('.toast-ok >> text=Material registado.');
  igual((await fake(page, () => window.__fake.doc('artigos/TC38'))).resFolhas, 5, 'reservado na folha');
  await page.selectOption('#selCorrigir', 'Faturada');
  await page.fill('#tVal', 'FT 1');
  await page.click('#tOk');
  await page.waitForSelector('.det-cab .estado-faturada');
  igual((await fake(page, () => window.__fake.doc('artigos/TC38'))).resFolhas, 0, 'faturada liberta a reserva');
  semErros(page); await ctx.close();
});

teste('fase 3: técnico cria guia a partir da folha (por comunicar, sem impressão); master fecha guia comunicada', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  await page.goto(BASE + '/folhas.html?id=fo003');
  await page.click('#btnNovaGuia');
  await page.waitForSelector('#gViatura');
  assert((await page.textContent('#gCliente')).includes(await fake(page, () => window.__fake.doc('folhas/fo003').clienteNome)), 'cliente da folha');
  await page.selectOption('#gViatura', 'AV-78-ER');
  await page.fill('#gProc', 'desinf');
  await page.click('#gProcBtn');
  await page.click('[data-a="0"]');
  await page.fill('[data-q="0"]', '1');
  await page.click('#gGuardar');
  igual(await page.textContent('#gErro'), 'SOLDESINFECTANTE: só há 0,5 l disponíveis.', 'limite do disponível');
  await page.fill('[data-q="0"]', '0.5');
  for (const vp of MOVEIS) { await page.setViewportSize(vp); await semOverflow(page, 'nova guia ' + vp.width); await captura(page, 'guia-nova-' + vp.width); }
  await page.click('#gGuardar');
  await page.waitForSelector('#avisoAT');
  igual(await contar(page, '#btnImprimir'), 0, 'sem código AT não imprime');
  const gs = await fake(page, () => Object.entries(window.__fake.db()).filter(([k, v]) => k.startsWith('guias/') && v.estado === 'Por comunicar').map(([, v]) => v));
  igual(gs.length + ' ' + gs[0].viatura + ' ' + gs[0].tecnicoUid + ' ' + gs[0].folhaId, '1 AV-78-ER u-tec1 fo003', 'guia gravada');
  igual((await fake(page, () => window.__fake.doc('artigos/SOLDESINFECTANTE'))).resGuias, 0.5, 'reservado na guia');
  await captura(page, 'guia-por-comunicar-375');
  await page.goto(BASE + '/guias.html');
  await page.waitForSelector('#lista .lista-item');
  igual(await contar(page, '#lista .lista-item'), 2, 'técnico vê as suas guias abertas');
  await semOverflow(page, 'lista guias');
  await page.click('#btnSair');
  await page.waitForURL(/index\.html/);
  await entrar(page, 'master');
  await page.goto(BASE + '/guias.html?id=g1');
  await page.waitForSelector('#codigoAT');
  assert(await page.locator('#btnImprimir').isVisible(), 'com código AT pode imprimir');
  await page.click('#btnFechar');
  assert((await page.textContent('.modal')).includes('50 m de TC14'), 'avisa o que é devolvido');
  await page.click('[data-r="1"]');
  await page.waitForSelector('.det-cab .estado-fechada');
  const g = await fake(page, () => window.__fake.doc('guias/g1'));
  igual(g.linhas[0].devolvido + ' ' + (await fake(page, () => window.__fake.doc('artigos/TC14'))).resGuias, '50 0', 'sobra devolvida e reserva libertada');
  await captura(page, 'guia-fechada-375');
  semErros(page); await ctx.close();
});

teste('pesquisa de folhas: por cliente, NIF e descrição da avaria (técnico só as suas)', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'backoffice');
  await page.goto(BASE + '/folhas.html');
  await page.waitForSelector('#lista .lista-item');
  await page.fill('#pNum', 'erro e5');
  await page.click('#fPesq button');
  await page.waitForFunction(() => document.querySelector('#lista').textContent.includes('erro E5'));
  const tipos = await page.$$eval('#lista .li-desc, #lista .lista-item', (x) => x.length);
  assert(tipos > 0, 'encontrou por descrição');
  const nif = await fake(page, () => window.__fake.doc('folhas/fo003').clienteNif);
  await page.fill('#pNum', nif);
  await page.click('#fPesq button');
  const nome = await fake(page, () => window.__fake.doc('folhas/fo003').clienteNome);
  await page.waitForFunction((n) => document.querySelector('#lista').textContent.includes(n) && !document.querySelector('#lista').textContent.includes('erro E5'), nome);
  await page.fill('#pNum', nome.split(' ').slice(-1)[0]);
  await page.click('#fPesq button');
  await page.waitForFunction((n) => document.querySelector('#lista').textContent.includes(n), nome);
  await page.click('#btnSair');
  await page.waitForURL(/index\.html/);
  await entrar(page, 'tecnico2');
  await page.goto(BASE + '/folhas.html');
  await page.waitForSelector('#lista .lista-item');
  await page.fill('#pNum', 'manutencao');
  await page.click('#fPesq button');
  await page.waitForTimeout(400);
  const ids = await page.$$eval('#lista [data-id]', (a) => a.map((x) => x.dataset.id));
  const tecs = await fake(page, (ids) => ids.map((i) => window.__fake.doc('folhas/' + i).tecnicoUid), ids);
  assert(ids.length > 0 && tecs.every((t) => t === 'u-tec2'), 'técnico só encontra as suas');
  semErros(page); await ctx.close();
});

teste('n.º de série: importar equipamento da guia pelo n.º de série; não se repete', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico1');
  await page.goto(BASE + '/folhas.html?id=fo003');
  await page.click('#btnImportarGuia');
  await page.waitForSelector('input[data-s="K123456"]');
  await page.check('input[data-s="K123456"]');
  await page.click('#iOk');
  await page.waitForSelector('.toast-ok >> text=Material importado da guia.');
  assert((await page.textContent('#cartaoMateriais')).includes('K123456'), 'n.º de série na folha');
  const sr = await fake(page, () => window.__fake.doc('series/K123456'));
  igual(sr.estado + ' ' + sr.folhaId, 'folha fo003', 'série passa para a folha');
  const g = await fake(page, () => window.__fake.doc('guias/g1'));
  igual(g.linhas[1].consumido + ' ' + g.linhas[1].seriesUsadas.join(), '1 K123456', 'guia regista a série usada');
  // procurar pelo n.º de série no «+ Material»
  await page.click('#btnMaterial');
  await page.fill('#mProc', 'k123456');
  await page.click('#mProcBtn');
  await page.waitForSelector('#mRes .aviso-concl');
  assert((await page.textContent('#mRes')).includes('já foi aplicado'), 'avisa que já foi aplicado');
  // equipamento do stock exige n.º de série
  await page.fill('#mProc', 'daikin');
  await page.click('#mProcBtn');
  await page.click('.artigo-op >> text=FTXP35');
  await page.fill('#mQtd', '1');
  await page.dispatchEvent('#mQtd', 'input');
  await page.click('#mGuardar');
  igual(await page.textContent('#mErro'), 'Indique o n.º de série de cada unidade.', 'série obrigatória');
  await page.fill('input[data-serie="0"]', 'k123456');
  await page.click('#mGuardar');
  await page.waitForSelector('.toast-erro >> text=já foi aplicado');
  for (const vp of MOVEIS) { await page.setViewportSize(vp); await semOverflow(page, 'material com série ' + vp.width); }
  await captura(page, 'material-serie-414');
  await page.fill('input[data-serie="0"]', 'K999888');
  await page.click('#mGuardar');
  await page.waitForSelector('.toast-ok >> text=Material registado.');
  igual((await fake(page, () => window.__fake.doc('series/K999888'))).estado, 'folha', 'nova série registada');
  semErros(page); await ctx.close();
});

teste('fase 3: regras — técnico não vê guias de outros nem mexe no stock; custo só Master', async () => {
  const { ctx, page } = await contexto();
  await entrar(page, 'tecnico2');
  const r = await page.evaluate(async () => {
    const out = {};
    try { await window.__fake.lerComoUtilizador('guias/g1'); out.g = 'lido'; } catch (e) { out.g = e.code; }
    try { await window.__fake.atualizarComoUtilizador('artigos/TC14', { stock: 999 }); out.s = 'ok'; } catch (e) { out.s = e.code; }
    try { await window.__fake.lerComoUtilizador('artigos/TC14/privado/custo'); out.c = 'lido'; } catch (e) { out.c = e.code; }
    return out;
  });
  igual(JSON.stringify(r), JSON.stringify({ g: 'permission-denied', s: 'permission-denied', c: 'permission-denied' }), 'recusas');
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
