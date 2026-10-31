// Simulação de firebase-app.js (só para testes). Servida no lugar de
// https://www.gstatic.com/firebasejs/<versão>/firebase-app.js pelo Playwright.
const apps = (globalThis.__fakeApps = globalThis.__fakeApps || new Map());

export function initializeApp(options, name = '[DEFAULT]') {
  if (apps.has(name)) {
    const e = new Error(`Firebase App named '${name}' already exists`);
    e.code = 'app/duplicate-app';
    throw e;
  }
  const app = { name, options, automaticDataCollectionEnabled: false };
  apps.set(name, app);
  return app;
}
export function getApp(name = '[DEFAULT]') {
  const a = apps.get(name);
  if (!a) throw Object.assign(new Error('No Firebase App ' + name), { code: 'app/no-app' });
  return a;
}
export function getApps() { return [...apps.values()]; }
export async function deleteApp(app) { apps.delete(app.name); }
export const SDK_VERSION = 'fake';
