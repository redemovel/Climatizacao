// Simulação de firebase-firestore.js (só para testes).
// - Dados em localStorage['__fake_db'] (mapa caminho → documento), persistem entre páginas.
// - Conta leituras em localStorage['__fake_reads'] (1 por documento devolvido, mínimo 1 por consulta).
// - Recusa consultas que no Firestore real exigiriam um índice composto não declarado
//   em firestore.indexes.json (window.__fakeIndexes, injetado pelo teste).
// - Emula as regras de segurança principais (aproximação de firestore.rules) para apanhar
//   consultas/escritas que o servidor recusaria.
const LS_DB = '__fake_db';
const LS_READS = '__fake_reads';
const LS_WRITES = '__fake_writes';
const ATRASO = 15;

const erro = (code, msg) => Object.assign(new Error(msg || code), { code });
const espera = () => new Promise((r) => setTimeout(r, ATRASO));

// ---------- Timestamp e sentinelas ----------
export class Timestamp {
  constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
  static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), Math.round((ms - Math.floor(ms / 1000) * 1000) * 1e6)); }
  static now() { return Timestamp.fromMillis(Date.now()); }
  toDate() { return new Date(this.toMillis()); }
  toMillis() { return this.seconds * 1000 + Math.round(this.nanoseconds / 1e6); }
  isEqual(o) { return o instanceof Timestamp && o.toMillis() === this.toMillis(); }
  valueOf() { return String(this.toMillis()).padStart(16, '0'); }
}
const SENT = '__sentinela';
export const serverTimestamp = () => ({ [SENT]: 'serverTimestamp' });
export const arrayUnion = (...v) => ({ [SENT]: 'arrayUnion', v });
export const increment = (n) => ({ [SENT]: 'increment', n });
export const deleteField = () => ({ [SENT]: 'delete' });

// ---------- (de)serialização ----------
function cod(v) {
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (v instanceof Date) return { __ts: v.getTime() };
  if (Array.isArray(v)) return v.map(cod);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = cod(v[k]); return o; }
  return v;
}
function dec(v) {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === 'object') {
    if ('__ts' in v && Object.keys(v).length === 1) return Timestamp.fromMillis(v.__ts);
    const o = {}; for (const k in v) o[k] = dec(v[k]); return o;
  }
  return v;
}
function resolverSentinelas(novo, antigo, agora) {
  const out = {};
  for (const k in novo) {
    const v = novo[k];
    if (v && v[SENT] === 'serverTimestamp') out[k] = agora;
    else if (v && v[SENT] === 'arrayUnion') { const base = (antigo && antigo[k]) || []; out[k] = [...base, ...v.v.filter((x) => !base.some((b) => JSON.stringify(cod(b)) === JSON.stringify(cod(x))))]; }
    else if (v && v[SENT] === 'increment') out[k] = ((antigo && antigo[k]) || 0) + v.n;
    else if (v && v[SENT] === 'delete') out[k] = undefined;
    else {
      if (Array.isArray(v) && v.some((x) => x && x[SENT])) throw erro('invalid-argument', 'serverTimestamp() não é suportado dentro de arrays.');
      out[k] = v;
    }
  }
  return out;
}

const lerDB = () => { try { return JSON.parse(localStorage.getItem(LS_DB)) || {}; } catch { return {}; } };
const gravarDB = (d) => localStorage.setItem(LS_DB, JSON.stringify(d));
const contarLeituras = (n) => localStorage.setItem(LS_READS, String(Number(localStorage.getItem(LS_READS) || 0) + n));
const contarEscritas = (n) => localStorage.setItem(LS_WRITES, String(Number(localStorage.getItem(LS_WRITES) || 0) + n));

// ---------- Instância ----------
export function initializeFirestore(app, settings) { return { type: 'firestore', app, settings }; }
export function getFirestore(app) { return { type: 'firestore', app }; }
export const persistentLocalCache = (o) => ({ kind: 'persistent', ...o });
export const persistentMultipleTabManager = () => ({ kind: 'multiTab' });
export const memoryLocalCache = () => ({ kind: 'memory' });

