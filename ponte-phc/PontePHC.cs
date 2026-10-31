// PontePHC - liga o PHC (SQL Server) ao Firebase da plataforma de Climatizacao.
// Fase atual: clientes do PHC -> Firestore (colecao "clientes", documentos "phc-<numero>").
// No PHC so LE (nunca escreve). Corre como servico Windows, separado do GuiasAT.
// Compila com o csc.exe do .NET Framework 4.x (sintaxe C# 5) e BouncyCastle.Crypto.dll 1.9.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Org.BouncyCastle.Crypto;
using Org.BouncyCastle.Crypto.Tls;
using Org.BouncyCastle.OpenSsl;
using Org.BouncyCastle.Security;
using BcX509 = Org.BouncyCastle.X509;

// ---------------------------------------------------------------- configuracao
class Config
{
    Dictionary<string, string> v = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    public string Ficheiro;
    public string Pasta;

    public Config(string ficheiro)
    {
        Ficheiro = ficheiro;
        Pasta = Path.GetDirectoryName(Path.GetFullPath(ficheiro));
        foreach (string l0 in File.ReadAllLines(ficheiro, Encoding.UTF8))
        {
            string l = l0.Trim();
            if (l == "" || l.StartsWith("#") || l.StartsWith(";")) continue;
            int i = l.IndexOf('=');
            if (i <= 0) continue;
            v[l.Substring(0, i).Trim()] = l.Substring(i + 1).Trim();
        }
    }

    public string Get(string k, string omissao)
    {
        string s;
        if (v.TryGetValue(k, out s) && s != "") return s;
        return omissao;
    }

    public int GetInt(string k, int omissao)
    {
        int n;
        return int.TryParse(Get(k, ""), out n) ? n : omissao;
    }

    public bool GetBool(string k, bool omissao)
    {
        string s = Get(k, omissao ? "1" : "0").ToLowerInvariant();
        return s == "1" || s == "sim" || s == "true";
    }

    // Valores secretos podem estar cifrados (dpapi:...) pelo comando /senha.
    public string GetSegredo(string k)
    {
        string s = Get(k, "");
        if (s.StartsWith("dpapi:"))
        {
            byte[] c = Convert.FromBase64String(s.Substring(6));
            byte[] p = System.Security.Cryptography.ProtectedData.Unprotect(c, Entropia,
                System.Security.Cryptography.DataProtectionScope.LocalMachine);
            return Encoding.UTF8.GetString(p);
        }
        return s;
    }

    public static readonly byte[] Entropia = Encoding.UTF8.GetBytes("PontePHC-503198749");

    public string Caminho(string k)
    {
        string s = Get(k, "");
        if (s == "") return "";
        return Path.IsPathRooted(s) ? s : Path.Combine(Pasta, s);
    }

    public bool Simular { get { return GetBool("Simular", true); } }
}

// ---------------------------------------------------------------- registo
static class Log
{
    static object tranca = new object();
    public static string Pasta = ".";
    public static bool Consola = false;

    public static void Info(string s) { Escrever("INFO ", s, false); }
    public static void Erro(string s) { Escrever("ERRO ", s, true); }

    static void Escrever(string nivel, string s, bool erro)
    {
        string l = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + nivel + s;
        lock (tranca)
        {
            try
            {
                string d = Path.Combine(Pasta, "logs");
                Directory.CreateDirectory(d);
                File.AppendAllText(Path.Combine(d, "PontePHC_" + DateTime.Now.ToString("yyyyMM") + ".log"), l + "\r\n", Encoding.UTF8);
                if (erro) File.AppendAllText(Path.Combine(Pasta, "PontePHC_ERROS.txt"), l + "\r\n", Encoding.UTF8);
            }
            catch { }
            if (Consola) Console.WriteLine(l);
        }
    }
}

// ---------------------------------------------------------------- JSON (minimo)
static class Json
{
    public static object Ler(string s)
    {
        int i = 0;
        object o = Valor(s, ref i);
        return o;
    }

    static void Espacos(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }

