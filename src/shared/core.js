// ===== core.js — código partilhado por todas as páginas (inserido pelo build.js) =====
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, createUserWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where, orderBy,
  limit, startAfter, serverTimestamp, Timestamp, runTransaction,
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
const ESTADOS = ['Agendada', 'Em curso', 'Pendente material', 'Concluída', 'Faturada'];
const ESTADOS_ABERTOS = ['Agendada', 'Em curso', 'Pendente material'];
const TIPOS = ['Instalação', 'Manutenção', 'AT'];
const TIPO_NOME = { 'Instalação': 'Instalação', 'Manutenção': 'Manutenção', AT: 'Assistência técnica' };
// Transições "normais" (botões principais). Têm de bater com firestore.rules.
const TRANSICOES = {
  'Agendada': ['Em curso'],
  'Em curso': ['Pendente material', 'Concluída'],
  'Pendente material': ['Em curso'],
  'Concluída': ['Faturada'],
  'Faturada': [],
};
const PAGINA_TAM = 20;

const ehStaff = (p) => p === 'master' || p === 'backoffice';

// Estados para onde o perfil pode mudar a folha (o servidor valida o mesmo nas regras).
function transicoesPermitidas(perfil, estado) {
  if (perfil === 'tecnico') return (TRANSICOES[estado] || []).filter((e) => e !== 'Faturada');
  if (perfil === 'master') return ESTADOS.filter((e) => e !== estado);
  if (perfil === 'backoffice') return estado === 'Faturada' ? [] : ESTADOS.filter((e) => e !== estado);
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
  utilizadores: '<svg viewBox="0 0 24 24"><path d="M12 1 3 5v6c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V5zm0 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm0 8c2 0 6 1 6 3v.5A10 10 0 0 1 12 21a10 10 0 0 1-6-2.5V18c0-2 4-3 6-3z"/></svg>',
};
const MENU = [
  { id: 'agenda', label: 'Agenda', perfis: ['master', 'backoffice', 'tecnico'] },
  { id: 'folhas', label: 'Folhas de obra', curto: 'Folhas', perfis: ['master', 'backoffice', 'tecnico'] },
  { id: 'clientes', label: 'Clientes', perfis: ['master', 'backoffice'] },
  { id: 'utilizadores', label: 'Utilizadores', perfis: ['master'] },
];

function montarCabecalho() {
  const nome = (SESSAO.nome || SESSAO.email || '').split(' ')[0];
  $('#topo').innerHTML = `
    <a class="marca" href="${pagina('agenda')}">Climatização${ENV === 'dev' ? ' <span class="tag-dev">DEV</span>' : ''}</a>
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

async function pesquisarClientes(texto) {
  const t = String(texto || '').trim();
  const n = validarNIF(t);
  let snap;
  if (n.ok) {
    snap = await getDocs(query(collection(db, 'clientes'), where('nif', '==', n.nif), limit(10)));
  } else {
    const palavras = normalizar(t).split(/[^a-z0-9]+/).filter((p) => p.length >= 2).map((p) => p.slice(0, 15));
    if (!palavras.length) return [];
    const chave = palavras.reduce((a, b) => (b.length > a.length ? b : a));
    snap = await getDocs(query(collection(db, 'clientes'), where('pesquisa', 'array-contains', chave), limit(PAGINA_TAM)));
  }
  const palavras = normalizar(t).split(/[^a-z0-9]+/).filter((p) => p.length >= 2).map((p) => p.slice(0, 15));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((c) => n.ok || palavras.every((p) => (c.pesquisa || []).includes(p)))
    .sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt'));
}

// Lista de técnicos ativos (coleção pequena; lida uma vez por página).
let _tecnicos = null;
async function carregarTecnicos() {
  if (_tecnicos) return _tecnicos;
  const snap = await getDocs(query(collection(db, 'utilizadores'), where('perfil', '==', 'tecnico'), where('ativo', '==', true), limit(50)));
  _tecnicos = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt'));
  return _tecnicos;
}
