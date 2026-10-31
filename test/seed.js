// Dados de exemplo para a simulação do Firebase (testes).
// Datas relativas a "hoje" no fuso de Lisboa.
process.env.TZ = 'Europe/Lisbon';

const PASS = 'teste123';
const USERS = {
  master: { uid: 'u-master', email: 'rbastos@redemovel.pt', nome: 'Ricardo Bastos', perfil: 'master' },
  backoffice: { uid: 'u-bo', email: 'backoffice@redemovel.pt', nome: 'Ana Ferreira', perfil: 'backoffice' },
  tecnico1: { uid: 'u-tec1', email: 'joao.silva@redemovel.pt', nome: 'João Silva', perfil: 'tecnico' },
  tecnico2: { uid: 'u-tec2', email: 'pedro.costa@redemovel.pt', nome: 'Pedro Costa', perfil: 'tecnico' },
  inativo: { uid: 'u-tec9', email: 'rui.antigo@redemovel.pt', nome: 'Rui Antigo', perfil: 'tecnico', ativo: false },
  semPerfil: { uid: 'u-novo', email: 'novo@redemovel.pt', semPerfil: true },
};

const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function tokens(...t) {
  const set = new Set();
  for (const x of t) for (const p of normalizar(x).split(/[^a-z0-9]+/)) for (let i = 2; i <= Math.min(p.length, 15); i++) set.add(p.slice(0, i));
  return [...set];
}
function nif(prefixo8) {
  let s = 0;
  for (let i = 0; i < 8; i++) s += Number(prefixo8[i]) * (9 - i);
  let c = 11 - (s % 11);
  if (c >= 10) c = 0;
  return prefixo8 + c;
}
const ts = (d) => ({ __ts: d.getTime() });

const CLIENTES = [
  ['Hotel Meliá Ria', 'Aveiro', 'Cais da Fonte Nova, Lote 5', '3810-200', '234401000', 'Eng. Marta Lopes'],
  ['Clínica Dentária Sorriso', 'Ílhavo', 'Rua Dr. Manuel Pinto 12', '3830-100', '234321111', 'Dra. Inês'],
  ['Restaurante O Moliceiro', 'Aveiro', 'Rua João Mendonça 8', '3800-200', '234422222', 'Sr. Carlos'],
  ['Farmácia Central de Ovar', 'Ovar', 'Praça da República 3', '3880-200', '256572333', 'Dra. Paula'],
  ['Ginásio FitPorto', 'Porto', 'Rua de Santa Catarina 400', '4000-447', '222000444', 'Rui Mota'],
  ['Escritórios Boavista Center', 'Porto', 'Av. da Boavista 1200', '4100-130', '226000555', 'Receção'],
  ['Maria Fernanda Oliveira', 'Espinho', 'Rua 19 n.º 210', '4500-255', '912345678', ''],
  ['Padaria São João', 'São João da Madeira', 'Rua Visconde 45', '3700-200', '256200666', 'D. Rosa'],
  ['Auto Reparadora Feira', 'Santa Maria da Feira', 'Zona Industrial Lote 7', '4520-115', '256300777', 'Sr. Vítor'],
  ['Colégio Nossa Senhora', 'Oliveira de Azeméis', 'Rua do Colégio 1', '3720-300', '256600888', 'Irmã Teresa'],
];
// mais clientes genéricos para testar paginação
for (let i = 1; i <= 15; i++) CLIENTES.push([`Condomínio Edifício ${String(i).padStart(2, '0')}`, i % 2 ? 'Gaia' : 'Matosinhos', `Rua Exemplo ${i}`, '4400-000', '22' + String(1000000 + i), 'Administração']);

