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
                for t in w.get('updateTransforms', []): doc[t['fieldPath']] = {'timestampValue': 'agora'}
            return self.responder(200, {'writeResults': [{}] * len(pedido['writes'])})
        self.responder(404, {'error': {'message': 'nao encontrado'}})
    def do_GET(self):
        PEDIDOS.append((self.path, self.headers.get('Authorization'), ''))
        if self.path.startswith(f'/v1/projects/{PROJETO}/databases/(default)/documents/utilizadores'):
            return self.responder(200, {'documents': []}) if self.headers.get('Authorization') == 'Bearer TOKEN-OK' else self.responder(401, {})
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
verifica(ids == ['clientes/phc-1', 'clientes/phc-2', 'clientes/phc-3', 'clientes/phc-4', 'clientes/phc-5', 'clientes/phc-7'], 'documentos criados: ' + ', '.join(ids))
verifica(campo('clientes/phc-1', 'nome') == 'ARPURO & REDEMÓVEL, LDA' and campo('clientes/phc-1', 'localidade') == 'São João da Madeira', 'acentos preservados')
verifica(campo('clientes/phc-2', 'nif') == '501234560' and campo('clientes/phc-2', 'nifValido') is True, 'NIF «PT 501 234 560» normalizado e válido')
verifica(campo('clientes/phc-3', 'nifValido') is False, 'NIF errado marcado como inválido (mas cliente enviado)')
verifica(campo('clientes/phc-4', 'nif') == 'ESB12345678' and campo('clientes/phc-4', 'nifPais') == 'ES', 'NIF estrangeiro')
verifica(campo('clientes/phc-5', 'ativo') is False, 'cliente inativo enviado com ativo=false')
pesq = [x['stringValue'] for x in BD['clientes/phc-7']['pesquisa']['arrayValue']['values']]
verifica('cond' in pesq and 'condominio' in pesq and 'ga' in pesq, 'prefixos de pesquisa iguais aos da plataforma')
verifica(campo('clientes/phc-1', 'origem') == 'phc' and campo('clientes/phc-1', 'phcId') == '1' and 'sincronizadoEm' in BD['clientes/phc-1'], 'origem, n.º PHC e data de sincronização')
commits = [p for p in PEDIDOS if p[0].endswith(':commit')]
verifica(len(commits) == 3, f'enviado em lotes de 3 ({len(commits)} pedidos)')
verifica(open(os.path.join(d, 'estado_clientes.txt')).read() == '2026-01-12|08:00:00|7', 'marca gravada no último cliente')

# 4) segunda passagem: nada de novo → nenhum envio
n = len(PEDIDOS)
cod, out = ponte('/sincronizar')
verifica(cod == 0 and not [p for p in PEDIDOS[n:] if p[0].endswith(':commit')], 'sem alterações no PHC → nada enviado')

# 5) cliente alterado no PHC → só ele é enviado; campos da plataforma não são apagados
BD['clientes/phc-2']['observacoes'] = {'stringValue': 'nota feita na plataforma'}
linhas[2] = linhas[2].replace('Hotel Meliá Ria', 'Hotel Meliá Ria Aveiro').replace('2026-01-10;10:00:00', '2026-02-01;12:00:00')
open(os.path.join(d, 'clientes_teste.csv'), 'w', encoding='utf-8').write('\n'.join(linhas) + '\n')
n = len(PEDIDOS)
cod, out = ponte('/sincronizar')
novos = [json.loads(p[2]) for p in PEDIDOS[n:] if p[0].endswith(':commit')]
verifica(len(novos) == 1 and len(novos[0]['writes']) == 1, 'só o cliente alterado é reenviado')
verifica(campo('clientes/phc-2', 'nome') == 'Hotel Meliá Ria Aveiro' and campo('clientes/phc-2', 'observacoes') == 'nota feita na plataforma', 'atualiza nome sem apagar campos da plataforma')

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
