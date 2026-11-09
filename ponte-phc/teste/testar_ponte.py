#!/usr/bin/env python3
"""Teste da PontePHC (só no ambiente de desenvolvimento, precisa de mono + mcs).

Compila o PontePHC.cs, arranca uma simulação HTTPS da Google (token OAuth2 + Firestore REST)
e corre a ponte com uma tabela de clientes de exemplo (CSV) em vez do SQL do PHC.
Uso: python3 ponte-phc/teste/testar_ponte.py /caminho/BouncyCastle.Crypto.dll
"""
import base64, datetime, http.server, json, os, shutil, ssl, subprocess, sys, tempfile, threading, hashlib
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.x509.oid import NameOID

AQUI = os.path.dirname(os.path.abspath(__file__))
FONTE = os.path.join(AQUI, '..', 'PontePHC.cs')
BC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/bc/BouncyCastle.Crypto.dll'
PROJETO = 'climatizacao-c482a'
falhas = []

def verifica(cond, msg):
    print(('  ✔ ' if cond else '  ✘ ') + msg)
    if not cond: falhas.append(msg)

d = tempfile.mkdtemp(prefix='ponte-')
shutil.copy(BC, d)
r = subprocess.run(['mcs', '-langversion:5', '-nowarn:0168,0219', '-r:BouncyCastle.Crypto.dll', '-r:System.Data.dll',
                    '-r:System.ServiceProcess.dll', '-r:System.Security.dll', '-out:PontePHC.exe', FONTE],
                   cwd=d, capture_output=True, text=True)
verifica(r.returncode == 0, 'compila com C# 5 (como o csc.exe do servidor) ' + r.stdout[-300:])

# --- certificado do servidor simulado e chave da conta de serviço
chave_srv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
nome = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
agora = datetime.datetime.now(datetime.timezone.utc)
cert = (x509.CertificateBuilder().subject_name(nome).issuer_name(nome).public_key(chave_srv.public_key())
        .serial_number(1).not_valid_before(agora - datetime.timedelta(days=1)).not_valid_after(agora + datetime.timedelta(days=5))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]), False).sign(chave_srv, hashes.SHA256()))
open(os.path.join(d, 'srv.pem'), 'wb').write(cert.public_bytes(serialization.Encoding.PEM))
open(os.path.join(d, 'srv.key'), 'wb').write(chave_srv.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
impressao = hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest().upper()

chave_sa = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PORTA = 18443
json.dump({'type': 'service_account', 'project_id': PROJETO, 'client_email': 'ponte@climatizacao-c482a.iam.gserviceaccount.com',
           'private_key': chave_sa.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode(),
           'token_uri': f'https://localhost:{PORTA}/token'}, open(os.path.join(d, 'chave-teste.json'), 'w'))

# --- tabela cl simulada (estab 0 e 1; datas/horas de alteração iguais para testar a paginação)
linhas = [
    'no;estab;nome;ncont;morada;local;codpost;telefone;email;contacto;inactivo;usrdata;usrhora',
    '1;0;ARPURO & REDEMÓVEL, LDA;503198749;Rua X;São João da Madeira;3700-000;256000000;geral@x.pt;Ricardo;0;2026-01-10;10:00:00',
    '2;0;Hotel Meliá Ria;PT 501 234 560;Cais da Fonte Nova;Aveiro;3810-200;234000000;;;0;2026-01-10;10:00:00',
    '3;0;Cliente NIF errado;123456780;;Porto;;;;;0;2026-01-10;10:00:00',
    '4;0;Empresa Espanhola;ES B12345678;;Vigo;;;;;0;2026-01-10;10:00:00',
    '5;0;Cliente Inativo;504000004;;Ovar;;;;;1;2026-01-11;09:00:00',
    '5;1;Cliente Inativo (filial);504000004;;Ovar;;;;;0;2026-01-11;09:00:00',
    '6;0;   ;;;;;;;;0;2026-01-11;09:30:00',
    '7;0;Condomínio Sol;509999995;;Gaia;;;;;0;2026-01-12;08:00:00',
]
open(os.path.join(d, 'clientes_teste.csv'), 'w', encoding='utf-8').write('\n'.join(linhas) + '\n')

def ini(extra=''):
    open(os.path.join(d, 'PontePHC.ini'), 'w', encoding='utf-8').write(f"""FirebaseProjeto={PROJETO}
ChaveServico=chave-teste.json
FirestoreServidor=localhost
PortaHttps={PORTA}
ImpressoesDigitais={impressao}
FonteTeste=clientes_teste.csv
Simular=0
Lote=3
MaxEscritasPorDia=100
{extra}
""")

# --- simulação da Google
BD, PEDIDOS = {}, []
def b64d(s): return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))