function gerar() {
  const db = {};
  const users = [];
  for (const u of Object.values(USERS)) {
    users.push({ uid: u.uid, email: u.email, password: PASS });
    if (u.semPerfil) continue;
    db['utilizadores/' + u.uid] = { nome: u.nome, email: u.email, perfil: u.perfil, ativo: u.ativo !== false, telefone: '' };
  }
  const clientes = CLIENTES.map((c, i) => {
    const id = 'cli' + String(i + 1).padStart(3, '0');
    const n = i === 0 ? '503198749' : nif('5' + String(10000000 + i * 7919).slice(-7));
    db['clientes/' + id] = {
      nome: c[0], nomePesquisa: normalizar(c[0]), pesquisa: tokens(c[0], c[1]), nif: n, nifPais: 'PT',
      morada: c[2], codigoPostal: c[3], localidade: c[1], telefone: c[4], contacto: c[5], email: '', observacoes: '',
      origem: 'manual', phcId: null,
    };
    return { id, nome: c[0], nif: n, morada: c[2], cp: c[3], loc: c[1], tel: c[4], contacto: c[5] };
  });

  // clientes sincronizados do PHC pela PontePHC
  db['clientes/phc-1234'] = { nome: 'Lar de Idosos Santa Clara', nomePesquisa: 'lar de idosos santa clara', pesquisa: tokens('Lar de Idosos Santa Clara', 'Feira'),
    nif: '506000001', nifPais: 'PT', nifValido: true, morada: 'Rua do Lar 5', codigoPostal: '4520-000', localidade: 'Feira', telefone: '256111222',
    email: '', contacto: 'Diretora', ativo: true, origem: 'phc', phcId: '1234' };
  db['clientes/phc-999'] = { nome: 'Santa Clara Antiga Lda', nomePesquisa: 'santa clara antiga lda', pesquisa: tokens('Santa Clara Antiga Lda', 'Feira'),
    nif: '123456780', nifPais: 'PT', nifValido: false, morada: '', codigoPostal: '', localidade: 'Feira', telefone: '', email: '', contacto: '',
    ativo: false, origem: 'phc', phcId: '999' };
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const dia = (n, h, m = 0) => { const d = new Date(hoje); d.setDate(d.getDate() + n); d.setHours(h, m, 0, 0); return d; };
  const T1 = USERS.tecnico1, T2 = USERS.tecnico2;
  // [dias a partir de hoje, hora, técnico, cliente, tipo, estado]
  const F = [
    [0, 9, T1, 0, 'Manutenção', 'Agendada'],
    [0, 11, T1, 1, 'AT', 'Agendada'],
    [0, 15, T1, 2, 'Instalação', 'Em curso'],
    [0, 10, T2, 3, 'Manutenção', 'Agendada'],
    [0, 14, T2, 4, 'AT', 'Pendente material'],
    [1, 9, T1, 5, 'Instalação', 'Agendada'],
    [1, 14, T2, 6, 'Manutenção', 'Agendada'],
    [2, 9, T1, 7, 'AT', 'Agendada'],
    [3, 10, T2, 8, 'Instalação', 'Agendada'],
    [-1, 9, T1, 9, 'Manutenção', 'Concluída'],
    [-2, 9, T2, 0, 'AT', 'Faturada'],
    [-3, 14, T1, 3, 'Instalação', 'Concluída'],
  ];
  for (let i = 0; i < 14; i++) F.push([-(4 + i), 9 + (i % 6), i % 2 ? T1 : T2, 10 + (i % 15), 'Manutenção', 'Concluída']);
  F.push([-5, 10, T1, 4, 'AT', 'Pendente material']); // fo027: em atraso do João

  const ano = new Date().getFullYear();
  F.forEach((f, i) => {
    const [n, h, tec, ci, tipo, estado] = f;
    const c = clientes[ci];
    const id = 'fo' + String(i + 1).padStart(3, '0');
    const criado = new Date(Date.now() - (F.length - i) * 3600e3);
    const hist = [{ estado: 'Agendada', de: null, uid: 'u-bo', nome: 'Ana Ferreira', em: ts(criado) }];
    const seq = ['Agendada', 'Em curso', 'Concluída', 'Faturada'];
    if (estado === 'Pendente material') hist.push({ estado: 'Em curso', de: 'Agendada', uid: tec.uid, nome: tec.nome, em: ts(criado) }, { estado: 'Pendente material', de: 'Em curso', uid: tec.uid, nome: tec.nome, em: ts(criado) });
    else for (let k = 1; k <= seq.indexOf(estado); k++) hist.push({ estado: seq[k], de: seq[k - 1], uid: seq[k] === 'Faturada' ? 'u-bo' : tec.uid, nome: seq[k] === 'Faturada' ? 'Ana Ferreira' : tec.nome, em: ts(criado) });
    db['folhas/' + id] = {
      numero: `FO-${ano}-${String(i + 1).padStart(4, '0')}`,
      clienteId: c.id, clienteNome: c.nome, clienteNif: c.nif,
      morada: c.morada, codigoPostal: c.cp, localidade: c.loc, telefone: c.tel, contacto: c.contacto,
      tipo, tecnicoUid: tec.uid, tecnicoNome: tec.nome, dataPrevista: ts(dia(n, h)),
      descricao: tipo === 'Manutenção' ? 'Manutenção preventiva: limpeza de filtros e verificação de pressões.' : tipo === 'AT' ? 'Equipamento não arranca, erro E5 na unidade exterior.' : 'Instalação de split 12000 BTU na sala.',
      estado, historico: hist, observacoesTecnico: '',
      criadoEm: ts(criado), criadoPor: 'u-bo', criadoPorNome: 'Ana Ferreira', estadoAlteradoEm: ts(criado),
    };
  });
  db['contadores/folhas-' + ano] = { valor: F.length };
  return { db, users };
}

module.exports = { gerar, USERS, PASS };
