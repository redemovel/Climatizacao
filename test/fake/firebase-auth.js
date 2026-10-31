// Simulação de firebase-auth.js (só para testes).
// Utilizadores em localStorage['__fake_auth_users'] (definidos pelo seed); sessão da app
// principal persiste em localStorage, como no Firebase real.
const LS_USERS = '__fake_auth_users';
const LS_CUR = '__fake_auth_cur';
const LS_EMAILS = '__fake_emails';

const lerJSON = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const gravarJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const erro = (code) => Object.assign(new Error('Firebase: Error (' + code + ').'), { code });
const instancias = (globalThis.__fakeAuths = globalThis.__fakeAuths || new Map());

function utilizadorPublico(u) { return u ? { uid: u.uid, email: u.email, displayName: u.displayName || null, emailVerified: true } : null; }

export function getAuth(app) {
  const nome = app ? app.name : '[DEFAULT]';
  if (instancias.has(nome)) return instancias.get(nome);
  const principal = nome === '[DEFAULT]';
  const curUid = principal ? localStorage.getItem(LS_CUR) : null;
  const u = curUid ? lerJSON(LS_USERS, []).find((x) => x.uid === curUid) : null;
  const auth = { app, name: nome, languageCode: null, currentUser: utilizadorPublico(u), _ouvintes: new Set(), _principal: principal };
  instancias.set(nome, auth);
  return auth;
}

function definir(auth, u) {
  auth.currentUser = utilizadorPublico(u);
  if (auth._principal) { if (u) localStorage.setItem(LS_CUR, u.uid); else localStorage.removeItem(LS_CUR); }
  for (const cb of auth._ouvintes) setTimeout(() => cb(auth.currentUser), 0);
}

export function onAuthStateChanged(auth, cb) {
  auth._ouvintes.add(cb);
  setTimeout(() => { if (auth._ouvintes.has(cb)) cb(auth.currentUser); }, 0);
  return () => auth._ouvintes.delete(cb);
}

export async function signInWithEmailAndPassword(auth, email, password) {
  await new Promise((r) => setTimeout(r, 30));
  const u = lerJSON(LS_USERS, []).find((x) => x.email.toLowerCase() === String(email).toLowerCase());
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw erro('auth/invalid-email');
  if (!u || u.password !== password) throw erro('auth/invalid-credential');
  if (u.disabled) throw erro('auth/user-disabled');
  definir(auth, u);
  return { user: auth.currentUser };
}

export async function signOut(auth) { definir(auth, null); }

export async function createUserWithEmailAndPassword(auth, email, password) {
  const users = lerJSON(LS_USERS, []);
  if (users.some((x) => x.email.toLowerCase() === email.toLowerCase())) throw erro('auth/email-already-in-use');
  if (!password || password.length < 6) throw erro('auth/weak-password');
  const u = { uid: 'uid-' + Math.random().toString(36).slice(2, 12), email, password };
  users.push(u);
  gravarJSON(LS_USERS, users);
  definir(auth, u);
  return { user: auth.currentUser };
}

export async function sendPasswordResetEmail(auth, email) {
  const l = lerJSON(LS_EMAILS, []);
  l.push({ tipo: 'reset', email, lingua: auth.languageCode });
  gravarJSON(LS_EMAILS, l);
}