class G(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def responder(self, cod, obj):
        b = json.dumps(obj).encode()
        self.send_response(cod); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        corpo = self.rfile.read(int(self.headers['Content-Length'])).decode()
        PEDIDOS.append((self.path, self.headers.get('Authorization'), corpo))
        if self.path == '/token':
            from urllib.parse import parse_qs
            q = parse_qs(corpo); jwt = q['assertion'][0]; h, p, s = jwt.split('.')
            try:
                chave_sa.public_key().verify(b64d(s), f'{h}.{p}'.encode(), padding.PKCS1v15(), hashes.SHA256())
                pl = json.loads(b64d(p))
                ok = pl['scope'] == 'https://www.googleapis.com/auth/datastore' and pl['aud'].endswith('/token') and q['grant_type'][0] == 'urn:ietf:params:oauth:grant-type:jwt-bearer'
            except Exception: ok = False
            return self.responder(200, {'access_token': 'TOKEN-OK', 'expires_in': 3599}) if ok else self.responder(400, {'error': 'invalid_grant'})
        if self.path == f'/v1/projects/{PROJETO}/databases/(default)/documents:commit':
            if self.headers.get('Authorization') != 'Bearer TOKEN-OK': return self.responder(401, {'error': {'message': 'sem token'}})
            pedido = json.loads(corpo)
            for w in pedido['writes']:
                nome = w['update']['name'].split('/documents/')[1]
                doc = BD.setdefault(nome, {})
                for k in w['updateMask']['fieldPaths']: doc[k] = w['update']['fields'][k]
                for t in w.get('updateTransforms', []):
                    if 'appendMissingElements' in t:
                        doc.setdefault(t['fieldPath'], {'arrayValue': {'values': []}})['arrayValue'].setdefault('values', []).extend(t['appendMissingElements']['values'])
                    else: doc[t['fieldPath']] = {'timestampValue': 'agora'}
            return self.responder(200, {'writeResults': [{}] * len(pedido['writes'])})
        if self.path == f'/v1/projects/{PROJETO}/databases/(default)/documents:runQuery':
            q = json.loads(corpo)['structuredQuery']; col = q['from'][0]['collectionId']; ff = q['where']['fieldFilter']
            out = [{'document': {'name': f'projects/{PROJETO}/databases/(default)/documents/{k}', 'fields': v}}
                   for k, v in BD.items() if k.startswith(col + '/') and k.count('/') == 1 and v.get(ff['field']['fieldPath']) == ff['value']][:q.get('limit', 100)]
            return self.responder(200, out or [{'readTime': 'agora'}])
        if self.path == f'/v1/projects/{PROJETO}/databases/(default)/documents:batchGet':
            pedido = json.loads(corpo); out = []
            for n in pedido['documents']:
                k = n.split('/documents/')[1]
                out.append({'found': {'name': n, 'fields': BD[k]}} if k in BD else {'missing': n})
            return self.responder(200, out)
        self.responder(404, {'error': {'message': 'nao encontrado'}})
    def do_GET(self):
        PEDIDOS.append((self.path, self.headers.get('Authorization'), ''))
        if self.path.startswith(f'/v1/projects/{PROJETO}/databases/(default)/documents/utilizadores'):
            if self.headers.get('Authorization') != 'Bearer TOKEN-OK': return self.responder(401, {})
            docs = [{'name': f'projects/{PROJETO}/databases/(default)/documents/{k}', 'fields': v} for k, v in BD.items() if k.startswith('utilizadores/')]
            return self.responder(200, {'documents': docs} if docs else {})
        self.responder(404, {})

srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORTA), G)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.minimum_version = ssl.TLSVersion.TLSv1_2; ctx.maximum_version = ssl.TLSVersion.TLSv1_2
ctx.load_cert_chain(os.path.join(d, 'srv.pem'), os.path.join(d, 'srv.key'))
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
threading.Thread(target=srv.serve_forever, daemon=True).start()

def ponte(*args):
    r = subprocess.run(['mono', 'PontePHC.exe', '/config=' + os.path.join(d, 'PontePHC.ini'), *args], cwd=d, capture_output=True, text=True, timeout=120)
    return r.returncode, r.stdout + r.stderr

def campo(doc, k):
    v = BD[doc][k]; return next(iter(v.values()))

# 1) simulação: nada enviado
ini('Simular=1'.replace('Simular=1', '') + '\nSimular=1')
open(os.path.join(d, 'PontePHC.ini'), 'a').write('')
cfg = open(os.path.join(d, 'PontePHC.ini')).read().replace('Simular=0', 'Simular=1'); open(os.path.join(d, 'PontePHC.ini'), 'w').write(cfg)
cod, out = ponte('/sincronizar')
verifica(cod == 0 and 'seriam enviados' in out and not PEDIDOS, 'Simular=1 não envia nada')

# 2) testar-firebase
ini()
cod, out = ponte('/testar-firebase')
verifica(cod == 0 and 'acessivel' in out, '/testar-firebase: TLS 1.2 + JWT assinado + token aceites')

# 3) sincronização real em lotes de 3
cod, out = ponte('/sincronizar')
verifica(cod == 0, '/sincronizar terminou sem erro ' + out[-400:])
ids = sorted(BD)
verifica(ids == ['clientes/phc-1', 'clientes/phc-2', 'clientes/phc-3', 'clientes/phc-4', 'clientes/phc-7'], 'documentos criados (inativo antigo ignorado): ' + ', '.join(ids))
verifica(campo('clientes/phc-1', 'nome') == 'ARPURO & REDEMÓVEL, LDA' and campo('clientes/phc-1', 'localidade') == 'São João da Madeira', 'acentos preservados')
verifica(campo('clientes/phc-2', 'nif') == '501234560' and campo('clientes/phc-2', 'nifValido') is True, 'NIF «PT 501 234 560» normalizado e válido')
verifica(campo('clientes/phc-3', 'nifValido') is False, 'NIF errado marcado como inválido (mas cliente enviado)')
verifica(campo('clientes/phc-4', 'nif') == 'ESB12345678' and campo('clientes/phc-4', 'nifPais') == 'ES', 'NIF estrangeiro')
verifica('clientes/phc-5' not in BD, 'cliente inativo antigo não é enviado')
pesq = [x['stringValue'] for x in BD['clientes/phc-7']['pesquisa']['arrayValue']['values']]
verifica('cond' in pesq and 'condominio' in pesq and 'ga' in pesq, 'prefixos de pesquisa iguais aos da plataforma')
verifica(campo('clientes/phc-1', 'origem') == 'phc' and campo('clientes/phc-1', 'phcId') == '1' and 'sincronizadoEm' in BD['clientes/phc-1'], 'origem, n.º PHC e data de sincronização')
commits = [p for p in PEDIDOS if p[0].endswith(':commit')]
verifica(len(commits) == 2, f'enviado em lotes de 3 ({len(commits)} pedidos)')
verifica(open(os.path.join(d, 'estado_clientes.txt')).read() == '2026-01-12|08:00:00|7', 'marca gravada no último cliente')

