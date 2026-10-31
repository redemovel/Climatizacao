#!/usr/bin/env node
// build.js — gera as páginas de produção ([modulo].html) e desenvolvimento ([modulo]-dev.html)
// a partir da mesma base em src/.
//
//   node build.js          → gera produção e dev
//   node build.js --dev    → gera só as versões -dev (alterações só para testes)
//   node build.js --prod   → gera só produção
//
// Nunca editar os .html da raiz à mão: são sobrescritos pelo build.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const PAGINAS = ['index', 'agenda', 'folhas', 'clientes', 'utilizadores'];

const args = process.argv.slice(2);
let envs = ['prod', 'dev'];
if (args.includes('--dev')) envs = ['dev'];
if (args.includes('--prod')) envs = ['prod'];

const ler = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const layout = ler('layout.html');
const core = ler('shared/core.js');
const css = ler('shared/style.css');
const build = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function substituir(txt, mapa) {
  // função de substituição para não interpretar padrões $ do String.replace
  for (const [k, v] of Object.entries(mapa)) txt = txt.split(k).join(v);
  return txt;
}

const gerados = [];
for (const nome of PAGINAS) {
  const corpo = ler(`pages/${nome}.html`);
  const js = ler(`pages/${nome}.js`);
  const mTitulo = corpo.match(/<!--\s*titulo:\s*(.+?)\s*-->/);
  const titulo = mTitulo ? mTitulo[1] : nome;
  for (const env of envs) {
    let html = substituir(layout, {
      '{{TITULO}}': titulo + (env === 'dev' ? ' [DEV]' : ''),
      '{{CSS}}': css,
      '{{CORPO}}': corpo,
      '{{SCRIPT}}': core + '\n// ===== página: ' + nome + ' =====\n' + js,
    });
    html = substituir(html, { '@@ENV@@': env, '@@BUILD@@': build, '@@PAGINA@@': nome });
    const saida = nome + (env === 'dev' ? '-dev' : '') + '.html';
    fs.writeFileSync(path.join(ROOT, saida), html);
    gerados.push(saida);
  }
}
console.log('Gerado (' + build + '): ' + gerados.join(', '));
