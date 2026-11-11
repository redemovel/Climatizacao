// ===== core.js — código partilhado por todas as páginas (inserido pelo build.js) =====
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, createUserWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where, orderBy,
  limit, startAfter, startAt, endAt, serverTimestamp, Timestamp, runTransaction, writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const ENV = '@@ENV@@';          // 'prod' ou 'dev'
const BUILD = '@@BUILD@@';
const PAGINA = '@@PAGINA@@';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDFAu5HWTkNOMX79TGbk14HJ-37wywVUyA',
  authDomain: 'climatizacao-c482a.firebaseapp.com',
  projectId: 'climatizacao-c482a',
  storageBucket: 'climatizacao-c482a.firebasestorage.app',
  messagingSenderId: '31045556625',
  appId: '1:31045556625:web:a03ccd9fe4d2b141542230',
};

const fbApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fbApp);
auth.languageCode = 'pt';
// Cache local persistente: a agenda continua visível sem rede e poupa leituras repetidas.
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// ---------- Constantes de negócio ----------
const PERFIS = { master: 'Master', backoffice: 'Backoffice', tecnico: 'Técnico', comercial: 'Comercial' };
const ESTADOS = ['Por agendar', 'Agendada', 'Em curso', 'Pendente', 'Concluída', 'Revista', 'Aguarda NE', 'Faturada', 'Anulada'];
const ESTADOS_ABERTOS = ['Por agendar', 'Agendada', 'Em curso', 'Pendente'];
const ESTADOS_MASTER = ['Revista', 'Aguarda NE', 'Faturada', 'Anulada'];   // revisão, NE, faturação e anulação: só o Master
const DIAS_ATRASO = 60;   // «Em atraso» na agenda: só os últimos 60 dias; mais antigas vão para a lista de folhas antigas
const MOTIVOS_PENDENCIA = ['Peças', 'Orçamento', 'Cliente', 'Outro'];
const TIPOS = ['Instalação', 'Manutenção', 'AT'];
const TIPO_NOME = { 'Instalação': 'Instalação', 'Manutenção': 'Manutenção', AT: 'Assistência técnica' };
// Transições "normais" (botões principais). Têm de bater com firestore.rules.
const TRANSICOES = {
  'Por agendar': ['Agendada'],
  'Agendada': ['Em curso'],
  'Em curso': ['Pendente', 'Concluída'],
  'Pendente': ['Em curso', 'Agendada'],
  'Concluída': ['Revista'],
  'Revista': ['Aguarda NE', 'Faturada'],
  'Aguarda NE': ['Faturada'],
  'Faturada': [],
  'Anulada': [],
};
const TRANSICOES_TECNICO = {
  'Agendada': ['Em curso'],
  'Em curso': ['Pendente', 'Concluída'],
  'Pendente': ['Em curso'],
};
const PAGINA_TAM = 20;

const ehStaff = (p) => p === 'master' || p === 'backoffice';

// Estados para onde o perfil pode mudar a folha (o servidor valida o mesmo nas regras).
function transicoesPermitidas(perfil, estado) {
  if (perfil === 'tecnico') return TRANSICOES_TECNICO[estado] || [];
  if (perfil === 'master') return ESTADOS.filter((e) => e !== estado);
  if (perfil === 'backoffice') return ESTADOS_MASTER.includes(estado) ? [] : ESTADOS.filter((e) => e !== estado && !ESTADOS_MASTER.includes(e));
  return [];
}

// ---------- Utilitários ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pagina(nome, params) {
  let u = nome + (ENV === 'dev' ? '-dev' : '') + '.html';
  if (params) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
    if ([...q].length) u += '?' + q;
  }
  return u;
}