# 4) segunda passagem: nada de novo → nenhum envio
n = len(PEDIDOS)
cod, out = ponte('/sincronizar')
verifica(cod == 0 and not [p for p in PEDIDOS[n:] if p[0].endswith(':commit')], 'sem alterações no PHC → nada enviado')

# 4b) cliente antigo (ficha sem alterações) que recebe agora uma fatura de climatização → enviado uma vez
linhas.append('8;0;Cliente Fatura Nova;503504564;;Espinho;;;;;0;2025-01-01;08:00:00')
open(os.path.join(d, 'clientes_teste.csv'), 'w', encoding='utf-8').write('\n'.join(linhas) + '\n')
open(os.path.join(d, 'PontePHC.ini'), 'a').write('\nFonteTesteDocumentos=3,8\n')
n = len(PEDIDOS)
cod, out = ponte('/sincronizar')
w = [x for p in PEDIDOS[n:] if p[0].endswith(':commit') for x in json.loads(p[2])['writes']]
verifica([x['update']['name'].split('/')[-1] for x in w] == ['phc-8'], 'cliente com documento recente enviado (só ele, o 3 já tinha ido)')
n = len(PEDIDOS)
cod, out = ponte('/sincronizar')
verifica(not [p for p in PEDIDOS[n:] if p[0].endswith(':commit')], 'não reenvia o mesmo cliente a cada ciclo')

# 5) cliente alterado no PHC → só ele é enviado; campos da plataforma não são apagados
BD['clientes/phc-2']['observacoes'] = {'stringValue': 'nota feita na plataforma'}
linhas[2] = linhas[2].replace('Hotel Meliá Ria', 'Hotel Meliá Ria Aveiro').replace('2026-01-10;10:00:00', '2026-02-01;12:00:00')
open(os.path.join(d, 'clientes_teste.csv'), 'w', encoding='utf-8').write('\n'.join(linhas) + '\n')
n = len(PEDIDOS)
cod, out = ponte('/sincronizar')
novos = [json.loads(p[2]) for p in PEDIDOS[n:] if p[0].endswith(':commit')]
verifica(len(novos) == 1 and len(novos[0]['writes']) == 1, 'só o cliente alterado é reenviado')
verifica(campo('clientes/phc-2', 'nome') == 'Hotel Meliá Ria Aveiro' and campo('clientes/phc-2', 'observacoes') == 'nota feita na plataforma', 'atualiza nome sem apagar campos da plataforma')

# 5b) cliente desativado no PHC depois do arranque → enviado com ativo=false
hoje = datetime.date.today().isoformat()
linhas[1] = linhas[1].replace(';0;2026-01-10;10:00:00', f';1;{hoje};18:00:00')
open(os.path.join(d, 'clientes_teste.csv'), 'w', encoding='utf-8').write('\n'.join(linhas) + '\n')
cod, out = ponte('/sincronizar')
verifica(campo('clientes/phc-1', 'ativo') is False, 'cliente desativado depois do arranque é enviado como inativo')