// ---------- Referências ----------
const novoId = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('').slice(0, 20);
function juntar(base, segs) { return [base, ...segs].filter(Boolean).join('/').replace(/\/+/g, '/'); }
function refDoc(path) {
  const partes = path.split('/');
  return { type: 'document', path, id: partes[partes.length - 1], parent: { type: 'collection', path: partes.slice(0, -1).join('/'), id: partes[partes.length - 2] } };
}
export function collection(base, ...segs) {
  const path = juntar(base.type === 'firestore' ? '' : base.path, segs);
  return { type: 'collection', path, id: path.split('/').pop() };
}
export function doc(base, ...segs) {
  if (base.type === 'collection' && segs.length === 0) return refDoc(base.path + '/' + novoId());
  return refDoc(juntar(base.type === 'firestore' ? '' : base.path, segs));
}

// ---------- Consultas ----------
export const where = (campo, op, valor) => ({ k: 'where', campo, op, valor });
export const orderBy = (campo, dir = 'asc') => ({ k: 'orderBy', campo, dir });
export const limit = (n) => ({ k: 'limit', n });
export const startAfter = (cur) => ({ k: 'startAfter', cur });
export function query(ref, ...cs) {
  const base = ref.type === 'query' ? ref : { type: 'query', path: ref.path, cs: [] };
  return { type: 'query', path: base.path, cs: [...base.cs, ...cs] };
}

function cmp(a, b) {
  const n = (v) => (v instanceof Timestamp ? v.toMillis() : v);
  a = n(a); b = n(b);
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : 1;
  return a < b ? -1 : 1;
}
function testa(v, op, x) {
  const n = (y) => (y instanceof Timestamp ? y.toMillis() : y);
  switch (op) {
    case '==': return n(v) === n(x);
    case '!=': return n(v) !== n(x);
    case '<': return v != null && cmp(v, x) < 0;
    case '<=': return v != null && cmp(v, x) <= 0;
    case '>': return v != null && cmp(v, x) > 0;
    case '>=': return v != null && cmp(v, x) >= 0;
    case 'in': return x.some((y) => n(y) === n(v));
    case 'not-in': return !x.some((y) => n(y) === n(v));
    case 'array-contains': return Array.isArray(v) && v.some((y) => n(y) === n(x));
    case 'array-contains-any': return Array.isArray(v) && v.some((y) => x.some((z) => n(z) === n(y)));
    default: throw erro('invalid-argument', 'Operador ' + op);
  }
}

// Verifica se a consulta precisaria de um índice composto e se ele está declarado.
function verificarIndice(colecao, cs) {
  const ws = cs.filter((c) => c.k === 'where');
  const ords = cs.filter((c) => c.k === 'orderBy');
  const igual = ws.filter((w) => ['==', 'in'].includes(w.op)).map((w) => w.campo);
  const arr = ws.filter((w) => w.op.startsWith('array-contains')).map((w) => w.campo);
  const desig = [...new Set(ws.filter((w) => ['<', '<=', '>', '>=', '!=', 'not-in'].includes(w.op)).map((w) => w.campo))];
  if (desig.length > 1) throw erro('invalid-argument', 'Desigualdades em mais de um campo.');
  if (desig.length && ords.length && ords[0].campo !== desig[0]) throw erro('invalid-argument', 'O primeiro orderBy tem de ser o campo da desigualdade (' + desig[0] + ').');
  const ordem = ords.length ? ords.map((o) => ({ campo: o.campo, dir: o.dir })) : desig.map((c) => ({ campo: c, dir: 'asc' }));
  const todos = new Set([...igual, ...arr, ...ordem.map((o) => o.campo)]);
  if (todos.size <= 1) return;
  if (!ordem.length) return; // só igualdades: o Firestore junta índices simples
  const idx = (window.__fakeIndexes || []).filter((i) => i.collectionGroup === colecao);
  const ok = idx.some((i) => {
    const f = i.fields;
    const nEq = igual.length + arr.length;
    if (f.length !== nEq + ordem.length) return false;
    const pre = f.slice(0, nEq);
    const preOk = pre.every((x) => (arr.includes(x.fieldPath) ? x.arrayConfig === 'CONTAINS' : igual.includes(x.fieldPath)))
      && new Set(pre.map((x) => x.fieldPath)).size === nEq;
    const posOk = f.slice(nEq).every((x, j) => x.fieldPath === ordem[j].campo && x.order === (ordem[j].dir === 'desc' ? 'DESCENDING' : 'ASCENDING'));
    return preOk && posOk;
  });
  if (!ok) {
    const desc = [...igual.map((c) => c + ' ASC'), ...arr.map((c) => c + ' CONTAINS'), ...ordem.map((o) => o.campo + ' ' + o.dir.toUpperCase())].join(', ');
    throw erro('failed-precondition', `The query requires an index (${colecao}: ${desc}). Falta em firestore.indexes.json.`);
  }
}