    static object Valor(string s, ref int i)
    {
        Espacos(s, ref i);
        if (i >= s.Length) throw new FormatException("JSON incompleto");
        char c = s[i];
        if (c == '{')
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            i++; Espacos(s, ref i);
            if (s[i] == '}') { i++; return d; }
            while (true)
            {
                Espacos(s, ref i);
                string k = Cadeia(s, ref i);
                Espacos(s, ref i);
                if (s[i] != ':') throw new FormatException("JSON: falta ':'");
                i++;
                d[k] = Valor(s, ref i);
                Espacos(s, ref i);
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return d; }
                throw new FormatException("JSON: esperado ',' ou '}'");
            }
        }
        if (c == '[')
        {
            List<object> l = new List<object>();
            i++; Espacos(s, ref i);
            if (s[i] == ']') { i++; return l; }
            while (true)
            {
                l.Add(Valor(s, ref i));
                Espacos(s, ref i);
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return l; }
                throw new FormatException("JSON: esperado ',' ou ']'");
            }
        }
        if (c == '"') return Cadeia(s, ref i);
        if (s.Substring(i).StartsWith("true")) { i += 4; return true; }
        if (s.Substring(i).StartsWith("false")) { i += 5; return false; }
        if (s.Substring(i).StartsWith("null")) { i += 4; return null; }
        int ini = i;
        while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
        if (i == ini) throw new FormatException("JSON: caracter inesperado '" + c + "'");
        return double.Parse(s.Substring(ini, i - ini), CultureInfo.InvariantCulture);
    }

    static string Cadeia(string s, ref int i)
    {
        if (s[i] != '"') throw new FormatException("JSON: esperado texto");
        i++;
        StringBuilder sb = new StringBuilder();
        while (s[i] != '"')
        {
            char c = s[i++];
            if (c != '\\') { sb.Append(c); continue; }
            char e = s[i++];
            switch (e)
            {
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'u': sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; break;
                default: sb.Append(e); break;
            }
        }
        i++;
        return sb.ToString();
    }

    public static string Texto(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20) sb.Append("\\u" + ((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    public static string Campo(object o, string k)
    {
        Dictionary<string, object> d = o as Dictionary<string, object>;
        object v;
        if (d == null || !d.TryGetValue(k, out v) || v == null) return "";
        return Convert.ToString(v, CultureInfo.InvariantCulture);
    }
}

// ---------------------------------------------------------------- HTTPS (BouncyCastle: TLS 1.2 mesmo no Windows antigo)
class Resposta
{
    public int Estado;
    public string Corpo;
}

static class Raizes
{
    // Certificados-raiz da Google (Google Trust Services). Validos ate 2036.
    static readonly string[] Pem = new string[] {
        // GTS Root R1
        "MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaMf/vo27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vXmX7wCl7raKb0xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7zUjwTcLCeoiKu7rPWRnWr4+wB7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0PfyblqAj+lug8aJRT7oM6iCsVlgmy4HqMLnXWnOunVmSPlk9orj2XwoSPwLxAwAtcvfaHszVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk9+aCEI3oncKKiPo4Zor8Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zqkUspzBmkMiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOORc92wO1AK/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYWk70paDPvOmbsB4om3xPXV2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+DVrNVjzRlwW5y0vtOUucxD/SVRNuJLDWcfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgFlQIDAQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQADggIBAJ+qQibbC5u+/x6Wki4+omVKapi6Ist9wTrYggoGxval3sBOh2Z5ofmmWJyq+bXmYOfg6LEeQkEzCzc9zolwFcq1JKjPa7XSQCGYzyI0zzvFIoTgxQ6KfF2I5DUkzps+GlQebtuyh6f88/qBVRRiClmpIgUxPoLW7ttXNLwzldMXG+gnoot7TiYaelpkttGsN/H9oPM47HLwEXWdyzRSjeZ2axfG34arJ45JK3VmgRAhpuo+9K4l/3wV3s6MJT/KYnAK9y8JZgfIPxz88NtFMN9iiMG1D53Dn0reWVlHxYciNuaCp+0KueIHoI17eko8cdLiA6EfMgfdG+RCzgwARWGAtQsgWSl4vflVy2PFPEz0tv/bal8xa5meLMFrUKTX5hgUvYU/Z6tGn6D/Qqc6f1zLXbBwHSs09dR2CQzreExZBfMzQsNhFRAbd03OIozUhfJFfbdT6u9AWpQKXCBfTkBdYiJ23//OYb2MI3jSNwLgjt7RETeJ9r/tSQdirpLsQBqvFAnZ0E6yove+7u7Y/9waLd64NnHi/Hm3lCXRSHNboTXns5lndcEZOitHTtNCjv0xyBZm2tIMPNuzjsmhDYAPexZ3FL//2wmUspO8IFgV6dtxQ/PeEMMA3KgqlbbC1j+Qa3bbbP6MvPJwNQzcmRk13NfIRmPVNnGuV/u3gm3c",
        // GTS Root R3
        "MIICCTCCAY6gAwIBAgINAgPluILrIPglJ209ZjAKBggqhkjOPQQDAzBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjMwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQfTzOHMymKoYTey8chWEGJ6ladK0uFxh1MJ7x/JlFyb+Kf1qPKzEUURout736GjOyxfi//qXGdGIRFBEFVbivqJn+7kAHjSxm65FSWRQmx1WyRRK2EE46ajA2ADDL24CejQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBTB8Sa6oC2uhYHP0/EqEr24Cmf9vDAKBggqhkjOPQQDAwNpADBmAjEA9uEglRR7VKOQFhG/hMjqb2sXnh5GmCCbn9MN2azTL818+FsuVbu/3ZL3pAzcMeGiAjEA/JdmZuVDFhOD3cffL74UOO0BzrEXGhF16b0DjyZ+hOXJYKaV11RZt+cRLInUue4X",
        // GTS Root R4
        "MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyiQHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvRHYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD",
    };

    static List<BcX509.X509Certificate> lista;
    public static List<BcX509.X509Certificate> Lista
    {
        get
        {
            if (lista == null)
            {
                lista = new List<BcX509.X509Certificate>();
                foreach (string b in Pem)
                    lista.Add(new BcX509.X509CertificateParser().ReadCertificate(Convert.FromBase64String(b)));
            }
            return lista;
        }
    }
}

class AutServidor : TlsAuthentication
{
    string host;
    Config cfg;

    public AutServidor(string h, Config c) { host = h; cfg = c; }

    static string Sha256(byte[] b)
    {
        using (System.Security.Cryptography.SHA256 sha = System.Security.Cryptography.SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(b)).Replace("-", "");
    }

    static bool NomeOk(BcX509.X509Certificate c, string host)
    {
        List<string> nomes = new List<string>();
        ICollection san = c.GetSubjectAlternativeNames();
        if (san != null)
            foreach (object o in san)
            {
                IList par = o as IList;
                if (par != null && par.Count >= 2 && Convert.ToInt32(par[0]) == 2) nomes.Add(Convert.ToString(par[1]));
            }
        foreach (string n in nomes)
        {
            if (n.Equals(host, StringComparison.OrdinalIgnoreCase)) return true;
            if (n.StartsWith("*.") && host.EndsWith(n.Substring(1), StringComparison.OrdinalIgnoreCase) &&
                host.Substring(0, host.Length - n.Length + 1).IndexOf('.') < 0) return true;
        }
        return false;
    }

    static bool MesmaChave(BcX509.X509Certificate a, BcX509.X509Certificate b)
    {
        return a.GetPublicKey().Equals(b.GetPublicKey());
    }

    // A cadeia enviada pelo servidor tem de chegar a uma raiz conhecida, com todas as assinaturas validas.
    static bool CadeiaConfiavel(List<BcX509.X509Certificate> cs)
    {
        for (int i = 0; i < cs.Count; i++)
        {
            BcX509.X509Certificate c = cs[i];
            if (!c.IsValidNow) return false;
            foreach (BcX509.X509Certificate r in Raizes.Lista)
            {
                if (i > 0 && MesmaChave(c, r)) return true;
                if (c.IssuerDN.Equivalent(r.SubjectDN))
                {
                    try { c.Verify(r.GetPublicKey()); return true; } catch { }
                }
            }
            if (i + 1 >= cs.Count) return false;
            if (!c.IssuerDN.Equivalent(cs[i + 1].SubjectDN)) return false;
            try { c.Verify(cs[i + 1].GetPublicKey()); } catch { return false; }
        }
        return false;
    }

    public void NotifyServerCertificate(Certificate cadeia)
    {
        if (cadeia == null || cadeia.IsEmpty) throw new TlsFatalAlert(AlertDescription.bad_certificate);
        List<BcX509.X509Certificate> cs = new List<BcX509.X509Certificate>();
        for (int i = 0; i < cadeia.Length; i++) cs.Add(new BcX509.X509Certificate(cadeia.GetCertificateAt(i)));
        string imp = Sha256(cs[0].GetEncoded());
        foreach (string s in cfg.Get("ImpressoesDigitais", "").Split(','))
            if (s.Trim() != "" && s.Trim().Replace(":", "").Equals(imp, StringComparison.OrdinalIgnoreCase)) return;
        bool nome = NomeOk(cs[0], host);
        bool cadeiaOk = CadeiaConfiavel(cs);
        if (nome && cadeiaOk) return;
        Log.Erro("Certificado de " + host + " nao validado (nome " + (nome ? "ok" : "NAO corresponde") +
                 ", cadeia " + (cadeiaOk ? "ok" : "NAO chega a uma raiz Google") + "). Impressao digital SHA-256: " + imp);
        throw new TlsFatalAlert(AlertDescription.bad_certificate);
    }

    public TlsCredentials GetClientCredentials(CertificateRequest pedido) { return null; }
}

class ClienteTls : DefaultTlsClient
{
    string host; Config cfg;
    public ClienteTls(string h, Config c) { host = h; cfg = c; }

    public override IDictionary GetClientExtensions()
    {
        IDictionary ext = TlsExtensionsUtilities.EnsureExtensionsInitialised(base.GetClientExtensions());
        IList nomes = new ArrayList();
        nomes.Add(new ServerName(NameType.host_name, host));
        TlsExtensionsUtilities.AddServerNameExtension(ext, new ServerNameList(nomes));
        return ext;
    }

    public override TlsAuthentication GetAuthentication() { return new AutServidor(host, cfg); }
}

static class Https
{
    public static Resposta Pedir(Config cfg, string host, string metodo, string caminho, string tipo, string corpo, string token)
    {
        int porta = cfg.GetInt("PortaHttps", 443);
        byte[] b = Encoding.UTF8.GetBytes(corpo ?? "");
        StringBuilder cab = new StringBuilder();
        cab.Append(metodo + " " + caminho + " HTTP/1.1\r\n");
        cab.Append("Host: " + host + (porta == 443 ? "" : ":" + porta) + "\r\n");
        cab.Append("User-Agent: PontePHC/1.0\r\n");
        cab.Append("Accept: application/json\r\n");
        if (token != null) cab.Append("Authorization: Bearer " + token + "\r\n");
        if (corpo != null) cab.Append("Content-Type: " + tipo + "\r\nContent-Length: " + b.Length + "\r\n");
        cab.Append("Connection: close\r\n\r\n");

        using (TcpClient tcp = new TcpClient())
        {
            IAsyncResult ar = tcp.BeginConnect(cfg.Get("LigarA", host), porta, null, null);
            if (!ar.AsyncWaitHandle.WaitOne(15000)) throw new IOException("Sem resposta de " + host + ":" + porta + " em 15 s.");
            tcp.EndConnect(ar);
            tcp.ReceiveTimeout = 60000;
            tcp.SendTimeout = 60000;
            TlsClientProtocol tls = new TlsClientProtocol(tcp.GetStream(), new SecureRandom());
            tls.Connect(new ClienteTls(host, cfg));
            Stream s = tls.Stream;
            byte[] c = Encoding.ASCII.GetBytes(cab.ToString());
            s.Write(c, 0, c.Length);
            if (corpo != null) s.Write(b, 0, b.Length);
            s.Flush();
            MemoryStream ms = new MemoryStream();
            byte[] buf = new byte[16384];
            try
            {
                int n;
                while ((n = s.Read(buf, 0, buf.Length)) > 0) ms.Write(buf, 0, n);
            }
            catch (IOException) { if (ms.Length == 0) throw; }
            try { tls.Close(); } catch { }
            return Interpretar(ms.ToArray());
        }
    }

    static Resposta Interpretar(byte[] bruto)
    {
        int fim = -1;
        for (int i = 0; i + 3 < bruto.Length; i++)
            if (bruto[i] == 13 && bruto[i + 1] == 10 && bruto[i + 2] == 13 && bruto[i + 3] == 10) { fim = i; break; }
        if (fim < 0) throw new IOException("Resposta HTTP invalida (" + bruto.Length + " bytes).");
        string cab = Encoding.ASCII.GetString(bruto, 0, fim);
        byte[] corpo = new byte[bruto.Length - fim - 4];
        Array.Copy(bruto, fim + 4, corpo, 0, corpo.Length);
        if (Regex.IsMatch(cab, @"(?im)^Transfer-Encoding:\s*chunked"))
        {
            MemoryStream ms = new MemoryStream();
            int p = 0;
            while (p < corpo.Length)
            {
                int e = p;
                while (e + 1 < corpo.Length && !(corpo[e] == 13 && corpo[e + 1] == 10)) e++;
                string t = Encoding.ASCII.GetString(corpo, p, e - p).Split(';')[0].Trim();
                int tam = t == "" ? 0 : int.Parse(t, NumberStyles.HexNumber);
                p = e + 2;
                if (tam == 0) break;
                if (p + tam > corpo.Length) tam = corpo.Length - p;
                ms.Write(corpo, p, tam);
                p += tam + 2;
            }
            corpo = ms.ToArray();
        }
        Resposta r = new Resposta();
        Match m = Regex.Match(cab, @"^HTTP/\d\.\d\s+(\d{3})");
        if (!m.Success) throw new IOException("Resposta HTTP sem estado: " + cab.Split('\r')[0]);
        r.Estado = int.Parse(m.Groups[1].Value);
        r.Corpo = Encoding.UTF8.GetString(corpo);
        return r;
    }
}

// ---------------------------------------------------------------- Google: conta de servico (OAuth2 JWT)
class ContaServico
{
    Config cfg;
    public string Email, ProjetoDaChave;
    AsymmetricKeyParameter chave;
    string tokenUri;
    string token;
    DateTime expira = DateTime.MinValue;

    public ContaServico(Config c)
    {
        cfg = c;
        string f = cfg.Caminho("ChaveServico");
        if (f == "" || !File.Exists(f)) throw new Exception("Ficheiro da chave de servico do Firebase nao encontrado (chave ChaveServico): " + f);
        object j = Json.Ler(File.ReadAllText(f, Encoding.UTF8));
        Email = Json.Campo(j, "client_email");
        ProjetoDaChave = Json.Campo(j, "project_id");
        tokenUri = Json.Campo(j, "token_uri");
        if (tokenUri == "") tokenUri = "https://oauth2.googleapis.com/token";
        string pem = Json.Campo(j, "private_key");
        if (Email == "" || pem == "") throw new Exception("A chave de servico nao tem client_email/private_key. E o ficheiro JSON certo?");
        object o = new PemReader(new StringReader(pem)).ReadObject();
        chave = o is AsymmetricCipherKeyPair ? ((AsymmetricCipherKeyPair)o).Private : o as AsymmetricKeyParameter;
        if (chave == null) throw new Exception("Nao foi possivel ler a chave privada da conta de servico.");
    }

    static string B64Url(byte[] b)
    {
        return Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public string Token()
    {
        if (token != null && DateTime.UtcNow < expira) return token;
        Uri u = new Uri(cfg.Get("TokenUri", tokenUri));
        long agora = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
        string cab = B64Url(Encoding.UTF8.GetBytes("{\"alg\":\"RS256\",\"typ\":\"JWT\"}"));
        string dados = B64Url(Encoding.UTF8.GetBytes(
            "{\"iss\":" + Json.Texto(Email) +
            ",\"scope\":\"https://www.googleapis.com/auth/datastore\"" +
            ",\"aud\":" + Json.Texto(tokenUri) +
            ",\"iat\":" + agora + ",\"exp\":" + (agora + 3600) + "}"));
        ISigner s = SignerUtilities.GetSigner("SHA-256withRSA");
        s.Init(true, chave);
        byte[] b = Encoding.ASCII.GetBytes(cab + "." + dados);
        s.BlockUpdate(b, 0, b.Length);
        string jwt = cab + "." + dados + "." + B64Url(s.GenerateSignature());
        string corpo = "grant_type=" + Uri.EscapeDataString("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt;
        Resposta r = Https.Pedir(cfg, u.Host, "POST", u.AbsolutePath, "application/x-www-form-urlencoded", corpo, null);
        if (r.Estado != 200) throw new Exception("Google recusou a autenticacao (HTTP " + r.Estado + "): " + Resumir(r.Corpo));
        object j = Json.Ler(r.Corpo);
        token = Json.Campo(j, "access_token");
        double seg;
        double.TryParse(Json.Campo(j, "expires_in"), NumberStyles.Any, CultureInfo.InvariantCulture, out seg);
        expira = DateTime.UtcNow.AddSeconds(Math.Max(60, seg - 120));
        return token;
    }

    public static string Resumir(string s)
    {
        s = (s ?? "").Replace("\r", " ").Replace("\n", " ");
        return s.Length > 400 ? s.Substring(0, 400) + "..." : s;
    }
}

// ---------------------------------------------------------------- Firestore (REST)
class Documento
{
    public string Id;
    public List<string> Campos = new List<string>();      // nomes (updateMask)
    public StringBuilder Json = new StringBuilder();       // "campo":{valor},...

    void Por(string k, string valor)
    {
        if (Json.Length > 0) Json.Append(',');
        Json.Append(global::Json.Texto(k)).Append(':').Append(valor);
        Campos.Add(k);
    }
    public void Texto(string k, string v) { Por(k, "{\"stringValue\":" + global::Json.Texto(v ?? "") + "}"); }
    public void Bool(string k, bool v) { Por(k, "{\"booleanValue\":" + (v ? "true" : "false") + "}"); }
    public void Nulo(string k) { Por(k, "{\"nullValue\":null}"); }
    public void Lista(string k, List<string> l)
    {
        StringBuilder sb = new StringBuilder();
        foreach (string s in l) { if (sb.Length > 0) sb.Append(','); sb.Append("{\"stringValue\":").Append(global::Json.Texto(s)).Append('}'); }
        Por(k, "{\"arrayValue\":{\"values\":[" + sb + "]}}");
    }
}

class Firestore
{
    Config cfg;
    ContaServico conta;
    public string Projeto;
    string host;

    public Firestore(Config c)
    {
        cfg = c;
        conta = new ContaServico(c);
        Projeto = cfg.Get("FirebaseProjeto", "climatizacao-c482a");
        if (conta.ProjetoDaChave != "" && conta.ProjetoDaChave != Projeto)
            throw new Exception("A chave de servico e do projeto " + conta.ProjetoDaChave + ", mas FirebaseProjeto=" + Projeto + ".");
        host = cfg.Get("FirestoreServidor", "firestore.googleapis.com");
    }

    string Base { get { return "/v1/projects/" + Projeto + "/databases/(default)/documents"; } }

    // Cria ou atualiza (so os campos indicados; os restantes campos do documento ficam intactos).
    public void Gravar(string colecao, List<Documento> docs)
    {
        if (docs.Count == 0) return;
        StringBuilder sb = new StringBuilder("{\"writes\":[");
        for (int i = 0; i < docs.Count; i++)
        {
            Documento d = docs[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"update\":{\"name\":").Append(Json.Texto("projects/" + Projeto + "/databases/(default)/documents/" + colecao + "/" + d.Id));
            sb.Append(",\"fields\":{").Append(d.Json).Append("}},\"updateMask\":{\"fieldPaths\":[");
            for (int k = 0; k < d.Campos.Count; k++) { if (k > 0) sb.Append(','); sb.Append(Json.Texto(d.Campos[k])); }
            sb.Append("]},\"updateTransforms\":[{\"fieldPath\":\"sincronizadoEm\",\"setToServerValue\":\"REQUEST_TIME\"}]}");
        }
        sb.Append("]}");
        Resposta r = Https.Pedir(cfg, host, "POST", Base + ":commit", "application/json; charset=utf-8", sb.ToString(), conta.Token());
        if (r.Estado != 200) throw new Exception("Firestore recusou a gravacao (HTTP " + r.Estado + "): " + ContaServico.Resumir(r.Corpo));
    }

    // So le 1 documento de utilizadores: confirma ligacao, certificado e chave.
    public string Testar()
    {
        Resposta r = Https.Pedir(cfg, host, "GET", Base + "/utilizadores?pageSize=1", null, null, conta.Token());
        if (r.Estado != 200) throw new Exception("HTTP " + r.Estado + ": " + ContaServico.Resumir(r.Corpo));
        return "Firestore do projeto " + Projeto + " acessivel com a conta " + conta.Email + ".";
    }
}

// ---------------------------------------------------------------- clientes do PHC
class ClientePHC
{
    public long No;
    public int Estab;
    public string Nome = "", Ncont = "", Morada = "", Local = "", CodPost = "", Telefone = "", Email = "", Contacto = "";
    public bool Inativo;
    public DateTime Data;
    public string Hora = "";
}

// Ponto onde a sincronizacao ficou (ultimo cliente enviado, pela data/hora de alteracao no PHC).
class Marca
{
    public DateTime Data = new DateTime(1900, 1, 1);
    public string Hora = "";
    public long No = -1;

    public static Marca Ler(string f)
    {
        Marca m = new Marca();
        if (!File.Exists(f)) return m;
        string[] p = File.ReadAllText(f).Trim().Split('|');
        if (p.Length == 3)
        {
            m.Data = DateTime.ParseExact(p[0], "yyyy-MM-dd", CultureInfo.InvariantCulture);
            m.Hora = p[1];
            m.No = long.Parse(p[2]);
        }
        return m;
    }

    public void Gravar(string f)
    {
        File.WriteAllText(f, Data.ToString("yyyy-MM-dd") + "|" + Hora + "|" + No);
    }

    public override string ToString() { return Data.ToString("yyyy-MM-dd") + " " + Hora + " n." + No; }
}

interface IFonteClientes
{
    List<ClientePHC> Seguintes(Marca desde, int max);
    int Total();
}

class PhcSql : IFonteClientes
{
    Config cfg;
    HashSet<string> colunas;

    public PhcSql(Config c) { cfg = c; }

    SqlConnection Abrir()
    {
        SqlConnectionStringBuilder b = new SqlConnectionStringBuilder(
            cfg.Get("SqlLigacao", "Data Source=.;Initial Catalog=ARPURO;Integrated Security=True"));
        string senha = cfg.GetSegredo("SqlSenha");
        if (senha != "") { b.IntegratedSecurity = false; b.UserID = cfg.Get("SqlUtilizador", "sa"); b.Password = senha; }
        b.ApplicationName = "PontePHC";
        b.ConnectTimeout = 15;
        SqlConnection cn = new SqlConnection(b.ConnectionString);
        cn.Open();
        return cn;
    }

    // Usa so as colunas que existem nesta versao do PHC.
    HashSet<string> Colunas(SqlConnection cn)
    {
        if (colunas != null) return colunas;
        HashSet<string> h = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using (SqlCommand c = new SqlCommand("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'cl'", cn))
        using (SqlDataReader r = c.ExecuteReader())
            while (r.Read()) h.Add(r.GetString(0));
        foreach (string obr in new string[] { "no", "estab", "nome", "ncont", "usrdata", "usrhora" })
            if (!h.Contains(obr)) throw new Exception("A tabela cl do PHC nao tem a coluna " + obr + ".");
        colunas = h;
        return h;
    }

    string Opcional(string col) { return colunas.Contains(col) ? "cl." + col : "''"; }

    string Filtro() { return " " + cfg.Get("ClientesFiltro", "") + " "; }

    public int Total()
    {
        using (SqlConnection cn = Abrir())
        {
            Colunas(cn);
            using (SqlCommand c = new SqlCommand("SELECT COUNT(*) FROM cl WITH (NOLOCK) WHERE cl.estab = 0" + Filtro(), cn))
                return Convert.ToInt32(c.ExecuteScalar());
        }
    }

    public List<ClientePHC> Seguintes(Marca m, int max)
    {
        List<ClientePHC> l = new List<ClientePHC>();
        using (SqlConnection cn = Abrir())
        {
            Colunas(cn);
            string sql =
                "SELECT TOP (@max) cl.no, cl.estab, cl.nome, cl.ncont, " +
                Opcional("morada") + " AS morada, " + Opcional("local") + " AS local, " + Opcional("codpost") + " AS codpost, " +
                Opcional("telefone") + " AS telefone, " + Opcional("tlmvl") + " AS tlmvl, " + Opcional("email") + " AS email, " +
                Opcional("contacto") + " AS contacto, " + (colunas.Contains("inactivo") ? "cl.inactivo" : "0") + " AS inactivo, " +
                "cl.usrdata, cl.usrhora FROM cl WITH (NOLOCK) " +
                "WHERE cl.estab = 0 AND (cl.usrdata > @d OR (cl.usrdata = @d AND cl.usrhora > @h) " +
                "OR (cl.usrdata = @d AND cl.usrhora = @h AND cl.no > @no))" + Filtro() +
                "ORDER BY cl.usrdata, cl.usrhora, cl.no";
            using (SqlCommand c = new SqlCommand(sql, cn))
            {
                c.Parameters.AddWithValue("@max", max);
                c.Parameters.AddWithValue("@d", m.Data);
                c.Parameters.AddWithValue("@h", m.Hora);
                c.Parameters.AddWithValue("@no", m.No);
                using (SqlDataReader r = c.ExecuteReader())
                    while (r.Read())
                    {
                        ClientePHC x = new ClientePHC();
                        x.No = Convert.ToInt64(r["no"]);
                        x.Estab = Convert.ToInt32(r["estab"]);
                        x.Nome = S(r, "nome"); x.Ncont = S(r, "ncont");
                        x.Morada = S(r, "morada"); x.Local = S(r, "local"); x.CodPost = S(r, "codpost");
                        x.Telefone = S(r, "telefone"); if (x.Telefone == "") x.Telefone = S(r, "tlmvl");
                        x.Email = S(r, "email"); x.Contacto = S(r, "contacto");
                        x.Inativo = r["inactivo"] != DBNull.Value && Convert.ToBoolean(r["inactivo"]);
                        x.Data = r["usrdata"] == DBNull.Value ? new DateTime(1900, 1, 1) : Convert.ToDateTime(r["usrdata"]).Date;
                        x.Hora = S(r, "usrhora");
                        l.Add(x);
                    }
            }
        }
        return l;
    }

    static string S(SqlDataReader r, string col)
    {
        object o = r[col];
        return o == DBNull.Value ? "" : o.ToString().Trim();
    }

    public List<string> ListaColunas()
    {
        using (SqlConnection cn = Abrir())
        {
            List<string> l = new List<string>(Colunas(cn));
            l.Sort();
            return l;
        }
    }
}

// So para testes: le os clientes de um ficheiro CSV (separador ;) com as mesmas colunas do PHC.
class FonteCsv : IFonteClientes
{
    List<ClientePHC> todos = new List<ClientePHC>();

    public FonteCsv(string f)
    {
        string[] ls = File.ReadAllLines(f, Encoding.UTF8);
        string[] cab = ls[0].Split(';');
        for (int i = 1; i < ls.Length; i++)
        {
            if (ls[i].Trim() == "") continue;
            string[] v = ls[i].Split(';');
            Dictionary<string, string> d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int k = 0; k < cab.Length; k++) d[cab[k]] = k < v.Length ? v[k] : "";
            ClientePHC x = new ClientePHC();
            x.No = long.Parse(d["no"]); x.Estab = int.Parse(d["estab"]);
            x.Nome = d["nome"]; x.Ncont = d["ncont"]; x.Morada = d["morada"]; x.Local = d["local"]; x.CodPost = d["codpost"];
            x.Telefone = d["telefone"]; x.Email = d["email"]; x.Contacto = d["contacto"]; x.Inativo = d["inactivo"] == "1";
            x.Data = DateTime.ParseExact(d["usrdata"], "yyyy-MM-dd", CultureInfo.InvariantCulture); x.Hora = d["usrhora"];
            todos.Add(x);
        }
    }

    public int Total() { return todos.FindAll(delegate(ClientePHC c) { return c.Estab == 0; }).Count; }

    public List<ClientePHC> Seguintes(Marca m, int max)
    {
        List<ClientePHC> l = todos.FindAll(delegate(ClientePHC c)
        {
            if (c.Estab != 0) return false;
            int a = c.Data.CompareTo(m.Data);
            if (a != 0) return a > 0;
            int b = string.CompareOrdinal(c.Hora, m.Hora);
            if (b != 0) return b > 0;
            return c.No > m.No;
        });
        l.Sort(delegate(ClientePHC x, ClientePHC y)
        {
            int a = x.Data.CompareTo(y.Data); if (a != 0) return a;
            int b = string.CompareOrdinal(x.Hora, y.Hora); if (b != 0) return b;
            return x.No.CompareTo(y.No);
        });
        return l.GetRange(0, Math.Min(max, l.Count));
    }
}

// ---------------------------------------------------------------- regras iguais as da plataforma web
static class Regras
{
    public static string Normalizar(string s)
    {
        string d = (s ?? "").ToLowerInvariant().Normalize(NormalizationForm.FormD);
        StringBuilder sb = new StringBuilder();
        foreach (char c in d)
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) sb.Append(c);
        return sb.ToString().Normalize(NormalizationForm.FormC);
    }

    // Prefixos (2 a 15 letras) de cada palavra: a pesquisa da plataforma usa estes valores.
    public static List<string> Tokens(params string[] textos)
    {
        List<string> l = new List<string>();
        HashSet<string> vistos = new HashSet<string>();
        foreach (string t in textos)
            foreach (string p in Regex.Split(Normalizar(t), "[^a-z0-9]+"))
                for (int i = 2; i <= Math.Min(p.Length, 15); i++)
                {
                    string x = p.Substring(0, i);
                    if (vistos.Add(x)) l.Add(x);
                }
        return l;
    }

    // Devolve o NIF normalizado e o pais; valido=false se nao passar na validacao.
    public static string Nif(string entrada, out string pais, out bool valido)
    {
        string v = Regex.Replace((entrada ?? "").ToUpperInvariant(), @"[\s.\-/]", "");
        pais = ""; valido = false;
        if (v == "") return "";
        string pt = v.StartsWith("PT") ? v.Substring(2) : v;
        if (Regex.IsMatch(pt, @"^\d+$"))
        {
            pais = "PT";
            if (pt.Length != 9 || !Regex.IsMatch(pt, @"^([1235689]|45|7[0-9])")) return pt;
            int soma = 0;
            for (int i = 0; i < 8; i++) soma += (pt[i] - '0') * (9 - i);
            int ctrl = 11 - soma % 11;
            if (ctrl >= 10) ctrl = 0;
            valido = ctrl == pt[8] - '0';
            return pt;
        }
        Match m = Regex.Match(v, @"^([A-Z]{2})([A-Z0-9]{2,13})$");
        if (m.Success && m.Groups[1].Value != "PT" && Regex.IsMatch(m.Groups[2].Value, @"\d"))
        {
            pais = m.Groups[1].Value; valido = true;
            return v;
        }
        return v;
    }
}

// ---------------------------------------------------------------- motor
class Motor
{
    Config cfg;
    IFonteClientes fonte;
    Firestore fs;
    string fMarca, fQuota;
    string ultimoErro = "";

    public Motor(Config c)
    {
        cfg = c;
        string teste = cfg.Caminho("FonteTeste");
        fonte = teste != "" ? (IFonteClientes)new FonteCsv(teste) : new PhcSql(c);
        fMarca = Path.Combine(cfg.Pasta, "estado_clientes.txt");
        fQuota = Path.Combine(cfg.Pasta, "estado_escritas.txt");
    }

    public IFonteClientes Fonte { get { return fonte; } }

    public void Preparar()
    {
        Log.Info("PontePHC a iniciar. Projeto Firebase: " + cfg.Get("FirebaseProjeto", "climatizacao-c482a") +
                 (cfg.Simular ? " (SIMULACAO: nada e enviado)" : "") +
                 ". Clientes: " + (cfg.GetBool("Clientes", true) ? "sim" : "nao") +
                 (cfg.Get("ClientesFiltro", "") != "" ? " (filtro: " + cfg.Get("ClientesFiltro", "") + ")" : ""));
        if (!cfg.Simular && fs == null) fs = new Firestore(cfg);
    }

    int EscritasHoje()
    {
        if (!File.Exists(fQuota)) return 0;
        string[] p = File.ReadAllText(fQuota).Trim().Split('|');
        return p.Length == 2 && p[0] == DateTime.Now.ToString("yyyy-MM-dd") ? int.Parse(p[1]) : 0;
    }

    void ContarEscritas(int n)
    {
        File.WriteAllText(fQuota, DateTime.Now.ToString("yyyy-MM-dd") + "|" + (EscritasHoje() + n));
    }

    public static Documento Converter(ClientePHC c)
    {
        Documento d = new Documento();
        d.Id = "phc-" + c.No + (c.Estab != 0 ? "-" + c.Estab : "");
        string pais; bool valido;
        string nif = Regras.Nif(c.Ncont, out pais, out valido);
        string nome = Regex.Replace(c.Nome, @"\s+", " ").Trim();
        d.Texto("nome", nome);
        d.Texto("nomePesquisa", Regras.Normalizar(nome));
        d.Lista("pesquisa", Regras.Tokens(nome, c.Local));
        d.Texto("nif", nif);
        d.Texto("nifPais", pais);
        d.Bool("nifValido", valido);
        d.Texto("morada", c.Morada);
        d.Texto("codigoPostal", c.CodPost);
        d.Texto("localidade", c.Local);
        d.Texto("telefone", c.Telefone);
        d.Texto("email", c.Email);
        d.Texto("contacto", c.Contacto);
        d.Bool("ativo", !c.Inativo);
        d.Texto("origem", "phc");
        d.Texto("phcId", c.No.ToString());
        return d;
    }

    // Um ciclo: envia, em lotes, os clientes criados/alterados no PHC desde a ultima vez.
    public int Ciclo()
    {
        int enviados = 0;
        try
        {
            if (!cfg.GetBool("Clientes", true)) return 0;
            int lote = Math.Min(500, Math.Max(1, cfg.GetInt("Lote", 400)));
            int limite = cfg.GetInt("MaxEscritasPorDia", 15000);
            Marca m = Marca.Ler(fMarca);
            while (true)
            {
                int livres = limite - EscritasHoje();
                if (livres <= 0)
                {
                    if (ultimoErro != "quota") Log.Info("Limite diario de escritas atingido (" + limite + "). Continua amanha.");
                    ultimoErro = "quota";
                    break;
                }
                List<ClientePHC> l = fonte.Seguintes(m, Math.Min(lote, livres));
                if (l.Count == 0) break;
                List<Documento> docs = new List<Documento>();
                foreach (ClientePHC c in l) if (c.Nome.Trim() != "") docs.Add(Converter(c));
                if (cfg.Simular)
                {
                    foreach (Documento d in docs) Log.Info("SIMULACAO: enviaria clientes/" + d.Id);
                }
                else
                {
                    fs.Gravar("clientes", docs);
                    ContarEscritas(docs.Count);
                }
                ClientePHC u = l[l.Count - 1];
                m.Data = u.Data; m.Hora = u.Hora; m.No = u.No;
                if (!cfg.Simular) m.Gravar(fMarca);
                enviados += docs.Count;
                if (l.Count < Math.Min(lote, livres)) break;
                if (cfg.Simular && enviados >= 2000) { Log.Info("SIMULACAO: parado aos 2000 clientes."); break; }
            }
            if (enviados > 0) Log.Info((cfg.Simular ? "SIMULACAO: " : "") + enviados + " clientes " + (cfg.Simular ? "seriam enviados" : "enviados") + ". Marca: " + m);
            if (ultimoErro != "quota") ultimoErro = "";
        }
        catch (Exception e)
        {
            string msg = e.GetType().Name + ": " + e.Message;
            if (msg != ultimoErro) Log.Erro("Falha na sincronizacao de clientes: " + msg + (enviados > 0 ? " (" + enviados + " enviados antes da falha)" : ""));
            ultimoErro = msg;
        }
        return enviados;
    }

    public string TestarFirebase()
    {
        if (fs == null) fs = new Firestore(cfg);
        return fs.Testar();
    }

    public string UltimoErro { get { return ultimoErro; } }

    public void Recomecar()
    {
        if (File.Exists(fMarca)) File.Delete(fMarca);
    }
}

// ---------------------------------------------------------------- servico Windows
class Servico : ServiceBase
{
    Thread fio;
    volatile bool parar;
    public static string FicheiroConfig;

    public Servico() { ServiceName = "PontePHC"; }

    protected override void OnStart(string[] args)
    {
        parar = false;
        fio = new Thread(Correr);
        fio.IsBackground = true;
        fio.Start();
    }

    protected override void OnStop()
    {
        parar = true;
        if (fio != null) fio.Join(10000);
        Log.Info("PontePHC parado.");
    }

    public void Correr()
    {
        Motor m = null;
        while (!parar && m == null)
        {
            try
            {
                Config cfg = new Config(FicheiroConfig);
                m = new Motor(cfg);
                m.Preparar();
                int intervalo = Math.Max(1, cfg.GetInt("IntervaloMinutos", 10)) * 60;
                while (!parar)
                {
                    m.Ciclo();
                    for (int i = 0; i < intervalo * 2 && !parar; i++) Thread.Sleep(500);
                }
            }
            catch (Exception e)
            {
                Log.Erro("Nao foi possivel iniciar: " + e.GetType().Name + ": " + e.Message + ". Nova tentativa dentro de 5 minutos.");
                m = null;
                for (int i = 0; i < 600 && !parar; i++) Thread.Sleep(500);
            }
        }
    }

    public void PararConsola() { parar = true; }
}

// ---------------------------------------------------------------- arranque
static class Programa
{
    static string LerOculto()
    {
        StringBuilder sb = new StringBuilder();
        while (true)
        {
            ConsoleKeyInfo k = Console.ReadKey(true);
            if (k.Key == ConsoleKey.Enter) break;
            if (k.Key == ConsoleKey.Backspace) { if (sb.Length > 0) sb.Length--; continue; }
            if (k.KeyChar != '\0') sb.Append(k.KeyChar);
        }
        Console.WriteLine();
        return sb.ToString();
    }

    static int GuardarSenha(string fcfg, string chave)
    {
        if (chave != "SqlSenha") { Console.WriteLine("Chave invalida. Use: SqlSenha"); return 1; }
        Console.Write("Valor para " + chave + " (nao aparece no ecra): ");
        string a = LerOculto();
        Console.Write("Repita: ");
        string b = LerOculto();
        if (a != b || a == "") { Console.WriteLine("Os valores nao coincidem ou estao vazios. Nada foi gravado."); return 1; }
        byte[] c = System.Security.Cryptography.ProtectedData.Protect(Encoding.UTF8.GetBytes(a), Config.Entropia,
            System.Security.Cryptography.DataProtectionScope.LocalMachine);
        string linha = chave + "=dpapi:" + Convert.ToBase64String(c);
        List<string> ls = new List<string>(File.ReadAllLines(fcfg, Encoding.UTF8));
        bool feito = false;
        for (int i = 0; i < ls.Count; i++)
        {
            string t = ls[i].TrimStart('#', ';', ' ');
            if (t.StartsWith(chave + "=", StringComparison.OrdinalIgnoreCase)) { ls[i] = linha; feito = true; break; }
        }
        if (!feito) ls.Add(linha);
        File.WriteAllLines(fcfg, ls.ToArray(), new UTF8Encoding(false));
        Console.WriteLine(chave + " gravada (cifrada) em " + Path.GetFileName(fcfg) + ".");
        return 0;
    }

    static int Main(string[] args)
    {
        string pasta = AppDomain.CurrentDomain.BaseDirectory;
        string fcfg = Path.Combine(pasta, "PontePHC.ini");
        string arg0 = args.Length > 0 ? args[0] : "";
        if (arg0.StartsWith("/config="))   // usado nos testes automaticos
        {
            fcfg = Path.GetFullPath(arg0.Substring(8));
            pasta = Path.GetDirectoryName(fcfg);
            List<string> resto = new List<string>(args);
            resto.RemoveAt(0);
            args = resto.ToArray();
        }
        Log.Pasta = pasta;
        Servico.FicheiroConfig = fcfg;

        if (!Environment.UserInteractive && args.Length == 0)
        {
            ServiceBase.Run(new Servico());
            return 0;
        }

        Log.Consola = true;
        if (!File.Exists(fcfg)) { Console.WriteLine("Falta o ficheiro PontePHC.ini nesta pasta."); return 1; }
        try
        {
            string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "";
            if (cmd == "/senha" && args.Length == 2) return GuardarSenha(fcfg, args[1]);
            Config cfg = new Config(fcfg);
            Motor m = new Motor(cfg);

            if (cmd == "/testar-sql")
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql != null) Console.WriteLine("Colunas da tabela cl: " + string.Join(", ", sql.ListaColunas().ToArray()));
                Console.WriteLine("Clientes (estab 0" + (cfg.Get("ClientesFiltro", "") != "" ? ", com filtro" : "") + "): " + m.Fonte.Total());
                List<ClientePHC> l = m.Fonte.Seguintes(new Marca(), 5);
                foreach (ClientePHC c in l)
                {
                    string pais; bool ok;
                    string nif = Regras.Nif(c.Ncont, out pais, out ok);
                    Console.WriteLine("  n." + c.No + "  " + c.Nome + "  NIF " + nif + (ok ? "" : " (invalido)") + "  " + c.Local + "  alterado " + c.Data.ToString("yyyy-MM-dd") + " " + c.Hora);
                }
                Console.WriteLine("Nada foi enviado.");
                return 0;
            }
            if (cmd == "/testar-firebase")
            {
                Console.WriteLine(m.TestarFirebase());
                Console.WriteLine("Ligacao segura, certificado da Google e chave de servico OK. Nada foi enviado.");
                return 0;
            }
            if (cmd == "/sincronizar")
            {
                m.Preparar();
                int n = m.Ciclo();
                Console.WriteLine((cfg.Simular ? "SIMULACAO: " : "") + n + " clientes " + (cfg.Simular ? "seriam enviados (nada enviado; veja Simular no .ini)." : "enviados."));
                return m.UltimoErro == "" || m.UltimoErro == "quota" ? 0 : 2;
            }
            if (cmd == "/recomecar")
            {
                m.Recomecar();
                Console.WriteLine("Marca apagada: na proxima sincronizacao todos os clientes sao enviados de novo.");
                return 0;
            }
            if (cmd != "")
            {
                Console.WriteLine("Comandos:");
                Console.WriteLine("  PontePHC.exe                    corre na consola (Ctrl+C para parar)");
                Console.WriteLine("  PontePHC.exe /testar-sql        mostra colunas, total e 5 clientes do PHC; nada e enviado");
                Console.WriteLine("  PontePHC.exe /testar-firebase   testa a ligacao ao Firebase e a chave; nada e enviado");
                Console.WriteLine("  PontePHC.exe /sincronizar       faz uma sincronizacao agora");
                Console.WriteLine("  PontePHC.exe /recomecar         volta a enviar todos os clientes na proxima vez");
                Console.WriteLine("  PontePHC.exe /senha SqlSenha    grava a senha do SQL, cifrada");
                return 1;
            }
            Servico s = new Servico();
            Console.CancelKeyPress += delegate(object o, ConsoleCancelEventArgs e) { e.Cancel = true; s.PararConsola(); };
            Console.WriteLine("PontePHC a correr na consola. Ctrl+C para parar.");
            s.Correr();
            return 0;
        }
        catch (Exception e)
        {
            Log.Erro(e.GetType().Name + ": " + e.Message);
            return 1;
        }
    }
}