# 5c) folhas de obra do PHC (dossier 114)
print('  -- folhas de obra')
sv = lambda v: {'stringValue': v}
BD['utilizadores/u-paulo'] = {'nome': sv('Paulo Duarte'), 'email': sv('pduarte@arpuro.pt'), 'ativo': {'booleanValue': True}}
BD['utilizadores/u-ricardo'] = {'nome': sv('Ricardo Pereira'), 'email': sv('tecnica@arpuro.pt'), 'ativo': {'booleanValue': True}}
cab = 'bostamp;obrano;boano;dataobra;xpdhora;no;nome;ncont;morada;local;codpost;telefone;tecnnm;trab1;trab5;tabela1;u_davaria;fechada;ousrdata;ousrinis;usrdata;usrhora;tabela2;etotaldeb;u_dinterve;obstab2;obranome;u_resnego;dataopen'
folhas = [
    'A;1785;2026;2026-10-29;09:00;3;SIMOLDES PLASTICOS, SA;501220267;R Comend Antonio Silva Rodrigues,165|Ap113;SANTIAGO DE RIBA-UL;3721-902 SANTIAGO DE RIBA-UL;256000000;tecnica;Telmo Pinho;Manutenção;3-Em Execução;Manutenção preventiva semestral;0;2026-10-29;Paulo Duarte;2026-10-29;12:58;Duarte, Paulo;958.80;Substituído ligador do compressor.;Cliente paga a 60 dias;2146895;Em garantia;2026-11-03',
    'B;1700;2026;2026-09-10;14:30;2;Hotel Meliá Ria;501234560;Cais;Aveiro;3810-200 AVEIRO;;tecnica;Eng. Marta;Assistência Técnica;4.1-Pendente Peças;Compressor;0;2026-09-10;NW;2026-09-11;10:00;;0',
    'C;1600;2025;2025-05-02;;3;SIMOLDES PLASTICOS, SA;501220267;;;;;Ricardo B.;;Instalação;5-Concluido;Instalação split;1;2025-05-02;NW;2025-06-01;09:00',
    'D;1780;2026;2026-10-20;;4;Empresa Espanhola;ES B12345678;;Vigo;;;;;Assistência Técnica;1-Registado;Avaria;0;2026-10-20;NW;2026-10-20;08:00',
    'E;1781;2026;2026-10-21;10:00;4;Empresa Espanhola;ES B12345678;;Vigo;;;Pascoal Rodrigues;;Manutenção;2-Atribuido;;0;2026-10-21;NW;2026-10-21;08:00',
    'F;12;2021;2021-05-04;;3;SIMOLDES PLASTICOS, SA;501220267;;;;;Paulo Duarte;;Manutenção;5.1 Pedido NE;;0;2021-05-04;NW;2021-05-05;08:00',
]
open(os.path.join(d, 'folhas.csv'), 'w', encoding='utf-8').write(cab + '\n' + '\n'.join(folhas) + '\n')
open(os.path.join(d, 'linhas.csv'), 'w', encoding='utf-8').write('bostamp;ref;design;qtt;unidade\nA;ST2;Serviço Técnico (Equipa);8;h\nA;ST1;Serviço Técnico;7;h\n')
open(os.path.join(d, 'tempos.csv'), 'w', encoding='utf-8').write('A;2026-10-29;8;Pereira, Ricardo\nA;2026-10-29;7;Duarte, Paulo\n')
open(os.path.join(d, 'valores.csv'), 'w', encoding='utf-8').write('A;2026-10-29;8;Manutenção;Técnico-Técnico;40.8;326.4\n')
open(os.path.join(d, 'PontePHC.ini'), 'a').write('\nImportarFolhas=1\nFonteTesteFolhas=folhas.csv\nFonteTesteLinhas=linhas.csv\nFonteTesteTempos=tempos.csv\nFonteTesteValores=valores.csv\nTecnicoPHC.tecnica=tecnica@arpuro.pt\n')
cod, out = ponte('/sincronizar')
verifica(cod == 0 and '6 folhas de obra enviadas' in out, '6 folhas importadas ' + out[-300:])
F = lambda k: BD.get('folhas/' + k, {})
c = lambda k, f: next(iter(F(k)[f].values())) if f in F(k) else None
verifica(c('phc-2026-1785', 'numero') == 'FO-2026-1785' and c('phc-2026-1785', 'estado') == 'Em curso' and c('phc-2026-1785', 'tecnicoUid') == 'u-paulo', '3-Em Execução → Em curso; técnico pelo «Tec. Responsável» (Duarte, Paulo), não pelo tecnnm')
tp = F('phc-2026-1785')['temposPHC']['arrayValue']['values']
verifica(len(tp) == 2 and tp[0]['mapValue']['fields']['funcionario']['stringValue'] == 'Ricardo Pereira', 'registo de tempos importado (nomes «Nome Apelido»)')
pv = BD.get('folhas/phc-2026-1785/privado/phc', {})
verifica(pv.get('totalVenda') == {'doubleValue': 958.8} and pv['valorHora']['arrayValue']['values'][0]['mapValue']['fields']['tipoTecnico']['stringValue'] == 'Técnico-Técnico', 'valores e total só no documento privado')
verifica('preco' not in json.dumps(F('phc-2026-1785')) and 'total' not in json.dumps(F('phc-2026-1785')).lower().replace('totalhoras', ''), 'a folha (visível ao técnico) não tem preços')
verifica(c('phc-2026-1785', 'relatorioPHC') == 'Substituído ligador do compressor.' and c('phc-2026-1785', 'encomendaCliente') == '2146895' and c('phc-2026-1785', 'observacoesInternasPHC') == 'Cliente paga a 60 dias' and c('phc-2026-1785', 'situacaoPHC') == 'Em garantia', 'relatório, V/Encomenda, observações internas e situação')
pq = [v['stringValue'] for v in F('phc-2026-1785')['pesquisa']['arrayValue']['values']]
verifica('1785' in pq and 'simoldes'[:2] in pq, 'folha com pesquisa por n.º/cliente/NIF/avaria')
verifica(c('phc-2026-1785', 'dataPrevista').startswith('2026-11-03T09:00') and c('phc-2026-1700', 'dataPrevista').startswith('2026-09-10T13:30'), 'data agendada = «Marcação Cliente» (dataopen); sem marcação, a data do documento: ' + str(c('phc-2026-1700', 'dataPrevista')))
verifica(c('phc-2026-1785', 'tipo') == 'Manutenção' and c('phc-2026-1785', 'codigoPostal') == '3721-902' and c('phc-2026-1785', 'contacto') == 'Telmo Pinho', 'tipo, código postal e contacto no local')
verifica(c('phc-2026-1785', 'morada') == 'R Comend Antonio Silva Rodrigues,165, Ap113' and c('phc-2026-1785', 'clienteId') == 'phc-3', 'morada e cliente')
lin = F('phc-2026-1785')['linhasPHC']['arrayValue']['values']
verifica(len(lin) == 2 and lin[0]['mapValue']['fields']['ref']['stringValue'] == 'ST2' and 'preco' not in json.dumps(lin), 'linhas de horas importadas sem preços')
verifica(c('phc-2026-1700', 'estado') == 'Pendente' and F('phc-2026-1700')['pendencia']['mapValue']['fields']['motivo']['stringValue'] == 'Peças' and c('phc-2026-1700', 'tecnicoUid') == 'u-ricardo', '4.1 → Pendente (Peças); «tecnica» → Ricardo Pereira (TecnicoPHC)')
verifica(c('phc-2025-1600', 'estado') == 'Faturada' and c('phc-2025-1600', 'tecnicoUid') == 'phc:Ricardo B.', 'fechada → Faturada; técnico antigo só como nome')
verifica(c('phc-2026-1780', 'estado') == 'Por agendar' and c('phc-2026-1780', 'tecnicoUid') == '', 'registada sem técnico → Por agendar')
verifica(c('phc-2026-1781', 'estado') == 'Por agendar' and c('phc-2026-1781', 'tecnicoNome') == 'Pascoal Rodrigues', 'técnico sem conta → Por agendar, nome guardado')
verifica(c('phc-2021-12', 'estado') == 'Aguarda NE' and c('phc-2021-12', 'numero') == 'FO-2021-0012', '5.1 Pedido NE → Aguarda NE; numeração com 4 dígitos')
verifica(c('contadores/folhas-2026'.replace('contadores/', ''), 'x') is None and BD.get('contadores/folhas-2026', {}).get('valor') == {'integerValue': '1785'}, 'contador 2026 acertado para continuar em 1786')
# folha trabalhada na plataforma e depois faturada no PHC
F('phc-2026-1785')['estado'] = sv('Concluída'); F('phc-2026-1785')['observacoesTecnico'] = sv('feito')
folhas[0] = folhas[0].replace(';0;2026-10-29;Paulo Duarte;2026-10-29;12:58', ';1;2026-10-29;Paulo Duarte;2026-10-30;18:00')
open(os.path.join(d, 'folhas.csv'), 'w', encoding='utf-8').write(cab + '\n' + '\n'.join(folhas) + '\n')
cod, out = ponte('/sincronizar')
h = F('phc-2026-1785')['historico']['arrayValue']['values']
verifica(c('phc-2026-1785', 'estado') == 'Faturada' and h[-1]['mapValue']['fields']['de']['stringValue'] == 'Concluída' and len(h) == 2, 'faturada no PHC → Faturada, com registo no histórico')
verifica(c('phc-2026-1785', 'observacoesTecnico') == 'feito' and c('phc-2026-1785', 'tecnicoUid') == 'u-paulo', 'não apaga o que foi feito na plataforma')
# marcação alterada no PHC → nova data; folha antiga (sem marcacaoPHC) com a data do documento → corrigida; reagendada na plataforma → mantém
F('phc-2026-1700')['dataPrevista'] = {'timestampValue': '2026-09-10T13:30:00Z'}; del F('phc-2026-1700')['marcacaoPHC']
F('phc-2026-1781')['dataPrevista'] = {'timestampValue': '2026-12-01T10:00:00Z'}; del F('phc-2026-1781')['marcacaoPHC']
folhas[0] = folhas[0].replace(';2026-11-03', ';2026-11-09').replace('2026-10-30;18:00', '2026-10-31;18:00')
folhas[1] = folhas[1].replace('2026-09-11;10:00', '2026-10-31;10:00') + ';;;;;2026-11-12'
folhas[4] = folhas[4].replace('2026-10-21;08:00', '2026-10-31;08:00')
open(os.path.join(d, 'folhas.csv'), 'w', encoding='utf-8').write(cab + '\n' + '\n'.join(folhas) + '\n')
cod, out = ponte('/sincronizar')
verifica(c('phc-2026-1785', 'dataPrevista').startswith('2026-11-09T09:00'), 'marcação alterada no PHC → nova data: ' + str(c('phc-2026-1785', 'dataPrevista')))
verifica(c('phc-2026-1700', 'dataPrevista').startswith('2026-11-12T14:30'), 'folha antiga com a data do documento → passa para a marcação: ' + str(c('phc-2026-1700', 'dataPrevista')))
verifica(c('phc-2026-1781', 'dataPrevista').startswith('2026-12-01T10:00'), 'reagendada na plataforma → mantém: ' + str(c('phc-2026-1781', 'dataPrevista')))
# estados acompanham o PHC (só para a frente); «Revista» antiga (importada de 5-Concluído, nunca mexida) volta a «Concluída»
F('phc-2026-1700')['estado'] = sv('Revista'); F('phc-2026-1700')['historico'] = {'arrayValue': {'values': [F('phc-2026-1700')['historico']['arrayValue']['values'][0]]}}
folhas[1] = folhas[1].replace('4.1-Pendente Peças', '5-Concluido').replace('2026-10-31;10:00', '2026-11-01;10:00')
folhas[3] = folhas[3].replace('1-Registado', '3-Em Execução').replace('2026-10-20;08:00', '2026-11-01;08:00')
folhas[4] = folhas[4].replace('2-Atribuido', '5-Concluido').replace('2026-10-31;08:00', '2026-11-01;08:00')
open(os.path.join(d, 'folhas.csv'), 'w', encoding='utf-8').write(cab + '\n' + '\n'.join(folhas) + '\n')
cod, out = ponte('/sincronizar')
verifica(c('phc-2026-1700', 'estado') == 'Concluída', '«Revista» antiga sem mexer na plataforma → Concluída: ' + str(c('phc-2026-1700', 'estado')))
verifica(c('phc-2026-1780', 'estado') == 'Em curso' and c('phc-2026-1780', 'tecnicoUid') == 'phc:sem-tecnico', 'Registado → Em Execução no PHC: Em curso (técnico só como nome)')
verifica(c('phc-2026-1781', 'estado') == 'Concluída' and c('phc-2026-1781', 'tecnicoUid') == 'phc:Pascoal Rodrigues', '5-Concluído → Concluída (por rever)')
h = F('phc-2026-1781')['historico']['arrayValue']['values']
verifica(h[-1]['mapValue']['fields']['uid']['stringValue'] == 'phc' and h[-1]['mapValue']['fields']['de']['stringValue'] == 'Por agendar', 'mudança registada no histórico')
# revista na plataforma e o PHC volta a «Em Execução»: não recua
F('phc-2026-1781')['estado'] = sv('Revista'); F('phc-2026-1781')['historico']['arrayValue']['values'].append({'mapValue': {'fields': {'estado': sv('Revista'), 'uid': sv('u-ricardo')}}})
folhas[4] = folhas[4].replace('5-Concluido', '3-Em Execução').replace('2026-11-01;08:00', '2026-11-02;08:00')
open(os.path.join(d, 'folhas.csv'), 'w', encoding='utf-8').write(cab + '\n' + '\n'.join(folhas) + '\n')
cod, out = ponte('/sincronizar')
verifica(c('phc-2026-1781', 'estado') == 'Revista', 'o PHC nunca faz recuar o estado da plataforma')
BD['contadores/folhas-2026'] = {'valor': {'integerValue': '1800'}}
folhas[1] = folhas[1].replace('2026-09-11;10:00', '2026-11-01;10:00')
open(os.path.join(d, 'folhas.csv'), 'w', encoding='utf-8').write(cab + '\n' + '\n'.join(folhas) + '\n')
cod, out = ponte('/sincronizar')
verifica(BD['contadores/folhas-2026']['valor'] == {'integerValue': '1800'}, 'contador nunca desce')