// ---------- Emulação das regras (aproximação de firestore.rules) ----------
function sessaoAtual(db) {
  const uid = localStorage.getItem('__fake_auth_cur');
  if (!uid) return { uid: null, perfil: null };
  const p = db['utilizadores/' + uid];
  return { uid, perfil: p && p.ativo === true ? p.perfil : null };
}
const STAFF = ['master', 'backoffice'];
const TRANS_TEC = { 'Agendada': ['Em curso'], 'Em curso': ['Pendente material', 'Concluída'], 'Pendente material': ['Em curso'] };
const negar = (m) => { throw erro('permission-denied', 'Missing or insufficient permissions. (' + m + ')'); };

function regraLer(dbRaw, colecao, id, docRaw, consulta) {
  const s = sessaoAtual(dbRaw);
  if (!s.uid) negar('sem sessão');
  if (colecao === 'utilizadores') {
    if (!consulta && id === s.uid) return;
    if (STAFF.includes(s.perfil)) return;
    negar('utilizadores');
  }
  if (!s.perfil) negar('sem perfil ativo');
  if (STAFF.includes(s.perfil)) return;
  if (colecao === 'folhas' && s.perfil === 'tecnico') {
    if (consulta) { if (consulta.some((c) => c.k === 'where' && c.campo === 'tecnicoUid' && c.op === '==' && c.valor === s.uid)) return; negar('técnico tem de filtrar por tecnicoUid'); }
    if (docRaw && docRaw.tecnicoUid === s.uid) return;
    negar('folha de outro técnico');
  }
  negar(colecao);
}