function paraData(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  return new Date(v);
}
const fmtData = (v, o = { day: '2-digit', month: '2-digit', year: 'numeric' }) => { const d = paraData(v); return d ? d.toLocaleDateString('pt-PT', o) : '—'; };
const fmtHora = (v) => { const d = paraData(v); return d ? d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) : ''; };
const fmtDataHora = (v) => { const d = paraData(v); return d ? fmtData(d) + ' ' + fmtHora(d) : '—'; };
const fmtDiaSemana = (d) => { const t = d.toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' }); return t.charAt(0).toUpperCase() + t.slice(1); };
function inicioDia(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDias(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function inicioSemana(d) { const x = inicioDia(d); const dow = (x.getDay() + 6) % 7; return addDias(x, -dow); } // segunda-feira
function isoLocal(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function deIsoLocal(s, hora = '00:00') { const [y, m, d] = s.split('-').map(Number); const [h, mi] = hora.split(':').map(Number); return new Date(y, m - 1, d, h || 0, mi || 0); }

function linkMapa(f) {
  const q = [f.morada, f.codigoPostal, f.localidade].filter(Boolean).join(', ');
  return q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : '';
}
const linkTel = (t) => (t ? 'tel:' + String(t).replace(/[^\d+]/g, '') : '');
const classeEstado = (e) => 'estado-' + String(e || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '-');
const badgeEstado = (e) => `<span class="badge ${classeEstado(e)}">${esc(e)}</span>`;

// NIF: português com dígito de controlo; estrangeiro com indicativo do país (ex.: ES B12345678).
function validarNIF(entrada) {
  const v = String(entrada || '').toUpperCase().replace(/[\s.\-/]/g, '');
  if (!v) return { ok: false, erro: 'O NIF é obrigatório.' };
  const pt = v.startsWith('PT') ? v.slice(2) : v;
  if (/^\d+$/.test(pt)) {
    if (pt.length !== 9) return { ok: false, erro: 'O NIF português tem 9 dígitos.' };
    if (!/^([1235689]|45|7[0-9])/.test(pt)) return { ok: false, erro: 'NIF português com início inválido.' };
    let soma = 0;
    for (let i = 0; i < 8; i++) soma += Number(pt[i]) * (9 - i);
    let ctrl = 11 - (soma % 11);
    if (ctrl >= 10) ctrl = 0;
    if (ctrl !== Number(pt[8])) return { ok: false, erro: 'NIF inválido (dígito de controlo errado).' };
    return { ok: true, nif: pt, pais: 'PT' };
  }
  const m = v.match(/^([A-Z]{2})([A-Z0-9]{2,13})$/);
  if (m && m[1] !== 'PT' && /\d/.test(m[2])) return { ok: true, nif: v, pais: m[1] };
  return { ok: false, erro: 'NIF inválido. Estrangeiro: indicativo do país + número (ex.: ES B12345678).' };
}

function erroFirebase(e) {
  const c = (e && e.code) || '';
  const mapa = {
    'auth/invalid-credential': 'Email ou palavra-passe incorretos.',
    'auth/wrong-password': 'Email ou palavra-passe incorretos.',
    'auth/user-not-found': 'Email ou palavra-passe incorretos.',
    'auth/invalid-email': 'Email inválido.',
    'auth/too-many-requests': 'Demasiadas tentativas. Aguarde uns minutos.',
    'auth/network-request-failed': 'Sem ligação à internet.',
    'auth/email-already-in-use': 'Já existe uma conta com este email.',
    'auth/user-disabled': 'Esta conta está desativada.',
    'permission-denied': 'Sem permissão para esta operação.',
    'unavailable': 'Sem ligação ao servidor. Tente de novo.',
    'failed-precondition': 'Falta um índice na base de dados (ver consola do browser).',
  };
  if (c === 'failed-precondition') console.error('[Firestore] índice em falta:', e.message);
  return mapa[c] || (e && e.message) || 'Erro inesperado.';
}

function toast(msg, tipo = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast toast-' + tipo;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// Modal genérico (folha inferior no telemóvel). Devolve o elemento do conteúdo.
function abrirModal(titulo, html, { aoFechar } = {}) {
  fecharModal();
  const fundo = document.createElement('div');
  fundo.className = 'modal-fundo';
  fundo.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(titulo)}">
    <div class="modal-topo"><h2>${esc(titulo)}</h2><button class="btn-icone" data-fechar aria-label="Fechar">✕</button></div>
    <div class="modal-corpo">${html}</div></div>`;
  fundo.addEventListener('click', (ev) => { if (ev.target === fundo || ev.target.closest('[data-fechar]')) { fecharModal(); aoFechar && aoFechar(); } });
  document.body.appendChild(fundo);
  document.body.classList.add('com-modal');
  return $('.modal-corpo', fundo);
}
function fecharModal() { $$('.modal-fundo').forEach((m) => m.remove()); document.body.classList.remove('com-modal'); }

function confirmar(msg, { ok = 'Confirmar', perigo = false } = {}) {
  return new Promise((resolve) => {
    const c = abrirModal('Confirmar', `<p>${esc(msg)}</p><div class="acoes">
      <button class="btn" data-r="0">Cancelar</button>
      <button class="btn ${perigo ? 'btn-perigo' : 'btn-primario'}" data-r="1">${esc(ok)}</button></div>`,
    { aoFechar: () => resolve(false) });
    c.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-r]');
      if (!b) return;
      fecharModal();
      resolve(b.dataset.r === '1');
    });
  });
}

async function comBotao(btn, fn) {
  if (btn.disabled) return;
  const txt = btn.textContent;
  btn.disabled = true; btn.classList.add('a-carregar');
  try { return await fn(); }
  finally { btn.disabled = false; btn.classList.remove('a-carregar'); btn.textContent = txt; }
}

// ---------- Sessão, cabeçalho e menu ----------
let SESSAO = null;

const ICONES = {
  agenda: '<svg viewBox="0 0 24 24"><path d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zM5 9h14v11H5zm2 2v2h2v-2zm4 0v2h2v-2zm4 0v2h2v-2z"/></svg>',
  folhas: '<svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5zM8 12v2h8v-2zm0 4v2h8v-2z"/></svg>',
  clientes: '<svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.3 0-8 1.7-8 5v1h16v-1c0-3.3-4.7-5-8-5z"/></svg>',
  orcamentos: '<svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6zm8 1.5V8h4.5zM9 12v1.6h8V12zm0 4v1.6h8V16zm0-8v1.6h4V8z"/></svg>',
  faturacao: '<svg viewBox="0 0 24 24"><path d="M5 2h14v20l-2.5-1.5L14 22l-2-1.5L10 22l-2.5-1.5L5 22zm3 5v1.6h8V7zm0 4v1.6h8V11zm0 4v1.6h5V15z"/></svg>',
  contratos: '<svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6zm8 1v5h5M9 12h8v1.5H9zm0 3h8v1.5H9zm0 3h5v1.5H9z"/></svg>',
  guias: '<svg viewBox="0 0 24 24"><path d="M1 5h13v11H1zm14 4h4l4 4v3h-8zM5 19.5a2 2 0 1 1 0-.01zm13 0a2 2 0 1 1 0-.01z"/></svg>',
  utilizadores: '<svg viewBox="0 0 24 24"><path d="M12 1 3 5v6c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V5zm0 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm0 8c2 0 6 1 6 3v.5A10 10 0 0 1 12 21a10 10 0 0 1-6-2.5V18c0-2 4-3 6-3z"/></svg>',
};
const MENU = [
  { id: 'agenda', label: 'Agenda', perfis: ['master', 'backoffice', 'tecnico'] },
  { id: 'folhas', label: 'Folhas de obra', curto: 'Folhas', perfis: ['master', 'backoffice', 'tecnico'] },
  { id: 'guias', label: 'Guias', perfis: ['master', 'backoffice', 'tecnico'] },
  { id: 'contratos', label: 'Contratos', perfis: ['master', 'backoffice'] },
  { id: 'clientes', label: 'Clientes', perfis: ['master', 'backoffice'] },
  { id: 'orcamentos', label: 'Orçamentos', curto: 'Orçam.', perfis: ['master'] },
  { id: 'faturacao', label: 'Faturação', perfis: ['master'] },
  { id: 'utilizadores', label: 'Utilizadores', curto: 'Utiliz.', perfis: ['master'] },
];

function montarCabecalho() {
  const nome = (SESSAO.nome || SESSAO.email || '').split(' ')[0];
  $('#topo').innerHTML = `
    <a class="marca" href="${pagina('agenda')}"><img src="img/arvore-branca.png" alt="">Climatização${ENV === 'dev' ? ' <span class="tag-dev">DEV</span>' : ''}</a>
    <div class="utilizador"><span class="u-nome">${esc(nome)}</span><span class="u-perfil">${esc(PERFIS[SESSAO.perfil] || SESSAO.perfil)}</span></div>
    <button class="btn-sair" id="btnSair" title="Terminar sessão">Sair</button>`;
  $('#btnSair').onclick = async () => { await signOut(auth); location.replace(pagina('index')); };
  $('#nav').innerHTML = MENU.filter((m) => m.perfis.includes(SESSAO.perfil)).map((m) =>
    `<a href="${pagina(m.id)}" class="${m.id === PAGINA ? 'ativo' : ''}" data-menu="${m.id}">${ICONES[m.id]}<span>${esc(m.curto || m.label)}</span></a>`).join('');
}

// Garante sessão iniciada com perfil ativo. Sem sessão → login. Sem perfil → login (mostra o UID).
function iniciarPagina({ perfis = null } = {}) {
  return new Promise((resolve) => {
    let feito = false;
    onAuthStateChanged(auth, async (user) => {
      if (feito) return;
      feito = true;
      if (!user) { location.replace(pagina('index')); return; }
      try {
        const snap = await getDoc(doc(db, 'utilizadores', user.uid));
        if (!snap.exists() || snap.data().ativo !== true) { location.replace(pagina('index')); return; }
        SESSAO = { uid: user.uid, email: user.email, ...snap.data() };
      } catch (e) {
        $('#main').innerHTML = `<div class="vazio">Não foi possível carregar o perfil: ${esc(erroFirebase(e))}</div>`;
        return;
      }
      montarCabecalho();
      if (perfis && !perfis.includes(SESSAO.perfil)) {
        $('#main').innerHTML = '<div class="vazio">Não tem acesso a esta página.</div>';
        return;
      }
      document.body.classList.add('perfil-' + SESSAO.perfil);
      resolve(SESSAO);
    });
  });
}

// ---------- Pesquisa de clientes ----------
// Cada cliente guarda `pesquisa`: prefixos (2+ letras) de cada palavra do nome e da localidade.
// Assim "hot" encontra "Hotel Meliá" e "meli" também, com uma só consulta (array-contains).
const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function tokensPesquisa(...textos) {
  const set = new Set();
  for (const t of textos) {
    for (const p of normalizar(t).split(/[^a-z0-9]+/)) {
      for (let i = 2; i <= Math.min(p.length, 15); i++) set.add(p.slice(0, i));
    }
  }
  return [...set];
}

async function pesquisarClientes(texto, { soAtivos = false } = {}) {
  const t = String(texto || '').trim();
  const n = validarNIF(t);
  const palavras = normalizar(t).split(/[^a-z0-9]+/).filter((p) => p.length >= 2).map((p) => p.slice(0, 15));
  let docs = [];
  if (n.ok) {
    docs = (await getDocs(query(collection(db, 'clientes'), where('nif', '==', n.nif), limit(10)))).docs;
  } else {
    const consultas = [];
    if (palavras.length) {
      const chave = palavras.reduce((a, b) => (b.length > a.length ? b : a));
      consultas.push(getDocs(query(collection(db, 'clientes'), where('pesquisa', 'array-contains', chave), limit(PAGINA_TAM)))
        .then((sn) => sn.docs.filter((d) => palavras.every((p) => (d.data().pesquisa || []).includes(p)))));
    }
    // início do nome, também para siglas («M. D.», «MDA» → «m. d. a. - moldes…» / «m.d.a.»)
    for (const pre of prefixosNome(t)) {
      consultas.push(getDocs(query(collection(db, 'clientes'), orderBy('nomePesquisa'), startAt(pre), endAt(pre + '\uf8ff'), limit(PAGINA_TAM))).then((sn) => sn.docs));
    }
    const vistos = new Set();
    for (const l of await Promise.all(consultas)) for (const d of l) if (!vistos.has(d.id)) { vistos.add(d.id); docs.push(d); }
  }
  return docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((c) => !soAtivos || c.ativo !== false)
    .sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt'));
}
function prefixosNome(t) {
  const base = normalizar(t).replace(/\s+/g, ' ').trim();
  if (base.length < 2) return [];
  const l = new Set([base]);
  const letras = base.replace(/[^a-z0-9]/g, '');
  // parece uma sigla: letras soltas com pontos/espaços, ou uma palavra curta
  if (letras.length >= 2 && letras.length <= 5 && (/^([a-z0-9][. ]*)+$/.test(base) && (base.includes('.') || base.includes(' ') || letras.length <= 4))) {
    const c = letras.split('');
    l.add(c.join('. ') + '.'); l.add(c.join('.') + '.'); l.add(c.join(' '));
  }
  return [...l].slice(0, 4);
}

// ---------- Duração prevista: real (mediana do PHC, calculada pela PontePHC em listas/duracoes) ou por omissão ----------
// duração habitual de um tipo, sem esperar (depois de duracaoSugerida já ter sido chamada uma vez)
function duracaoTipo(tipo) {
  const t = ((_duracoesDados || {}).porTipo || {})[tipo];
  return t && t.n >= 5 ? t.h : (DURACAO_PADRAO[tipo] || 2);
}
const fmtHorasD = (h) => String(Number(h) || 0).replace('.', ',') + ' h';
const DURACAO_PADRAO = { AT: 2, 'Manutenção': 1.5, 'Instalação': 4 };
let _duracoes = null, _duracoesDados = null;
async function duracaoSugerida(clienteId, tipo) {
  if (!_duracoes) {
    _duracoes = getDoc(doc(db, 'listas', 'duracoes')).then((s) => (s.exists() ? s.data() : {})).catch(() => ({}));
  }
  const d = await _duracoes;
  _duracoesDados = d;
  const c = ((d.porCliente || {})[clienteId] || {})[tipo];
  if (c && c.n >= 2) return { h: c.h, n: c.n, fonte: 'cliente' };
  const t = (d.porTipo || {})[tipo];
  if (t && t.n >= 5) return { h: t.h, n: t.n, fonte: 'tipo' };
  return { h: DURACAO_PADRAO[tipo] || 2, n: 0, fonte: 'padrao' };
}

// ---------- Emails ao cliente: cabeçalho sóbrio com a cor Arpuro (RGB 0·134·137, Pantone 321C) ----------
const COR_ARPURO = '#008689';
function cabecalhoEmail(subtitulo) {
  const e = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-bottom:3px solid ${COR_ARPURO}"><tr>
    <td style="font-family:Arial,Helvetica,sans-serif;padding:14px 18px 10px"><span style="font-size:22px;font-weight:bold;letter-spacing:2px;color:${COR_ARPURO}">ARPURO</span>
      <span style="font-size:13px;color:#64748b;white-space:nowrap">&nbsp;Climatização e Ventilação</span>
      <div style="font-size:14px;color:#334155;margin-top:4px">${e(subtitulo)}</div></td></tr></table>`;
}

// ---------- Artigos (stock do armazém da climatização, vindo do PHC) ----------
// disponível = stock − reservado em FO abertas no PHC − ainda em guias abertas no PHC
//              − reservado em folhas da plataforma − em guias abertas da plataforma
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
function disponivel(a) {
  return r3((a.stock || 0) - (a.reservadoPHC || 0) - (a.emGuiasPHC || 0) - (a.resFolhas || 0) - (a.resGuias || 0));
}
const fmtQtd = (n) => r3(n).toLocaleString('pt-PT', { maximumFractionDigits: 3 });
async function pesquisarArtigos(texto) {
  const palavras = normalizar(texto).split(/[^a-z0-9]+/).filter((p) => p.length >= 2).map((p) => p.slice(0, 15));
  if (!palavras.length) return [];
  const chave = palavras.reduce((a, b) => (b.length > a.length ? b : a));
  const snap = await getDocs(query(collection(db, 'artigos'), where('pesquisa', 'array-contains', chave), limit(PAGINA_TAM)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((a) => a.ativo !== false && palavras.every((p) => (a.pesquisa || []).includes(p)))
    .sort((a, b) => disponivel(b) - disponivel(a) || (a.ref || '').localeCompare(b.ref || ''));
}
// Acumula movimentos de reserva por artigo e aplica-os dentro de uma transação (lê primeiro, escreve depois).
// mov: { artigoId: { resFolhas: +x, resGuias: -y } }; exigeDisponivel: artigos que não podem ficar negativos.
async function aplicarReservas(tx, mov, exigeDisponivel = new Set()) {
  const ids = Object.keys(mov);
  const docs = {};
  for (const id of ids) {
    const s = await tx.get(doc(db, 'artigos', id));
    if (!s.exists()) throw Object.assign(new Error('Artigo não encontrado: ' + id), { code: 'artigo' });
    docs[id] = s.data();
  }
  return () => {
    for (const id of ids) {
      const a = docs[id];
      const novo = { resFolhas: r3((a.resFolhas || 0) + (mov[id].resFolhas || 0)), resGuias: r3((a.resGuias || 0) + (mov[id].resGuias || 0)) };
      if (novo.resFolhas < 0) novo.resFolhas = 0;
      if (novo.resGuias < 0) novo.resGuias = 0;
      if (exigeDisponivel.has(id) && disponivel({ ...a, ...novo }) < -0.0005) {
        throw Object.assign(new Error(`Sem stock disponível de ${a.ref} (disponível: ${fmtQtd(disponivel(a))} ${a.unidade || ''}).`), { code: 'stock' });
      }
      tx.update(doc(db, 'artigos', id), { ...novo, resAtualizadoEm: serverTimestamp() });
    }
  };
}
// N.º de série → id do documento em series/ (maiúsculas, sem espaços; «/» e outros trocados por ~XX)
function idSerie(sr) {
  return String(sr || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9._-]/g, (c) => '~' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}
function limparSerie(sr) { return String(sr || '').trim().toUpperCase().replace(/\s+/g, ''); }

// Procura um n.º de série: onde está a ser usado na plataforma (series/) e, se estiver no armazém AC do PHC
// (equipamentos/, vindo da tabela MA pela PontePHC), o artigo a que pertence. Só a pedido (2–3 leituras).
async function procurarSerie(texto) {
  const t = limparSerie(texto);
  if (t.length < 3 || /\s/.test(String(texto).trim())) return null;
  const id = idSerie(t);
  const [so, se] = await Promise.all([getDoc(doc(db, 'series', id)), getDoc(doc(db, 'equipamentos', id)).catch(() => null)]);
  const r = { serie: t, uso: so.exists() ? so.data() : null, equip: se && se.exists() ? se.data() : null, artigo: null };
  if (r.equip) r.serie = r.equip.serie || t;
  if (r.equip && r.equip.artigoId) {
    try { const a = await getDoc(doc(db, 'artigos', r.equip.artigoId)); if (a.exists()) r.artigo = { id: a.id, ...a.data() }; } catch (e) { /* sem artigo */ }
  }
  return r.uso || r.equip ? r : null;
}

// Ao faturar/anular uma folha, o material dela deixa de estar reservado na plataforma.
function movLibertarFolha(f) {
  const mov = {};
  for (const m of f.materiais || []) if (m.artigoId) (mov[m.artigoId] = mov[m.artigoId] || { resFolhas: 0 }).resFolhas -= Number(m.qtd) || 0;
  return mov;
}

// ---------- «Sincronizar com o PHC agora» (staff): a PontePHC vê o pedido em ~30 s e corre um ciclo completo ----------
async function pedirSincronizacao(btn, aoConcluir) {
  await comBotao(btn, async () => {
    const ref = doc(db, 'controlo', 'sincronizar');
    try {
      await setDoc(ref, { estado: 'Pedido', pedidoEm: serverTimestamp(), pedidoPor: SESSAO.uid, pedidoPorNome: SESSAO.nome || SESSAO.email });
    } catch (e) { toast(erroFirebase(e), 'erro'); return; }
    toast('Pedido enviado ao servidor. A sincronização demora 1 a 2 minutos…', 'ok', 6000);
    for (let i = 0; i < 24; i++) {   // até 4 minutos, uma leitura a cada 10 s
      await new Promise((r) => setTimeout(r, 10000));
      let d;
      try { d = (await getDoc(ref)).data() || {}; } catch (e) { continue; }
      if (d.estado === 'Concluído') {
        toast('Sincronização com o PHC concluída' + (d.resultado && d.resultado !== 'OK' ? ': ' + d.resultado : '.'), d.resultado === 'OK' ? 'ok' : 'erro', 6000);
        if (aoConcluir) aoConcluir();
        return;
      }
    }
    toast('O servidor ainda não respondeu. Confirme que o serviço PontePHC está a correr.', 'erro', 8000);
  });
}

// ---------- Folhas de obra: criação (partilhada pela página Folhas e pela geração dos contratos) ----------
// Prefixos para a pesquisa (n.º, cliente, NIF, avaria) — iguais aos que a PontePHC grava nas folhas do PHC.
function tokensFolha(numero, clienteNome, nif, descricao) {
  const n = String(numero || '');
  return tokensPesquisa(n, n.split('-').pop().replace(/^0+/, ''), clienteNome, String(nif || '').replace(/\D/g, ''), descricao).slice(0, 400);
}
// Numeração FO-AAAA-NNNN no contador do ano; toda a folha nova nasce «Por agendar». extraTx(tx, fRef, numero) corre na mesma transação.
async function criarFolhaNova(cliente, dados, extraTx = null) {
  const ano = new Date().getFullYear();
  const cRef = doc(db, 'contadores', 'folhas-' + ano);
  const fRef = doc(collection(db, 'folhas'));
  let numero = '';
  await runTransaction(db, async (tx) => {
    const c = await tx.get(cRef);
    const pre = extraTx ? await extraTx(tx, null, null) : null;   // leituras extra (antes das escritas)
    const n = (c.exists() ? c.data().valor : 0) + 1;
    numero = `FO-${ano}-${String(n).padStart(4, '0')}`;
    tx.set(cRef, { valor: n });
    tx.set(fRef, {
      ...dados,
      numero,
      clienteId: cliente.id, clienteNome: cliente.nome, clienteNif: cliente.nif || '', clienteEmail: dados.clienteEmail || cliente.email || '',
      pesquisa: tokensFolha(numero, cliente.nome, cliente.nif, dados.descricao),
      estado: 'Por agendar',
      historico: [{ estado: 'Por agendar', de: null, uid: SESSAO.uid, nome: SESSAO.nome || SESSAO.email, em: Timestamp.now(), ...(dados.contratoId ? { nota: 'Gerada pelo contrato ' + dados.contratoNumero } : {}) }],
      observacoesTecnico: '',
      criadoEm: serverTimestamp(), criadoPor: SESSAO.uid, criadoPorNome: SESSAO.nome || SESSAO.email,
      estadoAlteradoEm: serverTimestamp(),
    });
    if (pre) pre(fRef, numero);
  });
  return fRef.id;
}

// ---------- Contratos de manutenção ----------
const PERIODICIDADES = { Mensal: 1, Bimestral: 2, Trimestral: 3, Semestral: 6, Anual: 12 };
function addMeses(d, n) {
  const x = new Date(d);
  const dia = x.getDate();
  x.setDate(1); x.setMonth(x.getMonth() + n);
  const ult = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(dia, ult));
  return x;
}
// Quando gerar a folha da visita: «antecedência» dias antes da data da visita.
function dataGeracao(proxima, antecedencia) { return addDias(inicioDia(proxima), -(Number(antecedencia) || 0)); }
function descricaoVisita(ct) {
  const eq = (ct.equipamentos || []).map((e) => [e.descricao, e.marca, e.serie ? 'n.º ' + e.serie : '', e.local].filter(Boolean).join(' · '));
  return [`Manutenção ${String(ct.periodicidade || '').toLowerCase()} — contrato ${ct.numero}.`, ct.ambito || '', eq.length ? 'Equipamentos:\n- ' + eq.join('\n- ') : '']
    .filter(Boolean).join('\n');
}
// Gera a folha da próxima visita de um contrato e avança a próxima data, numa só transação (nunca duplica).
async function gerarVisitaContrato(ctId, { forcar = false } = {}) {
  const ctRef = doc(db, 'contratos', ctId);
  const ct0 = (await getDoc(ctRef)).data();
  if (!ct0 || ct0.estado !== 'Ativo' || !ct0.proximaData) return null;
  const prox = paraData(ct0.proximaData);
  if (!forcar && dataGeracao(prox, ct0.antecedenciaDias) > new Date()) return null;
  if (ct0.dataFim && prox > paraData(ct0.dataFim) && !ct0.renovacaoAutomatica) return null;
  const [h, m] = String(ct0.horaPreferida || '09:00').split(':').map(Number);
  const quando = new Date(prox); quando.setHours(h || 9, m || 0, 0, 0);
  const cliente = { id: ct0.clienteId, nome: ct0.clienteNome, nif: ct0.clienteNif || '', email: ct0.clienteEmail || '' };
  const dados = {
    tipo: 'Manutenção', tecnicoUid: ct0.tecnicoUid || '', tecnicoNome: ct0.tecnicoNome || '',
    dataPrevista: Timestamp.fromDate(quando), duracaoPrevista: Number(ct0.duracaoPrevista) || 0,
    morada: ct0.morada || '', codigoPostal: ct0.codigoPostal || '', localidade: ct0.localidade || '', contacto: ct0.contacto || '', telefone: ct0.telefone || '',
    descricao: descricaoVisita(ct0), tarefasExtra: (ct0.tarefas || []).slice(0, 30),
    origem: 'contrato', contratoId: ctId, contratoNumero: ct0.numero, atualizadoEm: serverTimestamp(), atualizadoPor: SESSAO.uid,
  };
  let gerada = null;
  const id = await criarFolhaNova(cliente, dados, async (tx) => {
    const s = await tx.get(ctRef);
    const ct = s.data();
    // outro utilizador gerou entretanto?
    if (!ct || ct.estado !== 'Ativo' || !ct.proximaData || paraData(ct.proximaData).getTime() !== prox.getTime()) throw Object.assign(new Error('já gerada'), { code: 'ja-gerada' });
    return (fRef, numero) => {
      let nova = addMeses(prox, PERIODICIDADES[ct.periodicidade] || 12);
      const alt = { proximaData: Timestamp.fromDate(nova), geracaoEm: Timestamp.fromDate(dataGeracao(nova, ct.antecedenciaDias)),
        ultimaVisita: Timestamp.fromDate(prox), atualizadoEm: serverTimestamp(), atualizadoPor: SESSAO.uid,
        folhas: [{ folhaId: fRef.id, numero, data: Timestamp.fromDate(quando) }, ...(ct.folhas || [])].slice(0, 24) };
      // fim do contrato: renova por mais um ano, ou deixa de gerar
      if (ct.dataFim && nova > paraData(ct.dataFim)) {
        if (ct.renovacaoAutomatica) alt.dataFim = Timestamp.fromDate(addMeses(paraData(ct.dataFim), 12));
        else alt.geracaoEm = Timestamp.fromDate(new Date(2999, 0, 1));
      }
      tx.update(ctRef, alt);
      gerada = numero;
    };
  }).catch((e) => { if (e.code === 'ja-gerada') return null; throw e; });
  return id ? { id, numero: gerada } : null;
}
// Gera todas as visitas em falta (contratos ativos com data de geração já passada). Corre ao abrir as páginas (staff), no máx. 1 vez por hora neste aparelho.
async function gerarManutencoesPendentes({ forcar = false } = {}) {
  if (!ehStaff(SESSAO.perfil)) return [];
  const chave = 'manut.ultima.' + SESSAO.uid;
  try { if (!forcar && Date.now() - Number(localStorage.getItem(chave) || 0) < 3600e3) return []; } catch (e) { /* sem storage */ }
  const feitas = [];
  try {
    for (let volta = 0; volta < 3; volta++) {   // até 3 visitas em atraso por contrato
      const snap = await getDocs(query(collection(db, 'contratos'), where('estado', '==', 'Ativo'), where('geracaoEm', '<=', Timestamp.now()), orderBy('geracaoEm'), limit(20)));
      if (snap.empty) break;
      let nesta = 0;
      for (const d of snap.docs) { const r = await gerarVisitaContrato(d.id); if (r) { feitas.push(r); nesta++; } }
      if (!nesta) break;
    }
    try { localStorage.setItem(chave, String(Date.now())); } catch (e) { /* sem storage */ }
  } catch (e) { console.warn('Contratos:', e); }
  return feitas;
}

// Lista de técnicos ativos (coleção pequena; lida uma vez por página).
let _tecnicos = null;
async function carregarTecnicos() {
  if (_tecnicos) return _tecnicos;
  const col = collection(db, 'utilizadores');
  const [a, b] = await Promise.all([
    getDocs(query(col, where('perfil', '==', 'tecnico'), where('ativo', '==', true), limit(50))),
    getDocs(query(col, where('tecnico', '==', true), where('ativo', '==', true), limit(50))),
  ]);
  const mapa = new Map();
  for (const d of [...a.docs, ...b.docs]) mapa.set(d.id, { uid: d.id, ...d.data() });
  _tecnicos = [...mapa.values()].sort((x, y) => (x.nome || '').localeCompare(y.nome || '', 'pt'));
  return _tecnicos;
}