# 5b) artigos do armazém da climatização (stock, reservado em FO abertas, em guias abertas; custo só no privado)
arts = ['ref;design;unidade;familia;inactivo;stock;reservado;guias;custo;usrdata',
        'TC14;Tubo cobre 1/4";m;Ar Condicionado;0;120;10;50;2.77;2026-11-01',
        'FTXP35;Ar Condicionado Daikin FTXP35;un;Ar Condicionado;0;3;0;0;400;2026-11-01;1',
        'AB/12;Abraçadeira 12 mm;un;Ar Condicionado;0;30;0;0;0.1;2026-11-01']
open(os.path.join(d, 'artigos.csv'), 'w', encoding='utf-8').write('\n'.join(arts) + '\n')
open(os.path.join(d, 'PontePHC.ini'), 'a').write('\nImportarArtigos=1\nFonteTesteArtigos=artigos.csv\n')
cod, out = ponte('/sincronizar')
A = BD.get('artigos/TC14', {})
verifica(BD.get('artigos/FTXP35', {}).get('comSerie') == {'booleanValue': True} and BD['artigos/TC14'].get('comSerie') == {'booleanValue': False}, 'equipamentos com n.º de série marcados')
verifica('3 artigos com alteracoes' in out and A.get('stock') == {'doubleValue': 120} and A.get('reservadoPHC') == {'doubleValue': 10} and A.get('emGuiasPHC') == {'doubleValue': 50}, 'artigos: stock, reservado e em guias ' + out[-200:])
verifica('custo' not in json.dumps(A) and BD.get('artigos/TC14/privado/custo', {}).get('custo') == {'doubleValue': 2.77}, 'custo só no documento privado')
verifica('artigos/AB~2F12' in BD and BD['artigos/AB~2F12']['ref'] == {'stringValue': 'AB/12'}, 'referência com «/» fica com id válido')
verifica('tu' in json.dumps(A.get('pesquisa')) and 'cobre' in json.dumps(A.get('pesquisa')), 'pesquisa por referência e designação')
n = len(PEDIDOS)
cod, out = ponte('/sincronizar')
verifica(not [p for p in PEDIDOS[n:] if p[0].endswith(':commit') and 'artigos/' in p[2]], 'sem alterações não volta a enviar artigos')
arts[1] = arts[1].replace(';120;10;50;', ';100;10;50;').replace('2026-11-01', datetime.date.today().isoformat())
open(os.path.join(d, 'artigos.csv'), 'w', encoding='utf-8').write('\n'.join(arts) + '\n')
cod, out = ponte('/sincronizar')
verifica(BD['artigos/TC14']['stock'] == {'doubleValue': 100} and '1 artigos com alteracoes' in out, 'stock alterado → só esse artigo reenviado')