function regraEscrever(dbRaw, path, antes, depois) {
  const s = sessaoAtual(dbRaw);
  const [colecao, id] = path.split('/');
  if (!s.perfil) negar('sem perfil ativo');
  const staff = STAFF.includes(s.perfil);
  if (colecao === 'utilizadores') {
    if (s.perfil !== 'master') negar('só master gere utilizadores');
    if (!depois) negar('apagar utilizador');
    if (!['master', 'backoffice', 'tecnico', 'comercial'].includes(depois.perfil) || typeof depois.ativo !== 'boolean' || !depois.nome || !depois.email) negar('utilizador inválido');
    if (id === s.uid && antes && (depois.perfil !== antes.perfil || depois.ativo !== antes.ativo)) negar('alterar o próprio perfil');
    return;
  }
  if (colecao === 'clientes') {
    if (!staff) negar('clientes');
    if (!depois) { if (s.perfil !== 'master') negar('apagar cliente'); return; }
    if ((antes && antes.origem === 'phc') || depois.origem === 'phc') negar('cliente do PHC só é escrito pela PontePHC');
    if (typeof depois.nome !== 'string' || depois.nome.length < 2 || !/^([0-9]{9}|[A-Z]{2}[A-Z0-9]{2,13})$/.test(depois.nif || '')) negar('cliente inválido');
    return;
  }
  if (colecao === 'contadores') { if (!staff) negar('contadores'); return; }
  if (colecao === 'folhas') {
    if (!depois) { if (s.perfil === 'master' && antes.estado === 'Agendada') return; negar('apagar folha'); }
    for (const k of ['clienteId', 'clienteNome', 'tipo', 'tecnicoUid', 'tecnicoNome', 'dataPrevista', 'estado', 'historico', 'numero']) if (depois[k] === undefined || depois[k] === null || depois[k] === '') negar('folha sem ' + k);
    if (!['Instalação', 'Manutenção', 'AT'].includes(depois.tipo)) negar('tipo inválido');
    if (!antes) {
      if (!staff) negar('criar folha');
      if (depois.estado !== 'Agendada' || depois.historico.length !== 1 || depois.historico[0].uid !== s.uid) negar('folha nova inválida');
      if (!dbRaw['clientes/' + depois.clienteId]) negar('cliente inexistente');
      if (!dbRaw['utilizadores/' + depois.tecnicoUid]) negar('técnico inexistente');
      return;
    }
    const mudou = Object.keys({ ...antes, ...depois }).filter((k) => JSON.stringify(antes[k]) !== JSON.stringify(depois[k]));
    for (const k of ['numero', 'criadoEm', 'criadoPor', 'clienteId']) if (mudou.includes(k)) negar('campo imutável ' + k);
    const mudouEstado = antes.estado !== depois.estado;
    if (mudouEstado) {
      if (depois.historico.length !== antes.historico.length + 1) negar('histórico tem de crescer 1');
      const ult = depois.historico[depois.historico.length - 1];
      if (ult.estado !== depois.estado || ult.uid !== s.uid) negar('histórico inconsistente');
    } else if (mudou.includes('historico')) negar('histórico só muda com o estado');
    if (staff) {
      if (mudouEstado && antes.estado === 'Faturada' && s.perfil !== 'master') negar('só master tira de Faturada');
      return;
    }
    if (s.perfil === 'tecnico') {
      if (antes.tecnicoUid !== s.uid) negar('folha de outro técnico');
      const permitidos = ['estado', 'historico', 'estadoAlteradoEm', 'observacoesTecnico', 'atualizadoEm', 'atualizadoPor'];
      const proibidos = mudou.filter((k) => !permitidos.includes(k));
      if (proibidos.length) negar('técnico não pode alterar ' + proibidos.join(','));
      if (mudouEstado && !(TRANS_TEC[antes.estado] || []).includes(depois.estado)) negar('transição ' + antes.estado + '→' + depois.estado);
      if (antes.estado === 'Faturada') negar('folha faturada');
      return;
    }
  }
  negar(colecao);
}

// ---------- Snapshots ----------
function snapDoc(path, raw) {
  const r = refDoc(path);
  const dados = raw ? dec(raw) : undefined;
  return { id: r.id, ref: r, exists: () => !!raw, data: () => (dados ? structuredCloneTs(dados) : undefined), get: (c) => (dados ? dados[c] : undefined), _raw: raw };
}
function structuredCloneTs(o) { return dec(cod(o)); }