# 5c) emails pedidos pela plataforma (relatório ao cliente), com a assinatura em anexo inline; modo de teste
try:
    from aiosmtpd.controller import Controller
    import email as _email
    REC2 = []
    class H2:
        async def handle_DATA(self, server, session, envelope):
            REC2.append(envelope); return '250 OK'
    ctl2 = Controller(H2(), hostname='127.0.0.1', port=10026); ctl2.start()
    png = base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'0' * 20).decode()
    BD['emails/e1'] = {'estado': sv('Pendente'), 'para': sv('cliente@exemplo.pt'), 'assunto': sv('Relatório FO-2026-1785'),
                       'html': sv('<p>Relatório</p><img src="cid:assinatura">'), 'texto': sv('Relatório'), 'folhaId': sv('phc-2026-1785'),
                       'assinaturaPng': sv('data:image/png;base64,' + png)}
    BD['emails/e2'] = {'estado': sv('Enviado'), 'para': sv('outro@exemplo.pt'), 'assunto': sv('x'), 'html': sv('x'), 'folhaId': sv('')}
    open(os.path.join(d, 'PontePHC.ini'), 'a').write('\nEnviarEmails=1\nSmtpServidor=127.0.0.1\nSmtpPorta=10026\nEmailDe=noreply@arpuro.pt\nEmailsTeste=rbastos@arpuro.pt\n')
    cod, out = ponte('/sincronizar')
    ctl2.stop()
    verifica('1 emails enviados' in out and len(REC2) == 1, 'só o email pendente é enviado ' + out[-200:])
    if REC2:
        m = _email.message_from_bytes(REC2[0].content)
        verifica(REC2[0].rcpt_tos == ['rbastos@arpuro.pt'] and 'TESTE' in str(_email.header.make_header(_email.header.decode_header(m['Subject']))), 'modo de teste: vai para rbastos com aviso no assunto')
        c2 = REC2[0].content.decode(errors='ignore'); verifica('assinatura' in c2.lower().split('content-id')[1][:40] if 'content-id' in c2.lower() else False, 'assinatura em anexo inline (cid) ' + c2[c2.lower().find('content-'):][:300])
    verifica(BD['emails/e1']['estado'] == sv('Enviado') and BD['folhas/phc-2026-1785']['relatorioEnviado']['mapValue']['fields']['estado'] == sv('Enviado'), 'email e folha marcados como enviados')
    cfg = open(os.path.join(d, 'PontePHC.ini')).read().replace('EnviarEmails=1', 'EnviarEmails=0'); open(os.path.join(d, 'PontePHC.ini'), 'w').write(cfg)
except ImportError:
    print('  (aiosmtpd não instalado: teste de emails ignorado)')

# 5d) botão «Sincronizar agora» na plataforma: controlo/sincronizar estado «Pedido»
cod, out = ponte('/verificar-pedido')
verifica('Sem pedido' in out, 'sem pedido não faz nada')
# duração real: por dia conta o funcionário com mais horas (equipa em paralelo); mediana por tipo
open(os.path.join(d, 'tempos.csv'), 'a', encoding='utf-8').write('E;2026-10-21;3;Rodrigues, Pascoal\nE;2026-10-22;2;Rodrigues, Pascoal\nE;2026-10-22;1;Duarte, Paulo\nF;2021-05-04;9;Duarte, Paulo\n')
cod, out = ponte('/duracoes')
du = BD.get('listas/duracoes', {})
mt = du.get('porTipo', {}).get('mapValue', {}).get('fields', {}).get('Manutenção', {}).get('mapValue', {}).get('fields', {})
verifica(cod == 0 and mt.get('h', {}).get('doubleValue') == 6.5 and mt.get('n', {}).get('integerValue') == '2', 'duração real: mediana de 8 h (A) e 5 h (E); 2021 fica de fora: ' + json.dumps(du)[:300] + out[-200:])
BD['controlo/sincronizar'] = {'estado': sv('Pedido'), 'pedidoPorNome': sv('Ricardo')}
cod, out = ponte('/verificar-pedido')
verifica('atendido' in out and BD['controlo/sincronizar']['estado'] == sv('Concluído') and BD['controlo/sincronizar']['resultado'] == sv('OK'), 'pedido atendido e marcado como concluído ' + out[-200:])

# 6) limite diário de escritas
open(os.path.join(d, 'estado_escritas.txt'), 'w').write(datetime.date.today().isoformat() + '|100')
os.remove(os.path.join(d, 'estado_clientes.txt'))
n = len(PEDIDOS)
cod, out = ponte('/sincronizar')
verifica('Limite diario' in out and not [p for p in PEDIDOS[n:] if p[0].endswith(':commit')], 'respeita o limite diário de escritas')

# 7) servidor com certificado não confiável → recusa
ini().__class__  # noop
cfg = open(os.path.join(d, 'PontePHC.ini')).read().replace('ImpressoesDigitais=' + impressao, 'ImpressoesDigitais=')
open(os.path.join(d, 'PontePHC.ini'), 'w').write(cfg)
n = len(PEDIDOS)
cod, out = ponte('/testar-firebase')
verifica(cod != 0 and 'nao validado' in out and len(PEDIDOS) == n, 'recusa servidor cujo certificado não é da Google (nada enviado)')

srv.shutdown()

# 7b) email de teste por SMTP (servidor simulado, como o Exchange interno)
try:
    from aiosmtpd.controller import Controller
    RECEBIDOS = []
    class H:
        async def handle_DATA(self, server, session, envelope):
            RECEBIDOS.append(envelope); return '250 OK'
    ctl = Controller(H(), hostname='127.0.0.1', port=10025); ctl.start()
    open(os.path.join(d, 'PontePHC.ini'), 'a').write('\nSmtpServidor=127.0.0.1\nSmtpPorta=10025\nEmailDe=noreply@arpuro.pt\nEmailResponderPara=rbastos@arpuro.pt\nEmailCopiaOculta=rbastos@arpuro.pt\n')
    cod, out = ponte('/testar-email', 'cliente@exemplo.pt')
    ctl.stop()
    import email
    msg = email.message_from_bytes(RECEBIDOS[0].content) if RECEBIDOS else None
    verifica(cod == 0 and msg is not None, 'email de teste entregue ao SMTP ' + out[-200:])
    if msg:
        verifica('noreply@arpuro.pt' in msg['From'] and msg['Reply-To'] == 'rbastos@arpuro.pt', 'De noreply, responder para rbastos')
        verifica(sorted(RECEBIDOS[0].rcpt_tos) == ['cliente@exemplo.pt', 'rbastos@arpuro.pt'], 'destinatário + cópia oculta: ' + str(RECEBIDOS[0].rcpt_tos))