function executarConsulta(q) {
  const db = lerDB();
  const cs = q.cs;
  regraLer(db, q.path, null, null, cs);
  verificarIndice(q.path, cs);
  const prof = q.path.split('/').length + 1;
  let docs = Object.keys(db).filter((p) => p.startsWith(q.path + '/') && p.split('/').length === prof).map((p) => ({ path: p, raw: db[p], d: dec(db[p]) }));
  for (const w of cs.filter((c) => c.k === 'where')) docs = docs.filter((x) => testa(x.d[w.campo], w.op, w.valor));
  const ords = cs.filter((c) => c.k === 'orderBy');
  for (const o of ords) docs = docs.filter((x) => x.d[o.campo] !== undefined);
  docs.sort((a, b) => {
    for (const o of ords) { const c = cmp(a.d[o.campo], b.d[o.campo]); if (c) return o.dir === 'desc' ? -c : c; }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const sa = cs.find((c) => c.k === 'startAfter');
  if (sa) {
    const i = docs.findIndex((x) => x.path === sa.cur.ref.path);
    docs = i >= 0 ? docs.slice(i + 1) : docs;
  }
  const lim = cs.find((c) => c.k === 'limit');
  if (lim) docs = docs.slice(0, lim.n);
  contarLeituras(Math.max(1, docs.length));
  const lista = docs.map((x) => snapDoc(x.path, x.raw));
  return { docs: lista, size: lista.length, empty: !lista.length, forEach: (f) => lista.forEach(f) };
}

export async function getDocs(q) {
  await espera();
  return executarConsulta(q.type === 'query' ? q : query(q));
}

export async function getDoc(ref) {
  await espera();
  const db = lerDB();
  const [col, id] = [ref.parent.path, ref.id];
  regraLer(db, col.split('/')[0], id, db[ref.path], null);
  contarLeituras(1);
  return snapDoc(ref.path, db[ref.path]);
}

// ---------- Escritas ----------
function aplicar(db, op, agora) {
  const antes = db[op.ref.path] ? dec(db[op.ref.path]) : null;
  let depois;
  if (op.tipo === 'delete') depois = null;
  else if (op.tipo === 'update') {
    if (!antes) throw erro('not-found', 'No document to update: ' + op.ref.path);
    depois = { ...antes, ...resolverSentinelas(op.dados, antes, agora) };
  } else if (op.tipo === 'set') {
    depois = op.merge ? { ...(antes || {}), ...resolverSentinelas(op.dados, antes, agora) } : resolverSentinelas(op.dados, null, agora);
  }
  if (depois) for (const k of Object.keys(depois)) if (depois[k] === undefined) delete depois[k];
  regraEscrever(db, op.ref.path, antes, depois);
  if (depois) db[op.ref.path] = cod(depois); else delete db[op.ref.path];
}
function commit(ops) {
  const db = lerDB();
  const agora = Timestamp.now();
  for (const op of ops) aplicar(db, op, agora); // lança antes de gravar → atómico
  gravarDB(db);
  contarEscritas(ops.length);
}
export async function setDoc(ref, dados, opcoes = {}) { await espera(); commit([{ tipo: 'set', ref, dados, merge: !!opcoes.merge }]); }
export async function updateDoc(ref, dados) { await espera(); commit([{ tipo: 'update', ref, dados }]); }
export async function deleteDoc(ref) { await espera(); commit([{ tipo: 'delete', ref }]); }
export async function addDoc(colRef, dados) { const ref = doc(colRef); await setDoc(ref, dados); return ref; }

export function writeBatch() {
  const ops = [];
  return {
    set(ref, dados, o = {}) { ops.push({ tipo: 'set', ref, dados, merge: !!o.merge }); return this; },
    update(ref, dados) { ops.push({ tipo: 'update', ref, dados }); return this; },
    delete(ref) { ops.push({ tipo: 'delete', ref }); return this; },
    async commit() { await espera(); commit(ops); },
  };
}

export async function runTransaction(_db, fn) {
  await espera();
  const ops = [];
  const tx = {
    async get(ref) { const db = lerDB(); regraLer(db, ref.parent.path.split('/')[0], ref.id, db[ref.path], null); contarLeituras(1); return snapDoc(ref.path, db[ref.path]); },
    set(ref, dados, o = {}) { ops.push({ tipo: 'set', ref, dados, merge: !!o.merge }); return tx; },
    update(ref, dados) { ops.push({ tipo: 'update', ref, dados }); return tx; },
    delete(ref) { ops.push({ tipo: 'delete', ref }); return tx; },
  };
  const r = await fn(tx);
  commit(ops);
  return r;
}

// Utilitários para os testes
window.__fake = {
  db: () => lerDB(),
  doc: (p) => { const d = lerDB()[p]; return d ? dec(d) : null; },
  leituras: () => Number(localStorage.getItem(LS_READS) || 0),
  zerarLeituras: () => localStorage.setItem(LS_READS, '0'),
  emails: () => JSON.parse(localStorage.getItem('__fake_emails') || '[]'),
};