except ImportError:
    print('  (aiosmtpd não instalado: teste de email ignorado)')

# 8) validação da cadeia (como com a Google): raiz fixa no programa, servidor envia folha + intermédio
print('  -- cadeia de certificados (raiz simulada no lugar das raízes Google)')
from cryptography.x509 import BasicConstraints
def emitir(subj, chave_pub, emissor, chave_emissor, ca, san=None, dias=5):
    b = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subj)]))
         .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, emissor)])).public_key(chave_pub)
         .serial_number(x509.random_serial_number()).not_valid_before(agora - datetime.timedelta(days=1))
         .not_valid_after(agora + datetime.timedelta(days=dias)).add_extension(BasicConstraints(ca=ca, path_length=None), True))
    if san: b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in san]), False)
    return b.sign(chave_emissor, hashes.SHA256())
k_raiz = rsa.generate_private_key(public_exponent=65537, key_size=2048)
k_int = rsa.generate_private_key(public_exponent=65537, key_size=2048)
k_folha = rsa.generate_private_key(public_exponent=65537, key_size=2048)
k_outra = rsa.generate_private_key(public_exponent=65537, key_size=2048)
raiz = emitir('Raiz Teste', k_raiz.public_key(), 'Raiz Teste', k_raiz, True)
inter = emitir('Intermedio Teste', k_int.public_key(), 'Raiz Teste', k_raiz, True)
raiz_cruzada = emitir('Raiz Teste', k_raiz.public_key(), 'Outra Raiz', k_outra, True)   # mesma chave da raiz, emitida por outra
folha = emitir('*.local.test', k_folha.public_key(), 'Intermedio Teste', k_int, False, ['*.local.test'])
folha_nome_errado = emitir('outro.test', k_folha.public_key(), 'Intermedio Teste', k_int, False, ['outro.test'])
folha_falsa = emitir('*.local.test', k_folha.public_key(), 'Intermedio Teste', k_outra, False, ['*.local.test'])  # assinatura não bate
der = lambda c: base64.b64encode(c.public_bytes(serialization.Encoding.DER)).decode()
src = open(FONTE, encoding='utf-8').read()
import re
src2 = re.sub(r'static readonly string\[\] Pem = new string\[\] \{.*?\};', 'static readonly string[] Pem = new string[] { "' + der(raiz) + '" };', src, flags=re.S)
open(os.path.join(d, 'PonteCadeia.cs'), 'w', encoding='utf-8').write(src2)
r = subprocess.run(['mcs', '-langversion:5', '-nowarn:0168,0219', '-r:BouncyCastle.Crypto.dll', '-r:System.Data.dll',
                    '-r:System.ServiceProcess.dll', '-r:System.Security.dll', '-out:PontePHC.exe', 'PonteCadeia.cs'], cwd=d, capture_output=True, text=True)
verifica(r.returncode == 0, 'variante com raiz de teste compila')
PORTA2 = PORTA + 1
def servir(cadeia, chave):
    pem = b''.join(c.public_bytes(serialization.Encoding.PEM) for c in cadeia)
    open(os.path.join(d, 'cadeia.pem'), 'wb').write(pem)
    open(os.path.join(d, 'cadeia.key'), 'wb').write(chave.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    s2 = http.server.ThreadingHTTPServer(('127.0.0.1', PORTA2), G)
    c2 = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c2.maximum_version = ssl.TLSVersion.TLSv1_2
    c2.load_cert_chain(os.path.join(d, 'cadeia.pem'), os.path.join(d, 'cadeia.key'))
    s2.socket = c2.wrap_socket(s2.socket, server_side=True)
    threading.Thread(target=s2.serve_forever, daemon=True).start()
    return s2
j = json.load(open(os.path.join(d, 'chave-teste.json'))); j['token_uri'] = f'https://oauth2.local.test:{PORTA2}/token'
json.dump(j, open(os.path.join(d, 'chave-teste.json'), 'w'))
ini(f'LigarA=127.0.0.1')
cfg = open(os.path.join(d, 'PontePHC.ini')).read().replace('FirestoreServidor=localhost', 'FirestoreServidor=firestore.local.test') \
    .replace(f'PortaHttps={PORTA}', f'PortaHttps={PORTA2}').replace('ImpressoesDigitais=' + impressao, 'ImpressoesDigitais=')
open(os.path.join(d, 'PontePHC.ini'), 'w').write(cfg)
for desc, cadeia, deve in [('folha + intermédio → aceite', [folha, inter], True),
                           ('folha + intermédio + raiz com assinatura cruzada → aceite', [folha, inter, raiz_cruzada], True),
                           ('nome do servidor não corresponde → recusado', [folha_nome_errado, inter], False),
                           ('assinatura da folha não bate com o intermédio → recusado', [folha_falsa, inter], False),
                           ('só a folha, sem intermédio → recusado', [folha], False)]:
    s2 = servir(cadeia, k_folha)
    cod, out = ponte('/testar-firebase')
    s2.shutdown(); s2.server_close()
    verifica((cod == 0) == deve, desc + ('' if (cod == 0) == deve else ' :: ' + out[-300:]))

print(f'\n{"TUDO OK" if not falhas else str(len(falhas)) + " FALHAS"}  (pasta de teste: {d})')
sys.exit(1 if falhas else 0)
