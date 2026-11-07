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
using System.Net;
using System.Net.Mail;
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

    public Dictionary<string, string> ComPrefixo(string prefixo)
    {
        Dictionary<string, string> r = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (KeyValuePair<string, string> kv in v)
            if (kv.Key.StartsWith(prefixo, StringComparison.OrdinalIgnoreCase) && kv.Value != "") r[kv.Key.Substring(prefixo.Length)] = kv.Value;
        return r;
    }
}

// ---------------------------------------------------------------- registo
static class Log
{
    static object tranca = new object();
    public static string Pasta = ".";
    public static bool Consola = false;

    // apaga os registos mensais com mais de 6 meses (chamado no arranque)
    public static void Limpar()
    {
        try
        {
            string d = Path.Combine(Pasta, "logs");
            if (!Directory.Exists(d)) return;
            string limite = "PontePHC_" + DateTime.Now.AddMonths(-6).ToString("yyyyMM") + ".log";
            foreach (string f in Directory.GetFiles(d, "PontePHC_??????.log"))
                if (string.CompareOrdinal(Path.GetFileName(f), limite) < 0) File.Delete(f);
        }
        catch { }
    }

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
    public void Inteiro(string k, long v) { Por(k, "{\"integerValue\":\"" + v + "\"}"); }
    public void Decimal(string k, decimal v) { Por(k, "{\"doubleValue\":" + v.ToString(CultureInfo.InvariantCulture) + "}"); }
    public static string ValorData(DateTime d)
    {
        return "{\"timestampValue\":\"" + d.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture) + "\"}";
    }
    public void Data(string k, DateTime? d) { Por(k, d.HasValue ? ValorData(d.Value) : "{\"nullValue\":null}"); }
    public string ComoMapa() { return "{\"mapValue\":{\"fields\":{" + Json + "}}}"; }
    public void Mapa(string k, Documento m) { Por(k, m.ComoMapa()); }
    public void ListaMapas(string k, List<Documento> l)
    {
        StringBuilder sb = new StringBuilder();
        foreach (Documento m in l) { if (sb.Length > 0) sb.Append(','); sb.Append(m.ComoMapa()); }
        Por(k, "{\"arrayValue\":{\"values\":[" + sb + "]}}");
    }
    // Transformacoes extra (ex.: acrescentar ao historico sem o reescrever).
    public List<string> Transformacoes = new List<string>();
    public void Acrescentar(string k, Documento elemento)
    {
        Transformacoes.Add("{\"fieldPath\":" + global::Json.Texto(k) + ",\"appendMissingElements\":{\"values\":[" + elemento.ComoMapa() + "]}}");
    }
    public void HoraServidor(string k)
    {
        Transformacoes.Add("{\"fieldPath\":" + global::Json.Texto(k) + ",\"setToServerValue\":\"REQUEST_TIME\"}");
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
            sb.Append("]},\"updateTransforms\":[{\"fieldPath\":\"sincronizadoEm\",\"setToServerValue\":\"REQUEST_TIME\"}");
            foreach (string t in d.Transformacoes) sb.Append(',').Append(t);
            sb.Append("]}");
        }
        sb.Append("]}");
        Resposta r = Https.Pedir(cfg, host, "POST", Base + ":commit", "application/json; charset=utf-8", sb.ToString(), conta.Token());
        if (r.Estado != 200) throw new Exception("Firestore recusou a gravacao (HTTP " + r.Estado + "): " + ContaServico.Resumir(r.Corpo));
    }

    // Le varios documentos de uma vez; devolve so os que existem (id -> campos).
    public Dictionary<string, Dictionary<string, object>> LerVarios(string colecao, List<string> ids)
    {
        Dictionary<string, Dictionary<string, object>> r = new Dictionary<string, Dictionary<string, object>>();
        if (ids.Count == 0) return r;
        StringBuilder sb = new StringBuilder("{\"documents\":[");
        for (int i = 0; i < ids.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(Json.Texto("projects/" + Projeto + "/databases/(default)/documents/" + colecao + "/" + ids[i]));
        }
        sb.Append("]}");
        Resposta res = Https.Pedir(cfg, host, "POST", Base + ":batchGet", "application/json; charset=utf-8", sb.ToString(), conta.Token());
        if (res.Estado != 200) throw new Exception("Firestore recusou a leitura (HTTP " + res.Estado + "): " + ContaServico.Resumir(res.Corpo));
        List<object> l = Json.Ler(res.Corpo) as List<object>;
        if (l == null) return r;
        foreach (object o in l)
        {
            Dictionary<string, object> e = o as Dictionary<string, object>;
            object f;
            if (e == null || !e.TryGetValue("found", out f)) continue;
            Dictionary<string, object> doc = f as Dictionary<string, object>;
            string nome = Json.Campo(doc, "name");
            object campos;
            doc.TryGetValue("fields", out campos);
            r[nome.Substring(nome.LastIndexOf('/') + 1)] = (campos as Dictionary<string, object>) ?? new Dictionary<string, object>();
        }
        return r;
    }

    // Lista uma colecao pequena (ex.: utilizadores), ate 300 documentos.
    public List<KeyValuePair<string, Dictionary<string, object>>> Listar(string colecao)
    {
        List<KeyValuePair<string, Dictionary<string, object>>> r = new List<KeyValuePair<string, Dictionary<string, object>>>();
        Resposta res = Https.Pedir(cfg, host, "GET", Base + "/" + colecao + "?pageSize=300", null, null, conta.Token());
        if (res.Estado != 200) throw new Exception("Firestore recusou a leitura de " + colecao + " (HTTP " + res.Estado + "): " + ContaServico.Resumir(res.Corpo));
        Dictionary<string, object> j = Json.Ler(res.Corpo) as Dictionary<string, object>;
        object docs;
        if (j == null || !j.TryGetValue("documents", out docs)) return r;
        foreach (object o in (List<object>)docs)
        {
            Dictionary<string, object> doc = (Dictionary<string, object>)o;
            string nome = Json.Campo(doc, "name");
            object campos;
            doc.TryGetValue("fields", out campos);
            r.Add(new KeyValuePair<string, Dictionary<string, object>>(nome.Substring(nome.LastIndexOf('/') + 1), (campos as Dictionary<string, object>) ?? new Dictionary<string, object>()));
        }
        return r;
    }

    // Documentos de uma colecao com campo == valor (texto), ate 'max'.
    public List<KeyValuePair<string, Dictionary<string, object>>> Consultar(string colecao, string campo, string valor, int max)
    {
        List<KeyValuePair<string, Dictionary<string, object>>> r = new List<KeyValuePair<string, Dictionary<string, object>>>();
        string q = "{\"structuredQuery\":{\"from\":[{\"collectionId\":" + Json.Texto(colecao) + "}],\"where\":{\"fieldFilter\":{\"field\":{\"fieldPath\":" +
                   Json.Texto(campo) + "},\"op\":\"EQUAL\",\"value\":{\"stringValue\":" + Json.Texto(valor) + "}}},\"limit\":" + max + "}}";
        Resposta res = Https.Pedir(cfg, host, "POST", Base + ":runQuery", "application/json; charset=utf-8", q, conta.Token());
        if (res.Estado != 200) throw new Exception("Firestore recusou a consulta de " + colecao + " (HTTP " + res.Estado + "): " + ContaServico.Resumir(res.Corpo));
        List<object> l = Json.Ler(res.Corpo) as List<object>;
        if (l == null) return r;
        foreach (object o in l)
        {
            Dictionary<string, object> e = o as Dictionary<string, object>;
            object dd;
            if (e == null || !e.TryGetValue("document", out dd)) continue;
            Dictionary<string, object> doc = (Dictionary<string, object>)dd;
            string nome = Json.Campo(doc, "name");
            object campos;
            doc.TryGetValue("fields", out campos);
            r.Add(new KeyValuePair<string, Dictionary<string, object>>(nome.Substring(nome.LastIndexOf('/') + 1), (campos as Dictionary<string, object>) ?? new Dictionary<string, object>()));
        }
        return r;
    }

    // Valor simples de um campo devolvido pela API (stringValue, integerValue, booleanValue...).
    public static string Valor(Dictionary<string, object> campos, string k)
    {
        object v;
        if (campos == null || !campos.TryGetValue(k, out v)) return "";
        Dictionary<string, object> d = v as Dictionary<string, object>;
        if (d == null) return "";
        foreach (KeyValuePair<string, object> kv in d)
        {
            if (kv.Value == null) return "";
            if (kv.Value is bool) return (bool)kv.Value ? "true" : "false";
            return Convert.ToString(kv.Value, CultureInfo.InvariantCulture);
        }
        return "";
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
    // Clientes com documentos (faturas/dossiers das series configuradas) desde a data, excluindo os ja enviados.
    List<ClientePHC> ComDocumentosRecentes(DateTime desde, HashSet<long> jaEnviados, int max);
    int Total();
}

class PhcSql : IFonteClientes, IFonteFolhas, IFonteArtigos
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

    // Data de arranque da sincronizacao: inativos alterados depois dela sao enviados (ficam ativo=false na plataforma).
    public DateTime Inicio = DateTime.Today;

    // Lista de numeros inteiros (series) a partir da configuracao; ignora tudo o que nao for numero.
    string Series(string chave)
    {
        List<string> l = new List<string>();
        foreach (string x in cfg.Get(chave, "").Split(','))
        {
            int n;
            if (int.TryParse(x.Trim(), out n)) l.Add(n.ToString());
        }
        return string.Join(",", l.ToArray());
    }

    // Subconsulta com os numeros de cliente que tem documentos das series configuradas (null se nao houver series).
    string ClientesComDocumentos(string desdeSql)
    {
        List<string> partes = new List<string>();
        string sf = Series("SeriesFaturas"), sd = Series("SeriesDossiers");
        if (sf != "") partes.Add("SELECT ft.no FROM ft WITH (NOLOCK) WHERE ft.ndoc IN (" + sf + ")" + (desdeSql != null ? " AND ft.fdata >= " + desdeSql : ""));
        if (sd != "") partes.Add("SELECT bo.no FROM bo WITH (NOLOCK) WHERE bo.ndos IN (" + sd + ")" + (desdeSql != null ? " AND bo.dataobra >= " + desdeSql : ""));
        return partes.Count == 0 ? null : string.Join(" UNION ", partes.ToArray());
    }

    string DocumentosDesde()
    {
        DateTime d;
        if (DateTime.TryParseExact(cfg.Get("DocumentosDesde", ""), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out d))
            return "'" + d.ToString("yyyyMMdd") + "'";
        return null;
    }

    string Filtro()
    {
        string f = " " + cfg.Get("ClientesFiltro", "") + " ";
        string docs = ClientesComDocumentos(DocumentosDesde());
        if (docs != null)
            f += "AND (cl.no IN (" + docs + ")" +
                 (cfg.GetBool("IncluirNovosClientes", true) && colunas != null && colunas.Contains("ousrdata")
                    ? " OR cl.ousrdata >= '" + Inicio.ToString("yyyyMMdd") + "'" : "") + ") ";
        if (cfg.GetBool("IgnorarInativos", true) && colunas != null && colunas.Contains("inactivo"))
            f += "AND (cl.inactivo = 0 OR cl.usrdata >= '" + Inicio.ToString("yyyyMMdd") + "') ";
        return f;
    }

    public int Total()
    {
        using (SqlConnection cn = Abrir())
        {
            Colunas(cn);
            using (SqlCommand c = new SqlCommand("SELECT COUNT(*) FROM cl WITH (NOLOCK) WHERE cl.estab = 0" + Filtro(), cn))
                return Convert.ToInt32(c.ExecuteScalar());
        }
    }

    string Campos()
    {
        return "cl.no, cl.estab, cl.nome, cl.ncont, " +
            Opcional("morada") + " AS morada, " + Opcional("local") + " AS local, " + Opcional("codpost") + " AS codpost, " +
            Opcional("telefone") + " AS telefone, " + Opcional("tlmvl") + " AS tlmvl, " + Opcional("email") + " AS email, " +
            Opcional("contacto") + " AS contacto, " + (colunas.Contains("inactivo") ? "cl.inactivo" : "0") + " AS inactivo, " +
            "cl.usrdata, cl.usrhora";
    }

    public List<ClientePHC> ComDocumentosRecentes(DateTime desde, HashSet<long> jaEnviados, int max)
    {
        List<ClientePHC> l = new List<ClientePHC>();
        using (SqlConnection cn = Abrir())
        {
            Colunas(cn);
            string docs = ClientesComDocumentos("@desde");
            if (docs == null) return l;
            string sql = "SELECT " + Campos() + " FROM cl WITH (NOLOCK) WHERE cl.estab = 0 " +
                         (colunas.Contains("inactivo") ? "AND cl.inactivo = 0 " : "") +
                         "AND cl.no IN (" + docs + ") " + cfg.Get("ClientesFiltro", "") + " ORDER BY cl.no";
            using (SqlCommand c = new SqlCommand(sql, cn))
            {
                c.Parameters.AddWithValue("@desde", desde);
                using (SqlDataReader r = c.ExecuteReader())
                    while (r.Read() && l.Count < max)
                    {
                        ClientePHC x = Ler(r);
                        if (!jaEnviados.Contains(x.No)) l.Add(x);
                    }
            }
        }
        return l;
    }

    // Diagnostico: series de faturas (td) e de dossiers internos (ts), com n.o de documentos e ultima data.
    public List<string> ListaSeries()
    {
        List<string> l = new List<string>();
        using (SqlConnection cn = Abrir())
        {
            l.Add("FATURAS E OUTROS DOCUMENTOS DE FATURACAO (SeriesFaturas)");
            using (SqlCommand c = new SqlCommand("SELECT td.ndoc, td.nmdoc, (SELECT COUNT(*) FROM ft WITH (NOLOCK) WHERE ft.ndoc = td.ndoc) AS n, " +
                "(SELECT MAX(ft.fdata) FROM ft WITH (NOLOCK) WHERE ft.ndoc = td.ndoc) AS u FROM td WITH (NOLOCK) ORDER BY td.ndoc", cn))
            using (SqlDataReader r = c.ExecuteReader())
                while (r.Read()) l.Add(Linha(r));
            l.Add("");
            l.Add("DOSSIERS INTERNOS (SeriesDossiers)");
            using (SqlCommand c = new SqlCommand("SELECT ts.ndos, ts.nmdos, (SELECT COUNT(*) FROM bo WITH (NOLOCK) WHERE bo.ndos = ts.ndos) AS n, " +
                "(SELECT MAX(bo.dataobra) FROM bo WITH (NOLOCK) WHERE bo.ndos = ts.ndos) AS u FROM ts WITH (NOLOCK) ORDER BY ts.ndos", cn))
            using (SqlDataReader r = c.ExecuteReader())
                while (r.Read()) l.Add(Linha(r));
        }
        return l;
    }

    HashSet<string> colunasBo;

    string Bo(SqlConnection cn, string col)
    {
        if (colunasBo == null)
        {
            colunasBo = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (SqlCommand c = new SqlCommand("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'bo'", cn))
            using (SqlDataReader r = c.ExecuteReader())
                while (r.Read()) colunasBo.Add(r.GetString(0));
        }
        return colunasBo.Contains(col) ? "bo." + col : "''";
    }

    public List<FolhaPHC> FolhasSeguintes(Marca m, int max)
    {
        List<FolhaPHC> l = new List<FolhaPHC>();
        int ndos = cfg.GetInt("SerieFolhas", 114);
        using (SqlConnection cn = Abrir())
        {
            Colunas(cn);
            DateTime desde;
            string filtroData = DateTime.TryParseExact(cfg.Get("FolhasDesde", ""), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out desde)
                ? " AND bo.dataobra >= '" + desde.ToString("yyyyMMdd") + "'" : "";
            string sql = "SELECT TOP (@max) bo.bostamp, bo.obrano, bo.boano, bo.dataobra, bo.no, bo.nome, bo.ncont, bo.morada, bo.local, bo.codpost, " +
                Bo(cn, "tecnnm") + " AS tecnnm, " + Bo(cn, "trab1") + " AS trab1, " + Bo(cn, "trab5") + " AS trab5, " + Bo(cn, "tabela1") + " AS tabela1, " +
                Bo(cn, "u_davaria") + " AS u_davaria, " + (colunasBo.Contains("dataopen") ? "bo.dataopen" : "bo.dataobra") + " AS dataopen, " + (colunasBo.Contains("fechada") ? "bo.fechada" : "0") + " AS fechada, " +
                Bo(cn, "tabela2") + " AS tabela2, " + (colunasBo.Contains("etotaldeb") ? "bo.etotaldeb" : "0") + " AS etotaldeb, " +
                "CAST(" + Bo(cn, "u_dinterve") + " AS NVARCHAR(4000)) AS u_dinterve, CAST(" + Bo(cn, "obstab2") + " AS NVARCHAR(4000)) AS obstab2, " + Bo(cn, "obranome") + " AS obranome, " +
                "ISNULL(bo2.contacto, '') AS b2contacto, ISNULL(bo2.telefone, '') AS b2telefone, ISNULL(bo2.email, '') AS b2email, " +
                "ISNULL(bo2.morada, '') AS b2morada, ISNULL(bo2.local, '') AS b2local, ISNULL(bo2.codpost, '') AS b2codpost, " + (ColunaExiste(cn, "bo2", "u_resnego") ? "ISNULL(CAST(bo2.u_resnego AS NVARCHAR(200)), '')" : "''") + " AS b2resnego, " +
                "bo.ousrdata, bo.ousrinis, bo.usrdata, bo.usrhora, ISNULL(bo2.xpdhora, '') AS xpdhora, " +
                "ISNULL(cl." + (colunas.Contains("telefone") ? "telefone" : "nome") + ", '') AS telefone, ISNULL(cl." + (colunas.Contains("tlmvl") ? "tlmvl" : "nome") + ", '') AS tlmvl " +
                "FROM bo WITH (NOLOCK) LEFT JOIN bo2 WITH (NOLOCK) ON bo2.bo2stamp = bo.bostamp " +
                "LEFT JOIN cl WITH (NOLOCK) ON cl.no = bo.no AND cl.estab = 0 " +
                "WHERE bo.ndos = @ndos" + filtroData + " AND (bo.usrdata > @d OR (bo.usrdata = @d AND bo.usrhora > @h) " +
                "OR (bo.usrdata = @d AND bo.usrhora = @h AND (bo.boano * 10000000 + bo.obrano) > @no)) " +
                "ORDER BY bo.usrdata, bo.usrhora, bo.boano, bo.obrano";
            using (SqlCommand c = new SqlCommand(sql, cn))
            {
                c.Parameters.AddWithValue("@max", max);
                c.Parameters.AddWithValue("@ndos", ndos);
                c.Parameters.AddWithValue("@d", m.Data);
                c.Parameters.AddWithValue("@h", m.Hora);
                c.Parameters.AddWithValue("@no", m.No);
                using (SqlDataReader r = c.ExecuteReader())
                    while (r.Read())
                    {
                        FolhaPHC x = new FolhaPHC();
                        x.Stamp = S(r, "bostamp"); x.Numero = Convert.ToInt64(r["obrano"]); x.Ano = Convert.ToInt32(r["boano"]);
                        x.Data = r["dataobra"] == DBNull.Value ? new DateTime(1900, 1, 1) : Convert.ToDateTime(r["dataobra"]).Date;
                        x.Hora = S(r, "xpdhora"); x.ClienteNo = Convert.ToInt64(r["no"]);
                        if (r["dataopen"] != DBNull.Value) x.Marcacao = Convert.ToDateTime(r["dataopen"]).Date;
                        x.Nome = S(r, "nome"); x.Ncont = S(r, "ncont"); x.Morada = S(r, "morada"); x.Local = S(r, "local"); x.CodPost = S(r, "codpost");
                        x.Telefone = S(r, "telefone"); if (x.Telefone == "" || x.Telefone == x.Nome) x.Telefone = S(r, "tlmvl"); if (x.Telefone == x.Nome) x.Telefone = "";
                        x.Tecnico = S(r, "tecnnm"); x.Contacto = S(r, "trab1"); x.Tipo = S(r, "trab5"); x.Estado = S(r, "tabela1"); x.Descricao = S(r, "u_davaria");
                        x.Fechada = r["fechada"] != DBNull.Value && Convert.ToBoolean(r["fechada"]);
                        x.TecResp = S(r, "tabela2");
                        x.Relatorio = S(r, "u_dinterve"); x.ObsInternas = S(r, "obstab2"); x.Encomenda = S(r, "obranome");
                        x.Situacao = S(r, "b2resnego"); x.EmailContacto = S(r, "b2email");
                        if (S(r, "b2contacto") != "") x.Contacto = S(r, "b2contacto");
                        if (S(r, "b2telefone") != "") x.Telefone = S(r, "b2telefone");
                        // morada da obra (bo2) quando difere da do cliente
                        if (S(r, "b2morada") != "") { x.Morada = S(r, "b2morada"); x.Local = S(r, "b2local"); if (S(r, "b2codpost") != "") x.CodPost = S(r, "b2codpost"); }
                        x.TotalVenda = r["etotaldeb"] == DBNull.Value ? 0 : Convert.ToDecimal(r["etotaldeb"]);
                        x.Criada = r["ousrdata"] == DBNull.Value ? x.Data : Convert.ToDateTime(r["ousrdata"]); x.CriadaPor = S(r, "ousrinis");
                        x.AltData = r["usrdata"] == DBNull.Value ? new DateTime(1900, 1, 1) : Convert.ToDateTime(r["usrdata"]).Date; x.AltHora = S(r, "usrhora");
                        l.Add(x);
                    }
            }
            if (l.Count > 0)
            {
                Dictionary<string, FolhaPHC> porStamp = new Dictionary<string, FolhaPHC>();
                StringBuilder ps = new StringBuilder();
                using (SqlCommand c = new SqlCommand())
                {
                    for (int i = 0; i < l.Count; i++)
                    {
                        porStamp[l[i].Stamp] = l[i];
                        if (i > 0) ps.Append(',');
                        ps.Append("@s" + i);
                        c.Parameters.AddWithValue("@s" + i, l[i].Stamp);
                    }
                    c.Connection = cn;
                    c.CommandText = "SELECT bi.bostamp, bi.ref, bi.design, bi.qtt, bi.unidade, bi.dedata, bi.epu, bi.ettdeb FROM bi WITH (NOLOCK) WHERE bi.bostamp IN (" + ps + ") ORDER BY bi.bostamp, bi.lordem";
                    using (SqlDataReader r = c.ExecuteReader())
                        while (r.Read())
                        {
                            FolhaPHC fo;
                            if (!porStamp.TryGetValue(S(r, "bostamp"), out fo)) continue;
                            LinhaPHC li = new LinhaPHC();
                            li.Ref = S(r, "ref"); li.Design = S(r, "design"); li.Unidade = S(r, "unidade");
                            li.Qtd = r["qtt"] == DBNull.Value ? 0 : Convert.ToDecimal(r["qtt"]);
                            if (r["dedata"] != DBNull.Value && Convert.ToDateTime(r["dedata"]).Year > 1900) li.Data = Convert.ToDateTime(r["dedata"]);
                            li.Preco = r["epu"] == DBNull.Value ? 0 : Convert.ToDecimal(r["epu"]);
                            li.Total = r["ettdeb"] == DBNull.Value ? 0 : Convert.ToDecimal(r["ettdeb"]);
                            if (li.Ref != "" || li.Design != "") fo.Linhas.Add(li);
                        }
                }
                LerTabelasNW(cn, porStamp);
            }
        }
        return l;
    }

    bool ColunaExiste(SqlConnection cn, string tabela, string coluna)
    {
        using (SqlCommand c = new SqlCommand("SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t AND COLUMN_NAME = @c", cn))
        {
            c.Parameters.AddWithValue("@t", tabela);
            c.Parameters.AddWithValue("@c", coluna);
            return Convert.ToInt32(c.ExecuteScalar()) > 0;
        }
    }

    HashSet<string> tabelas;
    bool Existe(SqlConnection cn, string tabela)
    {
        if (tabelas == null)
        {
            tabelas = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (SqlCommand c = new SqlCommand("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES", cn))
            using (SqlDataReader r = c.ExecuteReader())
                while (r.Read()) tabelas.Add(r.GetString(0));
        }
        return tabelas.Contains(tabela);
    }

    // Tabelas da NetWorker: registo de tempos, valores por hora, historico (NWService) e tarefas.
    void LerTabelasNW(SqlConnection cn, Dictionary<string, FolhaPHC> porStamp)
    {
        string[] stamps = new string[porStamp.Count];
        porStamp.Keys.CopyTo(stamps, 0);
        Ler(cn, "U_NWRegistoTempos", "SELECT BOSTAMP AS s, DATA, NTOTALHORAS, FUNCIONARIO FROM U_NWRegistoTempos WITH (NOLOCK) WHERE BOSTAMP IN ({0}) ORDER BY DATA",
            stamps, delegate(SqlDataReader r)
            {
                FolhaPHC fo;
                if (!porStamp.TryGetValue(S(r, "s"), out fo)) return;
                TempoPHC t = new TempoPHC();
                t.Data = r["DATA"] == DBNull.Value ? fo.Data : Convert.ToDateTime(r["DATA"]);
                t.Horas = r["NTOTALHORAS"] == DBNull.Value ? 0 : Convert.ToDecimal(r["NTOTALHORAS"]);
                t.Funcionario = S(r, "FUNCIONARIO");
                fo.Tempos.Add(t);
            });
        Ler(cn, "U_NWRegistoValores", "SELECT BOSTAMP AS s, DATA, NTOTALHORAS, TIPOINTERVENCAO, TIPOTECNICO, preco, total FROM U_NWRegistoValores WITH (NOLOCK) WHERE BOSTAMP IN ({0}) ORDER BY DATA",
            stamps, delegate(SqlDataReader r)
            {
                FolhaPHC fo;
                if (!porStamp.TryGetValue(S(r, "s"), out fo)) return;
                ValorPHC v = new ValorPHC();
                v.Data = r["DATA"] == DBNull.Value ? fo.Data : Convert.ToDateTime(r["DATA"]);
                v.Horas = r["NTOTALHORAS"] == DBNull.Value ? 0 : Convert.ToDecimal(r["NTOTALHORAS"]);
                v.TipoIntervencao = S(r, "TIPOINTERVENCAO"); v.TipoTecnico = S(r, "TIPOTECNICO");
                v.Preco = r["preco"] == DBNull.Value ? 0 : Convert.ToDecimal(r["preco"]);
                v.Total = r["total"] == DBNull.Value ? 0 : Convert.ToDecimal(r["total"]);
                fo.Valores.Add(v);
            });
        Ler(cn, "NWService", "SELECT BOSTAMP AS s, data, texto FROM NWService WITH (NOLOCK) WHERE BOSTAMP IN ({0}) ORDER BY data, id",
            stamps, delegate(SqlDataReader r)
            {
                FolhaPHC fo;
                if (!porStamp.TryGetValue(S(r, "s"), out fo) || r["data"] == DBNull.Value) return;
                string t = S(r, "texto");
                if (t == "" || t == "Estado:") return;
                DateTime d = Convert.ToDateTime(r["data"]);
                if (fo.Servico.Count > 0 && fo.Servico[fo.Servico.Count - 1].Value == t) return; // repetido (um por destinatario)
                fo.Servico.Add(new KeyValuePair<DateTime, string>(d, t));
            });
        Ler(cn, "NW_Tarefas", "SELECT bostamp AS s, descricao FROM NW_Tarefas WITH (NOLOCK) WHERE bostamp IN ({0}) ORDER BY lordem",
            stamps, delegate(SqlDataReader r)
            {
                FolhaPHC fo;
                if (porStamp.TryGetValue(S(r, "s"), out fo) && S(r, "descricao") != "" && !fo.Tarefas.Contains(S(r, "descricao"))) fo.Tarefas.Add(S(r, "descricao")); // a NetWorker grava cada tarefa repetida
            });
    }

    delegate void Leitor(SqlDataReader r);

    void Ler(SqlConnection cn, string tabela, string sql, string[] stamps, Leitor f)
    {
        if (!Existe(cn, tabela) || stamps.Length == 0) return;
        using (SqlCommand c = new SqlCommand())
        {
            StringBuilder ps = new StringBuilder();
            for (int i = 0; i < stamps.Length; i++)
            {
                if (i > 0) ps.Append(',');
                ps.Append("@t" + i);
                c.Parameters.AddWithValue("@t" + i, stamps[i]);
            }
            c.Connection = cn;
            c.CommandText = string.Format(sql, ps);
            try
            {
                using (SqlDataReader r = c.ExecuteReader())
                    while (r.Read()) f(r);
            }
            catch (Exception e) { Log.Erro("Leitura de " + tabela + ": " + e.Message); }
        }
    }

    public long MaiorNumero(int ano)
    {
        using (SqlConnection cn = Abrir())
        using (SqlCommand c = new SqlCommand("SELECT ISNULL(MAX(obrano), 0) FROM bo WITH (NOLOCK) WHERE ndos = @n AND boano = @a", cn))
        {
            c.Parameters.AddWithValue("@n", cfg.GetInt("SerieFolhas", 114));
            c.Parameters.AddWithValue("@a", ano);
            return Convert.ToInt64(c.ExecuteScalar());
        }
    }

    // Diagnostico: para uma serie, que colunas de texto de bo/bo2/bo3 estao preenchidas e um exemplo de cada.
    public List<string> CamposPreenchidos(int ndos)
    {
        List<string> l = new List<string>();
        using (SqlConnection cn = Abrir())
        {
            foreach (string t in new string[] { "bo", "bo2", "bo3" })
            {
                List<string> cols = new List<string>();
                using (SqlCommand c = new SqlCommand("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t " +
                    "AND DATA_TYPE IN ('varchar','nvarchar','char','nchar','text','ntext') AND COLUMN_NAME NOT LIKE '%stamp' " +
                    "AND COLUMN_NAME NOT IN ('ousrinis','usrinis','nmdos','origem') ORDER BY COLUMN_NAME", cn))
                {
                    c.Parameters.AddWithValue("@t", t);
                    using (SqlDataReader r = c.ExecuteReader()) while (r.Read()) cols.Add(r.GetString(0));
                }
                l.Add("");
                l.Add("--- " + t + ": colunas de texto preenchidas na serie " + ndos + " (quantas folhas | exemplo da mais recente)");
                string junta = t == "bo" ? "" : " INNER JOIN bo b WITH (NOLOCK) ON b.bostamp = x." + t + "stamp";
                string serie = t == "bo" ? "x.ndos" : "b.ndos";
                string ordem = t == "bo" ? "x.dataobra" : "b.dataobra";
                foreach (string col in cols)
                {
                    string cond = "LTRIM(RTRIM(CAST(x.[" + col + "] AS NVARCHAR(4000)))) <> ''";
                    string sql = "SELECT COUNT(*) FROM " + t + " x WITH (NOLOCK)" + junta + " WHERE " + serie + " = @n AND " + cond + "; " +
                                 "SELECT TOP 1 CAST(x.[" + col + "] AS NVARCHAR(4000)) FROM " + t + " x WITH (NOLOCK)" + junta + " WHERE " + serie + " = @n AND " + cond + " ORDER BY " + ordem + " DESC";
                    try
                    {
                        using (SqlCommand c = new SqlCommand(sql, cn))
                        {
                            c.Parameters.AddWithValue("@n", ndos);
                            using (SqlDataReader r = c.ExecuteReader())
                            {
                                r.Read();
                                int n = r.GetInt32(0);
                                if (n == 0) continue;
                                r.NextResult();
                                string ex = r.Read() ? r.GetString(0).Trim().Replace("\r", " ").Replace("\n", " ") : "";
                                if (ex.Length > 120) ex = ex.Substring(0, 120) + "...";
                                l.Add(string.Format("  {0,-22} {1,6} | {2}", col, n, ex));
                            }
                        }
                    }
                    catch (Exception e) { l.Add("  " + col + ": (" + e.Message + ")"); }
                }
            }
        }
        return l;
    }

    // Diagnostico: mostra um dossier interno completo (campos preenchidos de bo/bo2/bo3 e linhas bi) e um resumo da serie.
    // ---- artigos do armazem da climatizacao (ArmazemAC, por omissao 99)
    int ArmazemAC { get { return cfg.GetInt("ArmazemAC", 99); } }

    public List<string> ArtigosAlterados(DateTime? desde)
    {
        List<string> l = new List<string>();
        HashSet<string> vistos = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string sqlTxt = desde.HasValue
            ? "SELECT DISTINCT x.ref FROM (" +
              " SELECT st.ref FROM st WITH (NOLOCK) JOIN sa WITH (NOLOCK) ON sa.ref = st.ref AND sa.armazem = @a WHERE st.usrdata >= @d OR sa.usrdata >= @d" +
              " UNION SELECT bi.ref FROM bi WITH (NOLOCK) JOIN bo WITH (NOLOCK) ON bo.bostamp = bi.bostamp" +
              "   WHERE bo.ndos IN (114, 111) AND bi.armazem = @a AND bi.ref <> '' AND (bo.usrdata >= @d OR bi.usrdata >= @d)" +
              ") x"
            : "SELECT st.ref FROM st WITH (NOLOCK) JOIN sa WITH (NOLOCK) ON sa.ref = st.ref AND sa.armazem = @a WHERE st.inactivo = 0";
        using (SqlConnection cn = Abrir())
        using (SqlCommand c = new SqlCommand(sqlTxt, cn))
        {
            c.CommandTimeout = 120;
            c.Parameters.AddWithValue("@a", ArmazemAC);
            if (desde.HasValue) c.Parameters.AddWithValue("@d", desde.Value.Date);
            using (SqlDataReader r = c.ExecuteReader())
                while (r.Read()) { string x = Valor(r[0]); if (x != "" && vistos.Add(x)) l.Add(x); }
        }
        return l;
    }

    // Stock no armazem, reservado em FO abertas (114) e ainda em Guias abertas (111) sem passar para FO.
    public List<ArtigoPHC> LerArtigos(List<string> refs)
    {
        List<ArtigoPHC> l = new List<ArtigoPHC>();
        if (refs.Count == 0) return l;
        using (SqlConnection cn = Abrir())
            for (int i = 0; i < refs.Count; i += 100)
            {
                List<string> parte = refs.GetRange(i, Math.Min(100, refs.Count - i));
                StringBuilder ps = new StringBuilder();
                using (SqlCommand c = new SqlCommand())
                {
                    c.Connection = cn;
                    c.CommandTimeout = 120;
                    for (int k = 0; k < parte.Count; k++) { if (k > 0) ps.Append(','); ps.Append("@r" + k); c.Parameters.AddWithValue("@r" + k, parte[k]); }
                    c.Parameters.AddWithValue("@a", ArmazemAC);
                    c.Parameters.AddWithValue("@dg", DateTime.Today.AddDays(-cfg.GetInt("GuiasDiasAbertas", 30)));
                    c.CommandText = "SELECT st.ref, st.design, st.unidade, st.faminome, st.inactivo, st.epcusto, " + (StTemNoserie(cn) ? "st.noserie" : "0") + " AS noserie, ISNULL(sa.stock, 0) AS stock, " +
                        "ISNULL((SELECT SUM(bi.qtt) FROM bi WITH (NOLOCK) JOIN bo WITH (NOLOCK) ON bo.bostamp = bi.bostamp " +
                        "  WHERE bi.ref = st.ref AND bo.ndos = 114 AND bo.fechada = 0 AND bi.armazem = @a), 0) AS reservado, " +
                        // em guias abertas: o que levou (qtt) menos o que ja passou para FO (qtt2), so das guias dos ultimos GuiasDiasAbertas dias
                        "ISNULL((SELECT SUM(CASE WHEN bi.qtt > ISNULL(bi.qtt2, 0) THEN bi.qtt - ISNULL(bi.qtt2, 0) ELSE 0 END) FROM bi WITH (NOLOCK) JOIN bo WITH (NOLOCK) ON bo.bostamp = bi.bostamp " +
                        "  WHERE bi.ref = st.ref AND bo.ndos = 111 AND bo.fechada = 0 AND bi.armazem = @a AND bo.dataobra >= @dg), 0) AS emguias " +
                        "FROM st WITH (NOLOCK) LEFT JOIN sa WITH (NOLOCK) ON sa.ref = st.ref AND sa.armazem = @a WHERE st.ref IN (" + ps + ")";
                    using (SqlDataReader r = c.ExecuteReader())
                        while (r.Read())
                        {
                            ArtigoPHC a = new ArtigoPHC();
                            a.Ref = Valor(r["ref"]); a.Design = Valor(r["design"]); a.Unidade = Valor(r["unidade"]); a.Familia = Valor(r["faminome"]);
                            a.Inativo = Valor(r["inactivo"]) == "1" || Valor(r["inactivo"]).ToLower() == "true";
                            a.Stock = Dec(r["stock"]); a.Reservado = Dec(r["reservado"]); a.EmGuias = Dec(r["emguias"]); a.Custo = Dec(r["epcusto"]);
                            a.ComSerie = Valor(r["noserie"]) == "1" || Valor(r["noserie"]).ToLower() == "true";
                            l.Add(a);
                        }
                }
            }
        return l;
    }
    // st.noserie = artigo gerido por numero de serie (equipamentos)
    int stNoserie = -1;
    bool StTemNoserie(SqlConnection cn)
    {
        if (stNoserie < 0)
            using (SqlCommand c = new SqlCommand("SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'st' AND COLUMN_NAME = 'noserie'", cn))
                stNoserie = Convert.ToInt32(c.ExecuteScalar()) > 0 ? 1 : 0;
        return stNoserie == 1;
    }
    static decimal Dec(object o) { return o == null || o == DBNull.Value ? 0m : Math.Round(Convert.ToDecimal(o), 3); }

    // Diagnostico de stock (so leitura): ficha do artigo, stock por armazem e quantidades em dossiers abertos.
    public List<string> VerArtigo(string referencia)
    {
        List<string> l = new List<string>();
        using (SqlConnection cn = Abrir())
        {
            string[] consultas = {
                "st|SELECT TOP 1 * FROM st WITH (NOLOCK) WHERE ref = @r",
                "sa (stock por armazem)|SELECT * FROM sa WITH (NOLOCK) WHERE ref = @r",
            };
            foreach (string q in consultas)
            {
                string[] p = q.Split('|');
                l.Add("");
                l.Add("--- " + p[0] + " (so campos preenchidos)");
                using (SqlCommand c = new SqlCommand(p[1], cn))
                {
                    c.Parameters.AddWithValue("@r", referencia);
                    try
                    {
                        using (SqlDataReader r = c.ExecuteReader())
                        {
                            int n = 0;
                            while (r.Read() && n < 20)
                            {
                                n++;
                                if (n > 1) l.Add("  --");
                                for (int i = 0; i < r.FieldCount; i++) { string v = Valor(r[i]); if (v != "") l.Add("  " + r.GetName(i) + " = " + v); }
                            }
                            if (n == 0) l.Add("  (nada)");
                        }
                    }
                    catch (Exception e) { l.Add("  (" + e.Message + ")"); }
                }
            }
            l.Add("");
            l.Add("--- quantidades desta referencia em dossiers (abertos / fechados), por serie e armazem");
            using (SqlCommand c = new SqlCommand("SELECT bo.ndos, bo.nmdos, bi.armazem, bi.ar2mazem, bo.fechada, COUNT(*) AS linhas, SUM(bi.qtt) AS qtd " +
                "FROM bi WITH (NOLOCK) JOIN bo WITH (NOLOCK) ON bo.bostamp = bi.bostamp WHERE bi.ref = @r " +
                "GROUP BY bo.ndos, bo.nmdos, bi.armazem, bi.ar2mazem, bo.fechada ORDER BY bo.ndos, bo.fechada", cn))
            {
                c.Parameters.AddWithValue("@r", referencia);
                try
                {
                    using (SqlDataReader r = c.ExecuteReader())
                        while (r.Read())
                            l.Add("  serie " + r["ndos"] + " " + Valor(r["nmdos"]) + " | armazem " + Valor(r["armazem"]) + " -> " + Valor(r["ar2mazem"]) +
                                  " | " + (Valor(r["fechada"]) == "1" || Valor(r["fechada"]).ToLower() == "true" ? "fechados" : "ABERTOS") + ": " + r["linhas"] + " linhas, qtd " + Valor(r["qtd"]));
                }
                catch (Exception e) { l.Add("  (" + e.Message + ")"); }
            }
            l.Add("");
            l.Add("--- ultima linha desta referencia numa Guia (serie 111), campos preenchidos");
            using (SqlCommand c = new SqlCommand("SELECT TOP 1 bi.* FROM bi WITH (NOLOCK) JOIN bo WITH (NOLOCK) ON bo.bostamp = bi.bostamp " +
                "WHERE bi.ref = @r AND bo.ndos = 111 ORDER BY bo.dataobra DESC", cn))
            {
                c.Parameters.AddWithValue("@r", referencia);
                try
                {
                    using (SqlDataReader r = c.ExecuteReader())
                        if (r.Read()) { for (int i = 0; i < r.FieldCount; i++) { string v = Valor(r[i]); if (v != "") l.Add("  " + r.GetName(i) + " = " + v); } }
                        else l.Add("  (nenhuma)");
                }
                catch (Exception e) { l.Add("  (" + e.Message + ")"); }
            }
        }
        return l;
    }

    // Procura artigos pela designacao ou referencia, com o stock de cada armazem (so leitura).
    public List<string> ProcurarArtigos(string texto)
    {
        List<string> l = new List<string>();
        using (SqlConnection cn = Abrir())
        using (SqlCommand c = new SqlCommand("SELECT TOP 30 st.ref, st.design, st.unidade, " +
            "(SELECT ' ' + CAST(sa.armazem AS varchar(10)) + ':' + CAST(CAST(sa.stock AS decimal(18,3)) AS varchar(30)) FROM sa WITH (NOLOCK) WHERE sa.ref = st.ref AND sa.stock <> 0 FOR XML PATH('')) AS stocks " +
            "FROM st WITH (NOLOCK) WHERE st.ref LIKE @t OR st.design LIKE @t ORDER BY st.ref", cn))
        {
            c.Parameters.AddWithValue("@t", "%" + texto + "%");
            using (SqlDataReader r = c.ExecuteReader())
                while (r.Read()) l.Add(Valor(r["ref"]) + " | " + Valor(r["design"]) + " | " + Valor(r["unidade"]) + " | stock por armazem:" + (Valor(r["stocks"]) == "" ? " (nenhum)" : Valor(r["stocks"])));
        }
        if (l.Count == 0) l.Add("(nenhum artigo com \"" + texto + "\")");
        return l;
    }

    // Como se usam as Guias 111: abertas/fechadas, ligadas a Folha de Obra, armazens das linhas (so leitura).
    public List<string> ResumoGuias()
    {
        List<string> l = new List<string>();
        using (SqlConnection cn = Abrir())
        {
            string[] q = {
                "Guias por ano e estado|SELECT bo.boano AS a, bo.fechada AS f, COUNT(*) AS n FROM bo WITH (NOLOCK) WHERE bo.ndos = 111 GROUP BY bo.boano, bo.fechada ORDER BY bo.boano, bo.fechada",
                "Linhas das guias (ultimos 12 meses) por documento de origem|SELECT ISNULL(bi.nmdoc,'') AS a, CASE WHEN bi.fno > 0 THEN 'com n.' ELSE 'sem n.' END AS f, COUNT(*) AS n FROM bi WITH (NOLOCK) JOIN bo WITH (NOLOCK) ON bo.bostamp = bi.bostamp WHERE bo.ndos = 111 AND bo.dataobra >= DATEADD(month,-12,GETDATE()) GROUP BY bi.nmdoc, CASE WHEN bi.fno > 0 THEN 'com n.' ELSE 'sem n.' END",
                "Linhas das guias (ultimos 12 meses) por armazem -> armazem destino|SELECT CAST(bi.armazem AS varchar(10)) AS a, CAST(bi.ar2mazem AS varchar(10)) AS f, COUNT(*) AS n FROM bi WITH (NOLOCK) JOIN bo WITH (NOLOCK) ON bo.bostamp = bi.bostamp WHERE bo.ndos = 111 AND bo.dataobra >= DATEADD(month,-12,GETDATE()) GROUP BY bi.armazem, bi.ar2mazem",
                "Guias por viatura (ultimos 12 meses)|SELECT ISNULL(bo.maquina,'') AS a, '' AS f, COUNT(*) AS n FROM bo WITH (NOLOCK) WHERE bo.ndos = 111 AND bo.dataobra >= DATEADD(month,-12,GETDATE()) GROUP BY bo.maquina",
                "Folhas de Obra 114 por armazem das linhas (ultimos 12 meses), abertas/fechadas|SELECT CAST(bi.armazem AS varchar(10)) AS a, CAST(bo.fechada AS varchar(5)) AS f, COUNT(*) AS n FROM bi WITH (NOLOCK) JOIN bo WITH (NOLOCK) ON bo.bostamp = bi.bostamp WHERE bo.ndos = 114 AND bi.ref <> '' AND bo.dataobra >= DATEADD(month,-12,GETDATE()) GROUP BY bi.armazem, bo.fechada",
            };
            foreach (string x in q)
            {
                string[] p = x.Split('|');
                l.Add(""); l.Add("--- " + p[0]);
                try
                {
                    using (SqlCommand c = new SqlCommand(p[1], cn))
                    using (SqlDataReader r = c.ExecuteReader())
                        while (r.Read()) l.Add("  " + Valor(r["a"]) + " | " + Valor(r["f"]) + " | " + r["n"]);
                }
                catch (Exception e) { l.Add("  (" + e.Message + ")"); }
            }
        }
        return l;
    }

    // Linhas de Guias 111 ainda abertas: quanto levou, quanto ja passou para Folha de Obra (so leitura).
    public List<string> GuiasAbertas()
    {
        List<string> l = new List<string>();
        using (SqlConnection cn = Abrir())
        using (SqlCommand c = new SqlCommand("SELECT TOP 40 bo.obrano, bo.boano, bo.dataobra, bo.maquina, bo.nome, bi.ref, bi.design, bi.qtt, bi.qtt2, bi.fno, bi.nmdoc, bi.unidade " +
            "FROM bi WITH (NOLOCK) JOIN bo WITH (NOLOCK) ON bo.bostamp = bi.bostamp " +
            "WHERE bo.ndos = 111 AND bo.fechada = 0 AND bi.ref <> '' ORDER BY bo.dataobra DESC, bo.obrano DESC, bi.lordem", cn))
        using (SqlDataReader r = c.ExecuteReader())
            while (r.Read())
                l.Add("GTAC " + Valor(r["obrano"]) + "/" + Valor(r["boano"]) + " " + Convert.ToDateTime(r["dataobra"]).ToString("yyyy-MM-dd") + " " + Valor(r["maquina"]) + " " + Valor(r["nome"]) +
                      " | " + Valor(r["ref"]) + " " + Valor(r["design"]) + " | qtt " + Valor(r["qtt"]) + " qtt2 " + Valor(r["qtt2"]) + " " + Valor(r["unidade"]) +
                      " | " + (Valor(r["fno"]) == "" || Valor(r["fno"]) == "0" ? "sem FO" : Valor(r["nmdoc"]) + " " + Valor(r["fno"])));
        if (l.Count == 0) l.Add("(nenhuma guia aberta com linhas)");
        return l;
    }

    // Fase 5 (so leitura): estrutura das tabelas dos dossiers (colunas, tipos, valores por omissao), gatilhos e
    // campos preenchidos nos ultimos documentos da serie - para saber o que o PHC/NetWorker escreve ao criar um documento.
    public List<string> Estrutura(int ndos)
    {
        List<string> l = new List<string>();
        using (SqlConnection cn = Abrir())
        {
            foreach (string t in new string[] { "bo", "bo2", "bo3", "bi", "bi2" })
            {
                l.Add(""); l.Add("--- tabela " + t + ": colunas (tipo, nulo, por omissao)");
                using (SqlCommand c = new SqlCommand("SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION", cn))
                {
                    c.Parameters.AddWithValue("@t", t);
                    using (SqlDataReader r = c.ExecuteReader())
                        while (r.Read()) l.Add("  " + r[0] + " " + r[1] + (r[2] == DBNull.Value ? "" : "(" + r[2] + ")") + (Valor(r[3]) == "NO" ? " NOT NULL" : "") + (r[4] == DBNull.Value ? "" : " = " + r[4]));
                }
            }
            l.Add(""); l.Add("--- gatilhos (triggers) nas tabelas dos dossiers e do stock");
            using (SqlCommand c = new SqlCommand("SELECT OBJECT_NAME(parent_id) AS tabela, name, is_disabled FROM sys.triggers WHERE OBJECT_NAME(parent_id) IN ('bo','bo2','bo3','bi','bi2','sa','st','sl') ORDER BY 1, 2", cn))
            using (SqlDataReader r = c.ExecuteReader())
            {
                int n = 0;
                while (r.Read()) { n++; l.Add("  " + r[0] + " | " + r[1] + (Valor(r[2]) == "1" || Valor(r[2]).ToLower() == "true" ? " (desativado)" : "")); }
                if (n == 0) l.Add("  (nenhum)");
            }
            l.Add(""); l.Add("--- ultimos 5 documentos da serie " + ndos + " (quem criou e como)");
            using (SqlCommand c = new SqlCommand("SELECT TOP 5 obrano, boano, dataobra, ousrinis, ousrdata, ousrhora, bostamp, fechada FROM bo WITH (NOLOCK) WHERE ndos = @n ORDER BY ousrdata DESC, ousrhora DESC", cn))
            {
                c.Parameters.AddWithValue("@n", ndos);
                using (SqlDataReader r = c.ExecuteReader())
                    while (r.Read()) l.Add("  " + r[0] + "/" + r[1] + " " + Convert.ToDateTime(r[2]).ToString("yyyy-MM-dd") + " por " + Valor(r[3]) + " em " + Valor(r[4]) + " " + Valor(r[5]) + " | " + Valor(r[6]) + (Valor(r[7]) == "1" || Valor(r[7]).ToLower() == "true" ? " | fechado" : ""));
            }
            l.Add(""); l.Add("--- tabela de numeracao da serie (ts)");
            using (SqlCommand c = new SqlCommand("SELECT * FROM ts WITH (NOLOCK) WHERE ndos = @n", cn))
            {
                c.Parameters.AddWithValue("@n", ndos);
                try
                {
                    using (SqlDataReader r = c.ExecuteReader())
                        if (r.Read()) for (int i = 0; i < r.FieldCount; i++) { string v = Valor(r[i]); if (v != "" && v != "0") l.Add("  " + r.GetName(i) + " = " + v); }
                }
                catch (Exception e) { l.Add("  (" + e.Message + ")"); }
            }
        }
        return l;
    }

    // Armazens existentes e quantos artigos/stock tem cada um (so leitura).
    public List<string> ListaArmazens()
    {
        List<string> l = new List<string>();
        using (SqlConnection cn = Abrir())
        using (SqlCommand c = new SqlCommand("SELECT armazem, COUNT(*) AS artigos, SUM(CASE WHEN stock <> 0 THEN 1 ELSE 0 END) AS comstock, SUM(stock) AS total " +
            "FROM sa WITH (NOLOCK) GROUP BY armazem ORDER BY armazem", cn))
        using (SqlDataReader r = c.ExecuteReader())
            while (r.Read()) l.Add("armazem " + Valor(r["armazem"]) + ": " + r["artigos"] + " artigos, " + r["comstock"] + " com stock, total " + Valor(r["total"]));
        if (l.Count == 0) l.Add("(tabela sa vazia)");
        return l;
    }

    public List<string> VerDossier(int ndos, long numero)
    {
        List<string> l = new List<string>();
        using (SqlConnection cn = Abrir())
        {
            using (SqlCommand c = new SqlCommand("SELECT COUNT(*) AS n, SUM(CASE WHEN fechada = 1 THEN 1 ELSE 0 END) AS fechadas, " +
                "MIN(dataobra) AS d1, MAX(dataobra) AS d2 FROM bo WITH (NOLOCK) WHERE ndos = @n", cn))
            {
                c.Parameters.AddWithValue("@n", ndos);
                using (SqlDataReader r = c.ExecuteReader())
                    if (r.Read())
                        l.Add("Serie " + ndos + ": " + r["n"] + " documentos, " + r["fechadas"] + " fechados, de " +
                              (r["d1"] == DBNull.Value ? "-" : Convert.ToDateTime(r["d1"]).ToString("yyyy-MM-dd")) + " a " +
                              (r["d2"] == DBNull.Value ? "-" : Convert.ToDateTime(r["d2"]).ToString("yyyy-MM-dd")));
            }
            string stamp = null;
            using (SqlCommand c = new SqlCommand(numero > 0
                ? "SELECT TOP 1 bostamp FROM bo WITH (NOLOCK) WHERE ndos = @n AND obrano = @o ORDER BY boano DESC"
                : "SELECT TOP 1 bostamp FROM bo WITH (NOLOCK) WHERE ndos = @n ORDER BY dataobra DESC, obrano DESC", cn))
            {
                c.Parameters.AddWithValue("@n", ndos);
                c.Parameters.AddWithValue("@o", numero);
                object o = c.ExecuteScalar();
                if (o != null) stamp = o.ToString().Trim();
            }
            if (stamp == null) { l.Add("Documento nao encontrado."); return l; }
            foreach (string t in new string[] { "bo", "bo2", "bo3" })
            {
                l.Add("");
                l.Add("--- " + t + " (so campos preenchidos)");
                using (SqlCommand c = new SqlCommand("SELECT * FROM " + t + " WITH (NOLOCK) WHERE " + t + "stamp = @s", cn))
                {
                    c.Parameters.AddWithValue("@s", stamp);
                    try
                    {
                        using (SqlDataReader r = c.ExecuteReader())
                            if (r.Read())
                                for (int i = 0; i < r.FieldCount; i++)
                                {
                                    string v = Valor(r[i]);
                                    if (v != "") l.Add("  " + r.GetName(i) + " = " + v);
                                }
                    }
                    catch (Exception e) { l.Add("  (" + e.Message + ")"); }
                }
            }
            // Tabelas proprias (ex.: registo de tempos, valor hora) ligadas ao dossier por uma coluna *bostamp.
            List<string[]> ligadas = new List<string[]>();
            using (SqlCommand c = new SqlCommand("SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
                "WHERE COLUMN_NAME LIKE '%bostamp%' AND TABLE_NAME NOT IN ('bo','bo2','bo3','bi','bi2','bo_mail') " +
                "AND TABLE_NAME NOT LIKE '%[_]hist%' ORDER BY TABLE_NAME", cn))
            using (SqlDataReader r = c.ExecuteReader())
                while (r.Read()) ligadas.Add(new string[] { r.GetString(0), r.GetString(1) });
            foreach (string[] t in ligadas)
            {
                List<string> linhas = new List<string>();
                using (SqlCommand c = new SqlCommand("SELECT TOP 30 * FROM [" + t[0] + "] WITH (NOLOCK) WHERE [" + t[1] + "] = @s", cn))
                {
                    c.Parameters.AddWithValue("@s", stamp);
                    try
                    {
                        using (SqlDataReader r = c.ExecuteReader())
                            while (r.Read())
                            {
                                StringBuilder sb = new StringBuilder("  ");
                                for (int i = 0; i < r.FieldCount; i++)
                                {
                                    string n = r.GetName(i);
                                    if (n.EndsWith("stamp") || n.StartsWith("ousr") || n.StartsWith("usr") || n == "marcada") continue;
                                    string v = Valor(r[i]);
                                    if (v != "") sb.Append(n + "=" + v + "; ");
                                }
                                linhas.Add(sb.ToString());
                            }
                    }
                    catch (Exception e) { linhas.Add("  (" + e.Message + ")"); }
                }
                if (linhas.Count == 0) continue;
                l.Add("");
                l.Add("--- tabela " + t[0] + " (ligada por " + t[1] + ")");
                l.AddRange(linhas);
            }
            l.Add("");
            l.Add("--- linhas (bi, so campos preenchidos)");
            using (SqlCommand c = new SqlCommand("SELECT * FROM bi WITH (NOLOCK) WHERE bostamp = @s ORDER BY lordem", cn))
            {
                c.Parameters.AddWithValue("@s", stamp);
                using (SqlDataReader r = c.ExecuteReader())
                {
                    int k = 0;
                    while (r.Read() && k < 30)
                    {
                        k++;
                        StringBuilder sb = new StringBuilder("  #" + k + ":");
                        for (int i = 0; i < r.FieldCount; i++)
                        {
                            string n = r.GetName(i);
                            if (n.EndsWith("stamp")) continue;
                            string v = Valor(r[i]);
                            if (v != "") sb.Append(" " + n + "=" + v + ";");
                        }
                        l.Add(sb.ToString());
                    }
                }
            }
        }
        return l;
    }

    static string Valor(object o)
    {
        if (o == null || o == DBNull.Value) return "";
        if (o is DateTime) { DateTime d = (DateTime)o; return d.Year <= 1900 ? "" : d.ToString(d.TimeOfDay.Ticks == 0 ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm"); }
        if (o is bool) return (bool)o ? "1" : "";
        if (o is byte[]) return "";
        string s = Convert.ToString(o, CultureInfo.InvariantCulture).Trim();
        if (s == "0" || s == "0.00" || s == "0.000000" || s == "0.0") return "";
        decimal dec;
        if (decimal.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out dec) && dec == 0) return "";
        return s.Length > 300 ? s.Substring(0, 300) + "..." : s.Replace("\r", " ").Replace("\n", " ");
    }

    static string Linha(SqlDataReader r)
    {
        string u = r["u"] == DBNull.Value ? "-" : Convert.ToDateTime(r["u"]).ToString("yyyy-MM-dd");
        return string.Format("  {0,4}  {1,-40} {2,9} docs  ultimo {3}", r[0], r[1].ToString().Trim(), r["n"], u);
    }

    ClientePHC Ler(SqlDataReader r)
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
        return x;
    }

    public List<ClientePHC> Seguintes(Marca m, int max)
    {
        List<ClientePHC> l = new List<ClientePHC>();
        using (SqlConnection cn = Abrir())
        {
            Colunas(cn);
            string sql =
                "SELECT TOP (@max) " + Campos() + " FROM cl WITH (NOLOCK) " +
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
                    while (r.Read()) l.Add(Ler(r));
            }
        }
        return l;
    }

    static string S(SqlDataReader r, string col)
    {
        object o = r[col];
        return o == DBNull.Value ? "" : o.ToString().Trim();
    }

    // Diagnostico: valores mais frequentes de uma coluna da tabela cl (para escolher o filtro).
    public List<string> Valores(string coluna)
    {
        List<string> l = new List<string>();
        using (SqlConnection cn = Abrir())
        {
            if (!Colunas(cn).Contains(coluna)) throw new Exception("A tabela cl nao tem a coluna " + coluna + ".");
            using (SqlCommand c = new SqlCommand("SELECT TOP 40 cl.[" + coluna + "] AS v, COUNT(*) AS n FROM cl WITH (NOLOCK) " +
                "WHERE cl.estab = 0" + Filtro() + "GROUP BY cl.[" + coluna + "] ORDER BY COUNT(*) DESC", cn))
            using (SqlDataReader r = c.ExecuteReader())
                while (r.Read())
                    l.Add(string.Format("{0,8}  {1}", r["n"], r["v"] == DBNull.Value ? "(vazio)" : "\"" + r["v"].ToString().Trim() + "\""));
        }
        return l;
    }

    // Diagnostico: valores mais frequentes de uma coluna de um dossier interno (bo/bo2/bi), opcionalmente so de uma serie.
    public List<string> ValoresDossier(string tabela, string coluna, int ndos)
    {
        if (Array.IndexOf(new string[] { "bo", "bo2", "bo3", "bi" }, tabela) < 0) throw new Exception("Tabela nao permitida: " + tabela);
        List<string> l = new List<string>();
        using (SqlConnection cn = Abrir())
        {
            bool existe;
            using (SqlCommand c = new SqlCommand("SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t AND COLUMN_NAME = @c", cn))
            {
                c.Parameters.AddWithValue("@t", tabela);
                c.Parameters.AddWithValue("@c", coluna);
                existe = Convert.ToInt32(c.ExecuteScalar()) > 0;
            }
            if (!existe) throw new Exception("A tabela " + tabela + " nao tem a coluna " + coluna + ".");
            string junta = tabela == "bo" || tabela == "bi" ? "" : " INNER JOIN bo WITH (NOLOCK) ON bo.bostamp = x." + tabela + "stamp";
            string sql = "SELECT TOP 40 x.[" + coluna + "] AS v, COUNT(*) AS n FROM " + tabela + " x WITH (NOLOCK)" + junta +
                         (ndos > 0 ? " WHERE " + (junta == "" ? "x" : "bo") + ".ndos = " + ndos : "") +
                         " GROUP BY x.[" + coluna + "] ORDER BY COUNT(*) DESC";
            using (SqlCommand c = new SqlCommand(sql, cn))
            using (SqlDataReader r = c.ExecuteReader())
                while (r.Read())
                    l.Add(string.Format("{0,8}  {1}", r["n"], r["v"] == DBNull.Value ? "(vazio)" : "\"" + r["v"].ToString().Trim() + "\""));
        }
        return l;
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

    bool ignorarInativos;
    public DateTime Inicio = DateTime.Today;

    public FonteCsv(string f, bool ignorar)
    {
        ignorarInativos = ignorar;
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

    // Nos testes, "documentos recentes" vem de uma lista de numeros em FonteTesteDocumentos.
    public List<long> ComDocs = new List<long>();
    public List<ClientePHC> ComDocumentosRecentes(DateTime desde, HashSet<long> jaEnviados, int max)
    {
        List<ClientePHC> l = todos.FindAll(delegate(ClientePHC c) { return c.Estab == 0 && !c.Inativo && ComDocs.Contains(c.No) && !jaEnviados.Contains(c.No); });
        return l.GetRange(0, Math.Min(max, l.Count));
    }

    public List<ClientePHC> Seguintes(Marca m, int max)
    {
        List<ClientePHC> l = todos.FindAll(delegate(ClientePHC c)
        {
            if (c.Estab != 0) return false;
            if (ignorarInativos && c.Inativo && c.Data < Inicio) return false;
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

// ---------------------------------------------------------------- folhas de obra do PHC (dossier 114)
class LinhaPHC { public string Ref = "", Design = "", Unidade = ""; public decimal Qtd, Preco, Total; public DateTime? Data; }
class TempoPHC { public DateTime Data; public decimal Horas; public string Funcionario = ""; }
class ValorPHC { public DateTime Data; public decimal Horas, Preco, Total; public string TipoIntervencao = "", TipoTecnico = ""; }

class FolhaPHC
{
    public string Stamp = "";
    public long Numero;
    public int Ano;
    public DateTime Data;
    public DateTime Marcacao = new DateTime(1900, 1, 1); // bo.dataopen = «Marcação Cliente» (data agendada)
    public string Hora = "";
    public long ClienteNo;
    public string Nome = "", Ncont = "", Morada = "", Local = "", CodPost = "", Telefone = "";
    public string Tecnico = "", Contacto = "", Tipo = "", Estado = "", Descricao = "";
    public bool Fechada;
    public DateTime Criada;
    public string CriadaPor = "";
    public DateTime AltData;
    public string AltHora = "";
    public List<LinhaPHC> Linhas = new List<LinhaPHC>();
    public List<TempoPHC> Tempos = new List<TempoPHC>();
    public List<ValorPHC> Valores = new List<ValorPHC>();
    public List<KeyValuePair<DateTime, string>> Servico = new List<KeyValuePair<DateTime, string>>();
    public List<string> Tarefas = new List<string>();
    public string Relatorio = "", ObsInternas = "", Encomenda = "", Situacao = "", EmailContacto = "";
    public string TecResp = "";       // bo.tabela2 ("Apelido, Nome") - tecnico responsavel no ecra do PHC
    public decimal TotalVenda;
    public long Chave { get { return (long)Ano * 10000000L + Numero; } }
}

interface IFonteFolhas
{
    List<FolhaPHC> FolhasSeguintes(Marca desde, int max);
    long MaiorNumero(int ano);
}

// ---------------------------------------------------------------- artigos e stock (armazem da climatizacao)
class ArtigoPHC
{
    public string Ref = "", Design = "", Unidade = "", Familia = "";
    public bool Inativo, ComSerie;
    public decimal Stock, Reservado, EmGuias, Custo;
    // Identifica o estado enviado (para so reenviar quando muda).
    public string Assinatura()
    {
        return string.Join("|", new string[] { Design, Unidade, Familia, Inativo ? "1" : "0", ComSerie ? "S" : "",
            Stock.ToString(CultureInfo.InvariantCulture), Reservado.ToString(CultureInfo.InvariantCulture),
            EmGuias.ToString(CultureInfo.InvariantCulture), Custo.ToString(CultureInfo.InvariantCulture) });
    }
}

interface IFonteArtigos
{
    // Referencias com alteracoes (ficha, stock ou linhas de FO/guias) desde a data; desde == null: todas as do armazem.
    List<string> ArtigosAlterados(DateTime? desde);
    List<ArtigoPHC> LerArtigos(List<string> refs);
}

// So para testes: artigos num CSV (ref;design;unidade;familia;inactivo;stock;reservado;guias;custo;usrdata).
class FonteCsvArtigos : IFonteArtigos
{
    List<ArtigoPHC> todos = new List<ArtigoPHC>();
    Dictionary<string, DateTime> alt = new Dictionary<string, DateTime>();
    public FonteCsvArtigos(string f)
    {
        string[] ls = File.ReadAllLines(f, Encoding.UTF8);
        for (int i = 1; i < ls.Length; i++)
        {
            string[] v = ls[i].Split(';');
            if (v.Length < 10) continue;
            ArtigoPHC a = new ArtigoPHC();
            a.Ref = v[0]; a.Design = v[1]; a.Unidade = v[2]; a.Familia = v[3]; a.Inativo = v[4] == "1";
            a.Stock = decimal.Parse(v[5], CultureInfo.InvariantCulture); a.Reservado = decimal.Parse(v[6], CultureInfo.InvariantCulture);
            a.EmGuias = decimal.Parse(v[7], CultureInfo.InvariantCulture); a.Custo = decimal.Parse(v[8], CultureInfo.InvariantCulture);
            if (v.Length > 10) a.ComSerie = v[10] == "1";
            todos.Add(a);
            alt[a.Ref] = DateTime.ParseExact(v[9], "yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
    }
    public List<string> ArtigosAlterados(DateTime? desde)
    {
        List<string> l = new List<string>();
        foreach (ArtigoPHC a in todos) if (!desde.HasValue || alt[a.Ref] >= desde.Value) l.Add(a.Ref);
        return l;
    }
    public List<ArtigoPHC> LerArtigos(List<string> refs)
    {
        List<ArtigoPHC> l = new List<ArtigoPHC>();
        foreach (ArtigoPHC a in todos) if (refs.Contains(a.Ref)) l.Add(a);
        return l;
    }
}

// So para testes: folhas num CSV (separador ;) e linhas noutro.
class FonteCsvFolhas : IFonteFolhas
{
    List<FolhaPHC> todas = new List<FolhaPHC>();

    public FonteCsvFolhas(string f, string fLinhas)
    {
        string[] ls = File.ReadAllLines(f, Encoding.UTF8);
        string[] cab = ls[0].Split(';');
        for (int i = 1; i < ls.Length; i++)
        {
            if (ls[i].Trim() == "") continue;
            string[] v = ls[i].Split(';');
            Dictionary<string, string> d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int k = 0; k < cab.Length; k++) d[cab[k]] = k < v.Length ? v[k] : "";
            FolhaPHC x = new FolhaPHC();
            x.Stamp = d["bostamp"]; x.Numero = long.Parse(d["obrano"]); x.Ano = int.Parse(d["boano"]);
            x.Data = DateTime.ParseExact(d["dataobra"], "yyyy-MM-dd", CultureInfo.InvariantCulture); x.Hora = d["xpdhora"];
            if (d.ContainsKey("dataopen") && d["dataopen"] != "") x.Marcacao = DateTime.ParseExact(d["dataopen"], "yyyy-MM-dd", CultureInfo.InvariantCulture);
            x.ClienteNo = long.Parse(d["no"]); x.Nome = d["nome"]; x.Ncont = d["ncont"]; x.Morada = d["morada"]; x.Local = d["local"];
            x.CodPost = d["codpost"]; x.Telefone = d["telefone"]; x.Tecnico = d["tecnnm"]; x.Contacto = d["trab1"]; x.Tipo = d["trab5"];
            x.Estado = d["tabela1"]; x.Descricao = d["u_davaria"]; x.Fechada = d["fechada"] == "1";
            string tmp;
            if (d.TryGetValue("tabela2", out tmp)) x.TecResp = tmp;
            if (d.TryGetValue("etotaldeb", out tmp) && tmp != "") x.TotalVenda = decimal.Parse(tmp, CultureInfo.InvariantCulture);
            if (d.TryGetValue("u_dinterve", out tmp)) x.Relatorio = tmp;
            if (d.TryGetValue("obstab2", out tmp)) x.ObsInternas = tmp;
            if (d.TryGetValue("obranome", out tmp)) x.Encomenda = tmp;
            if (d.TryGetValue("u_resnego", out tmp)) x.Situacao = tmp;
            x.Criada = DateTime.ParseExact(d["ousrdata"], "yyyy-MM-dd", CultureInfo.InvariantCulture); x.CriadaPor = d["ousrinis"];
            x.AltData = DateTime.ParseExact(d["usrdata"], "yyyy-MM-dd", CultureInfo.InvariantCulture); x.AltHora = d["usrhora"];
            todas.Add(x);
        }
        if (fLinhas != "" && File.Exists(fLinhas))
        {
            string[] ll = File.ReadAllLines(fLinhas, Encoding.UTF8);
            for (int i = 1; i < ll.Length; i++)
            {
                string[] v = ll[i].Split(';');
                if (v.Length < 5) continue;
                FolhaPHC fo = todas.Find(delegate(FolhaPHC z) { return z.Stamp == v[0]; });
                if (fo == null) continue;
                LinhaPHC li = new LinhaPHC();
                li.Ref = v[1]; li.Design = v[2]; li.Qtd = decimal.Parse(v[3], CultureInfo.InvariantCulture); li.Unidade = v[4];
                fo.Linhas.Add(li);
            }
        }
    }

    // tempos.csv: bostamp;data;horas;funcionario   valores.csv: bostamp;data;horas;tipointervencao;tipotecnico;preco;total
    public void Extras(string fTempos, string fValores)
    {
        if (fTempos != "" && File.Exists(fTempos))
            foreach (string l in File.ReadAllLines(fTempos, Encoding.UTF8))
            {
                string[] v = l.Split(';');
                FolhaPHC fo = v.Length >= 4 ? todas.Find(delegate(FolhaPHC z) { return z.Stamp == v[0]; }) : null;
                if (fo == null) continue;
                TempoPHC t = new TempoPHC();
                t.Data = DateTime.ParseExact(v[1], "yyyy-MM-dd", CultureInfo.InvariantCulture); t.Horas = decimal.Parse(v[2], CultureInfo.InvariantCulture); t.Funcionario = v[3];
                fo.Tempos.Add(t);
            }
        if (fValores != "" && File.Exists(fValores))
            foreach (string l in File.ReadAllLines(fValores, Encoding.UTF8))
            {
                string[] v = l.Split(';');
                FolhaPHC fo = v.Length >= 7 ? todas.Find(delegate(FolhaPHC z) { return z.Stamp == v[0]; }) : null;
                if (fo == null) continue;
                ValorPHC x = new ValorPHC();
                x.Data = DateTime.ParseExact(v[1], "yyyy-MM-dd", CultureInfo.InvariantCulture); x.Horas = decimal.Parse(v[2], CultureInfo.InvariantCulture);
                x.TipoIntervencao = v[3]; x.TipoTecnico = v[4]; x.Preco = decimal.Parse(v[5], CultureInfo.InvariantCulture); x.Total = decimal.Parse(v[6], CultureInfo.InvariantCulture);
                fo.Valores.Add(x);
            }
    }

    public List<FolhaPHC> FolhasSeguintes(Marca m, int max)
    {
        List<FolhaPHC> l = todas.FindAll(delegate(FolhaPHC x)
        {
            int a = x.AltData.CompareTo(m.Data); if (a != 0) return a > 0;
            int b = string.CompareOrdinal(x.AltHora, m.Hora); if (b != 0) return b > 0;
            return x.Chave > m.No;
        });
        l.Sort(delegate(FolhaPHC x, FolhaPHC y)
        {
            int a = x.AltData.CompareTo(y.AltData); if (a != 0) return a;
            int b = string.CompareOrdinal(x.AltHora, y.AltHora); if (b != 0) return b;
            return x.Chave.CompareTo(y.Chave);
        });
        return l.GetRange(0, Math.Min(max, l.Count));
    }

    public long MaiorNumero(int ano)
    {
        long n = 0;
        foreach (FolhaPHC x in todas) if (x.Ano == ano && x.Numero > n) n = x.Numero;
        return n;
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

// ---------------------------------------------------------------- email (SMTP do Exchange interno)
static class Correio
{
    public static void Enviar(Config cfg, string para, string assunto, string html, string texto)
    {
        Enviar(cfg, para, assunto, html, texto, null);
    }

    // imagens: cid -> PNG (no html: <img src="cid:nome">)
    public static void Enviar(Config cfg, string para, string assunto, string html, string texto, Dictionary<string, byte[]> imagens)
    {
        string servidor = cfg.Get("SmtpServidor", "");
        if (servidor == "") throw new Exception("SmtpServidor em falta no PontePHC.ini.");
        string de = cfg.Get("EmailDe", "noreply@arpuro.pt");
        using (MailMessage m = new MailMessage())
        {
            m.From = new MailAddress(de, cfg.Get("EmailNomeDe", "Arpuro Climatizacao"), Encoding.UTF8);
            foreach (string d in para.Split(new char[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries)) m.To.Add(d.Trim());
            string resp = cfg.Get("EmailResponderPara", "");
            if (resp != "") m.ReplyToList.Add(resp);
            foreach (string d in cfg.Get("EmailCopiaOculta", "").Split(new char[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries)) m.Bcc.Add(d.Trim());
            m.Subject = assunto;
            m.SubjectEncoding = Encoding.UTF8;
            m.BodyEncoding = Encoding.UTF8;
            if (texto != null)
            {
                m.Body = texto;
                m.IsBodyHtml = false;
                if (html != null)
                {
                    AlternateView av = AlternateView.CreateAlternateViewFromString(html, Encoding.UTF8, "text/html");
                    if (imagens != null)
                        foreach (KeyValuePair<string, byte[]> im in imagens)
                        {
                            LinkedResource lr = new LinkedResource(new MemoryStream(im.Value), "image/png");
                            lr.ContentId = im.Key;
                            lr.TransferEncoding = System.Net.Mime.TransferEncoding.Base64;
                            av.LinkedResources.Add(lr);
                        }
                    m.AlternateViews.Add(av);
                }
            }
            else { m.Body = html; m.IsBodyHtml = true; }
            using (SmtpClient c = new SmtpClient(servidor, cfg.GetInt("SmtpPorta", 25)))
            {
                c.EnableSsl = cfg.GetBool("SmtpSsl", false);
                c.Timeout = 30000;
                string u = cfg.Get("SmtpUtilizador", "");
                if (u != "") c.Credentials = new NetworkCredential(u, cfg.GetSegredo("SmtpSenha"));
                else c.UseDefaultCredentials = cfg.GetBool("SmtpCredenciaisWindows", false);
                c.Send(m);
            }
        }
    }
}

// ---------------------------------------------------------------- motor
class Motor
{
    Config cfg;
    IFonteClientes fonte;
    Firestore fs;
    string fMarca, fQuota, fInicio, fEnviados;
    HashSet<long> enviados;
    string ultimoErro = "";

    public Motor(Config c)
    {
        cfg = c;
        string teste = cfg.Caminho("FonteTeste");
        fonte = teste != "" ? (IFonteClientes)new FonteCsv(teste, cfg.GetBool("IgnorarInativos", true)) : new PhcSql(c);
        fMarca = Path.Combine(cfg.Pasta, "estado_clientes.txt");
        fQuota = Path.Combine(cfg.Pasta, "estado_escritas.txt");
        fInicio = Path.Combine(cfg.Pasta, "estado_inicio.txt");
        fEnviados = Path.Combine(cfg.Pasta, "estado_enviados.txt");
        FonteCsv csv = fonte as FonteCsv;
        if (csv != null)
            foreach (string x in cfg.Get("FonteTesteDocumentos", "").Split(',')) { long n; if (long.TryParse(x.Trim(), out n)) csv.ComDocs.Add(n); }
        PhcSql sql = fonte as PhcSql;
        if (sql != null && File.Exists(fInicio))
            sql.Inicio = DateTime.ParseExact(File.ReadAllText(fInicio).Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture);
    }

    public IFonteClientes Fonte { get { return fonte; } }

    IFonteFolhas fonteFolhas;
    string fMarcaFolhas;

    IFonteFolhas FonteFolhas
    {
        get
        {
            if (fonteFolhas == null)
            {
                string teste = cfg.Caminho("FonteTesteFolhas");
                if (teste != "")
                {
                    FonteCsvFolhas csv = new FonteCsvFolhas(teste, cfg.Caminho("FonteTesteLinhas"));
                    csv.Extras(cfg.Caminho("FonteTesteTempos"), cfg.Caminho("FonteTesteValores"));
                    fonteFolhas = csv;
                }
                else fonteFolhas = (IFonteFolhas)fonte;
            }
            return fonteFolhas;
        }
    }

    // ---- folhas de obra: PHC -> plataforma
    static string Tipo(string trab5)
    {
        string t = Regras.Normalizar(trab5);
        if (t.StartsWith("manut")) return "Manutenção";
        if (t.StartsWith("instal")) return "Instalação";
        return "AT";
    }

    // Estado da plataforma a partir do campo tabela1 do PHC (e de o dossier estar fechado = faturado).
    static string Estado(FolhaPHC f, out string motivo)
    {
        motivo = null;
        if (f.Fechada) return "Faturada";
        string e = f.Estado.Trim();
        if (e.StartsWith("5.1")) return "Aguarda NE";
        if (e.StartsWith("5")) return "Conclu\u00edda";   // concluída pelo técnico; a revisão é feita na plataforma (Master)
        if (e.StartsWith("4.1")) { motivo = "Peças"; return "Pendente"; }
        if (e.StartsWith("4.2")) { motivo = "Cliente"; return "Pendente"; }
        if (e.StartsWith("4")) { motivo = "Outro"; return "Pendente"; }
        if (e.StartsWith("3")) return "Em curso";
        return "Agendada";   // 1-Registado, 2-Atribuido, vazio
    }

    // data agendada = «Marcação Cliente» (bo.dataopen); sem marcação, a data do documento
    static DateTime Prevista(FolhaPHC f) { return Juntar(f.Marcacao.Year > 1900 ? f.Marcacao : f.Data, f.Hora); }

    // ordem dos estados: o PHC só faz avançar (Em curso <-> Pendente é permitido)
    static int Ordem(string e)
    {
        switch (e)
        {
            case "Por agendar": return 0; case "Agendada": return 1; case "Em curso": case "Pendente": return 2;
            case "Conclu\u00edda": return 3; case "Revista": return 4; case "Aguarda NE": return 5; case "Faturada": return 6; default: return 9;
        }
    }
    static bool Avanca(string atual, string novo)
    {
        if (novo == atual || novo == "Agendada" || Ordem(atual) >= 6) return false;   // agendar e faturar/anular tratam-se à parte
        return Ordem(novo) > Ordem(atual) || (Ordem(novo) == 2 && Ordem(atual) == 2);
    }
    static int TamanhoLista(Dictionary<string, object> campos, string k)
    {
        object v;
        if (campos == null || !campos.TryGetValue(k, out v)) return 0;
        Dictionary<string, object> a = v as Dictionary<string, object>;
        object av;
        if (a == null || !a.TryGetValue("arrayValue", out av)) return 0;
        Dictionary<string, object> m = av as Dictionary<string, object>;
        object vals;
        if (m == null || !m.TryGetValue("values", out vals)) return 0;
        System.Collections.ICollection c = vals as System.Collections.ICollection;
        return c == null ? 0 : c.Count;
    }

    static DateTime Juntar(DateTime data, string hora)
    {
        TimeSpan t;
        if (TimeSpan.TryParse((hora ?? "").Trim(), out t) && t.TotalHours < 24) return data.Date + t;
        return data.Date.AddHours(9);
    }

    // "Duarte, Paulo" -> "Paulo Duarte"
    public static string NomeNormal(string s)
    {
        s = (s ?? "").Trim();
        int i = s.IndexOf(',');
        return i > 0 ? (s.Substring(i + 1).Trim() + " " + s.Substring(0, i).Trim()).Trim() : s;
    }

    static string NomeTecnico(FolhaPHC f) { return f.TecResp != "" ? NomeNormal(f.TecResp) : f.Tecnico; }

    public static string IdFolha(FolhaPHC f) { return "phc" + "-" + f.Ano + "-" + f.Numero; }

    // nome normalizado -> uid/nome; e chaves TecnicoPHC.<nome no PHC>=<email> no .ini
    Dictionary<string, string[]> MapaTecnicos()
    {
        Dictionary<string, string[]> porNome = new Dictionary<string, string[]>();
        Dictionary<string, string[]> porEmail = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
        foreach (KeyValuePair<string, Dictionary<string, object>> u in fs.Listar("utilizadores"))
        {
            if (Firestore.Valor(u.Value, "ativo") != "true") continue;
            string nome = Firestore.Valor(u.Value, "nome");
            string[] par = new string[] { u.Key, nome };
            porNome[Regex.Replace(Regras.Normalizar(nome), @"\s+", " ").Trim()] = par;
            porEmail[Firestore.Valor(u.Value, "email")] = par;
        }
        foreach (KeyValuePair<string, string> kv in cfg.ComPrefixo("TecnicoPHC."))
        {
            string[] par;
            if (porEmail.TryGetValue(kv.Value.Trim(), out par)) porNome[Regex.Replace(Regras.Normalizar(kv.Key), @"\s+", " ").Trim()] = par;
            else Log.Erro("TecnicoPHC." + kv.Key + ": nao ha utilizador ativo com o email " + kv.Value);
        }
        return porNome;
    }

    public static Documento ConverterFolha(FolhaPHC f, Dictionary<string, string[]> tecnicos)
    {
        Documento d = new Documento();
        d.Id = IdFolha(f);
        string motivo;
        string estado = Estado(f, out motivo);
        string[] tec = null;
        string nomePHC = NomeTecnico(f);
        foreach (string cand in new string[] { NomeNormal(f.TecResp), f.Tecnico })
            if (tec == null && cand != "") tecnicos.TryGetValue(Regex.Replace(Regras.Normalizar(cand), @"\s+", " ").Trim(), out tec);
        string tecUid = tec != null ? tec[0] : "";
        string tecNome = tec != null ? tec[1] : nomePHC;
        f.Tecnico = nomePHC;
        bool semData = f.Data.Year <= 1900;
        if (tecUid == "")
        {
            // Por iniciar e sem tecnico conhecido: fica para atribuir. Restantes: tecnico do PHC so como nome.
            if (estado == "Agendada") estado = "Por agendar";
            else if (f.Tecnico != "") tecUid = "phc:" + f.Tecnico;
            else if (estado == "Em curso" || estado == "Pendente") estado = "Por agendar";
            else tecUid = "phc:sem-tecnico";
        }
        if (semData && estado != "Por agendar") estado = "Por agendar";
        string pais; bool ok;
        string nif = Regras.Nif(f.Ncont, out pais, out ok);
        string cp = Regex.Match(f.CodPost ?? "", @"\d{4}-\d{3}").Value;
        DateTime criada = Juntar(f.Criada, "");

        d.Texto("numero", "FO-" + f.Ano + "-" + f.Numero.ToString("0000"));
        d.Texto("clienteId", "phc-" + f.ClienteNo);
        d.Texto("clienteNome", f.Nome != "" ? f.Nome : "(sem nome)");
        d.Texto("clienteNif", nif);
        d.Texto("morada", (f.Morada ?? "").Replace("|", ", ").Trim());
        d.Texto("codigoPostal", cp);
        d.Texto("localidade", f.Local);
        d.Texto("contacto", f.Contacto);
        d.Texto("telefone", f.Telefone);
        d.Texto("tipo", Tipo(f.Tipo));
        d.Texto("tecnicoUid", tecUid);
        d.Texto("tecnicoNome", tecNome);
        // data agendada = «Marcação Cliente» (bo.dataopen); sem marcação, a data do documento
        d.Data("dataPrevista", semData ? (DateTime?)null : Prevista(f));
        d.Texto("marcacaoPHC", Prevista(f).ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture));
        d.Texto("descricao", f.Descricao);
        d.Texto("estado", estado);
        Documento h = new Documento();
        h.Texto("estado", estado); h.Nulo("de"); h.Texto("uid", "phc"); h.Texto("nome", "Importada do PHC" + (f.CriadaPor != "" ? " (" + f.CriadaPor + ")" : ""));
        h.Data("em", criada);
        if (motivo != null) h.Texto("motivo", motivo);
        d.ListaMapas("historico", new List<Documento> { h });
        if (estado == "Pendente")
        {
            Documento p = new Documento();
            p.Texto("motivo", motivo); p.Texto("nota", "Estado no PHC: " + f.Estado); p.Nulo("reverEm");
            p.Texto("uid", "phc"); p.Texto("nome", "PHC"); p.Data("em", Juntar(f.AltData, f.AltHora));
            d.Mapa("pendencia", p);
        }
        d.Texto("observacoesTecnico", "");
        d.Data("criadoEm", criada);
        d.Texto("criadoPor", "phc");
        d.Texto("criadoPorNome", "PHC" + (f.CriadaPor != "" ? " (" + f.CriadaPor + ")" : ""));
        d.Data("estadoAlteradoEm", Juntar(f.AltData, f.AltHora));
        d.Data("atualizadoEm", Juntar(f.AltData, f.AltHora));
        d.Texto("atualizadoPor", "phc");
        DadosPHC(d, f);
        return d;
    }

    // Campos que vem sempre do PHC (atualizados tambem em folhas ja importadas). Sem precos.
    static void DadosPHC(Documento d, FolhaPHC f)
    {
        List<Documento> ts = new List<Documento>();
        foreach (TempoPHC t in f.Tempos)
        {
            Documento x = new Documento();
            x.Data("data", t.Data); x.Decimal("horas", t.Horas); x.Texto("funcionario", NomeNormal(t.Funcionario));
            ts.Add(x);
        }
        d.ListaMapas("temposPHC", ts);
        List<Documento> hs = new List<Documento>();
        foreach (KeyValuePair<DateTime, string> h in f.Servico)
        {
            Documento x = new Documento();
            x.Data("em", h.Key); x.Texto("texto", h.Value);
            hs.Add(x);
        }
        d.ListaMapas("historicoPHC", hs);
        d.Lista("tarefasPHC", f.Tarefas);
        d.Texto("relatorioPHC", f.Relatorio);
        d.Texto("observacoesInternasPHC", f.ObsInternas);
        d.Texto("encomendaCliente", f.Encomenda);
        d.Texto("situacaoPHC", f.Situacao);
        d.Texto("emailContacto", f.EmailContacto);
        // pesquisa na plataforma: n.º, cliente, NIF, descricao da avaria (prefixos de 2 a 15 letras, maximo 400)
        List<string> tk = Regras.Tokens("FO-" + f.Ano + "-" + f.Numero.ToString("0000"), f.Numero.ToString(), f.Nome, Regex.Replace(f.Ncont ?? "", @"\D", ""), f.Descricao);
        if (tk.Count > 400) tk = tk.GetRange(0, 400);
        d.Lista("pesquisa", tk);
        d.Texto("origem", "phc");
        d.Texto("phcStamp", f.Stamp);
        d.Inteiro("phcNumero", f.Numero);
        d.Texto("phcEstado", f.Estado);
        d.Bool("phcFechada", f.Fechada);
        List<Documento> ls = new List<Documento>();
        foreach (LinhaPHC l in f.Linhas)
        {
            Documento x = new Documento();
            x.Texto("ref", l.Ref); x.Texto("descricao", l.Design); x.Decimal("qtd", l.Qtd); x.Texto("unidade", l.Unidade); x.Data("data", l.Data);
            ls.Add(x);
        }
        d.ListaMapas("linhasPHC", ls);
    }

    // Valores (precos, totais, valor hora): documento separado que so o Master pode ler (folhas/{id}/privado/phc).
    public static Documento Privado(FolhaPHC f)
    {
        Documento d = new Documento();
        d.Id = IdFolha(f) + "/privado/phc";
        d.Decimal("totalVenda", f.TotalVenda);
        List<Documento> ls = new List<Documento>();
        foreach (LinhaPHC l in f.Linhas)
        {
            Documento x = new Documento();
            x.Texto("ref", l.Ref); x.Texto("descricao", l.Design); x.Decimal("qtd", l.Qtd); x.Decimal("preco", l.Preco); x.Decimal("total", l.Total); x.Data("data", l.Data);
            ls.Add(x);
        }
        d.ListaMapas("linhas", ls);
        List<Documento> vs = new List<Documento>();
        foreach (ValorPHC v in f.Valores)
        {
            Documento x = new Documento();
            x.Data("data", v.Data); x.Decimal("horas", v.Horas); x.Texto("tipoIntervencao", v.TipoIntervencao); x.Texto("tipoTecnico", v.TipoTecnico);
            x.Decimal("preco", v.Preco); x.Decimal("total", v.Total);
            vs.Add(x);
        }
        d.ListaMapas("valorHora", vs);
        return d;
    }

    // Folha que ja existe na plataforma: so dados do PHC; se foi faturada no PHC, passa a Faturada.
    static Documento AtualizarFolha(FolhaPHC f, Dictionary<string, object> atual)
    {
        Documento d = new Documento();
        d.Id = IdFolha(f);
        DadosPHC(d, f);
        // Data agendada no PHC («Marcação Cliente» + hora). Só substitui a da plataforma quando a marcação muda no PHC;
        // um reagendamento feito na plataforma mantém-se até haver nova marcação no PHC.
        DateTime prev = Prevista(f);
        string marcNova = prev.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);
        string marcAnt = Firestore.Valor(atual, "marcacaoPHC");
        bool mudar;
        if (marcAnt != "") mudar = marcAnt != marcNova;
        else
        {
            // folhas enviadas antes desta versão: corrige se a data ainda é a do documento (não foi reagendada na plataforma)
            DateTime cur;
            string s = Firestore.Valor(atual, "dataPrevista");
            mudar = s != "" && DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out cur)
                && cur == Juntar(f.Data, f.Hora).ToUniversalTime();
        }
        if (mudar && f.Data.Year > 1900) d.Data("dataPrevista", prev);
        d.Texto("marcacaoPHC", marcNova);
        string estadoAtual = Firestore.Valor(atual, "estado");
        string motivo;
        string novo = Estado(f, out motivo);
        // Enquanto a NetWorker estiver em uso, o estado acompanha o PHC quando este muda — só para a frente
        // (nunca desfaz o que foi revisto, pedido NE ou faturado na plataforma). As folhas importadas como «Revista»
        // pelas versões antigas (5-Concluído) e nunca mexidas na plataforma voltam a «Concluída» (por rever).
        bool mudouPHC = Firestore.Valor(atual, "phcEstado").Trim() != (f.Estado ?? "").Trim();
        bool legadoRevista = estadoAtual == "Revista" && novo == "Conclu\u00edda" && TamanhoLista(atual, "historico") == 1;
        if (!f.Fechada && (legadoRevista || (mudouPHC && Avanca(estadoAtual, novo))))
        {
            d.Texto("estado", novo);
            Documento h = new Documento();
            h.Texto("estado", novo); h.Texto("de", estadoAtual); h.Texto("uid", "phc"); h.Texto("nome", "PHC (" + (f.Estado ?? "").Trim() + ")");
            h.Data("em", DateTime.Now);
            if (motivo != null) h.Texto("motivo", motivo);
            d.Acrescentar("historico", h);
            d.HoraServidor("estadoAlteradoEm");
            if (novo == "Pendente")
            {
                Documento p = new Documento();
                p.Texto("motivo", motivo); p.Texto("nota", "Estado no PHC: " + f.Estado); p.Nulo("reverEm");
                p.Texto("uid", "phc"); p.Texto("nome", "PHC"); p.Data("em", Juntar(f.AltData, f.AltHora));
                d.Mapa("pendencia", p);
            }
            else if (estadoAtual == "Pendente") d.Nulo("pendencia");
            // fora de «Por agendar» a folha precisa de técnico e data
            if (Firestore.Valor(atual, "tecnicoUid") == "")
            {
                string nome = NomeTecnico(f);
                d.Texto("tecnicoUid", "phc:" + (nome != "" ? nome : "sem-tecnico"));
                d.Texto("tecnicoNome", nome);
            }
            if (Firestore.Valor(atual, "dataPrevista") == "" && !mudar) d.Data("dataPrevista", prev);
        }
        if (f.Fechada && estadoAtual != "Faturada")
        {
            d.Texto("estado", "Faturada");
            d.Nulo("pendencia");
            Documento h = new Documento();
            h.Texto("estado", "Faturada"); h.Texto("de", estadoAtual); h.Texto("uid", "phc"); h.Texto("nome", "PHC (faturada)");
            h.Data("em", DateTime.Now);
            d.Acrescentar("historico", h);
            d.HoraServidor("estadoAlteradoEm");
        }
        return d;
    }

    public int CicloFolhas()
    {
        if (!cfg.GetBool("ImportarFolhas", false)) return 0;
        int enviados = 0;
        bool sim = cfg.Simular || cfg.GetBool("SimularFolhas", false);
        try
        {
            if (fs == null && !sim) fs = new Firestore(cfg);
            fMarcaFolhas = Path.Combine(cfg.Pasta, "estado_folhas.txt");
            int lote = Math.Min(240, Math.Max(1, cfg.GetInt("LoteFolhas", 200)));   // 2 escritas por folha (folha + privado); maximo 500 por pedido
            int limite = cfg.GetInt("MaxEscritasPorDia", 15000);
            Marca m = Marca.Ler(fMarcaFolhas);
            Dictionary<string, string[]> tecnicos = sim ? new Dictionary<string, string[]>() : MapaTecnicos();
            HashSet<int> anos = new HashSet<int>();
            while (true)
            {
                int livres = limite - EscritasHoje();
                if (livres <= 0) { Log.Info("Limite diario de escritas atingido; as folhas continuam amanha."); break; }
                List<FolhaPHC> l = FonteFolhas.FolhasSeguintes(m, Math.Min(lote, livres));
                if (l.Count == 0) break;
                List<string> ids = new List<string>();
                foreach (FolhaPHC f in l) ids.Add(IdFolha(f));
                Dictionary<string, Dictionary<string, object>> existentes = sim ? new Dictionary<string, Dictionary<string, object>>() : fs.LerVarios("folhas", ids);
                List<Documento> docs = new List<Documento>();
                int novas = 0;
                foreach (FolhaPHC f in l)
                {
                    Dictionary<string, object> atual;
                    if (existentes.TryGetValue(IdFolha(f), out atual)) docs.Add(AtualizarFolha(f, atual));
                    else { docs.Add(ConverterFolha(f, tecnicos)); novas++; }
                    anos.Add(f.Ano);
                }
                foreach (FolhaPHC f in l) docs.Add(Privado(f));
                if (sim) foreach (Documento d in docs) Log.Info("SIMULACAO: enviaria folhas/" + d.Id);
                else { fs.Gravar("folhas", docs); ContarEscritas(docs.Count); }
                FolhaPHC u = l[l.Count - 1];
                m.Data = u.AltData; m.Hora = u.AltHora; m.No = u.Chave;
                if (!sim) m.Gravar(fMarcaFolhas);
                enviados += l.Count;
                Log.Info((sim ? "SIMULACAO: " : "") + l.Count + " folhas (" + novas + " novas). Marca: " + m);
                if (l.Count < Math.Min(lote, livres)) break;
                if (sim && enviados >= 1000) break;
            }
            // A numeracao da plataforma continua a do PHC (ano corrente).
            int ano = DateTime.Today.Year;
            if (!sim && anos.Contains(ano)) AcertarContador(ano);
        }
        catch (Exception e)
        {
            Log.Erro("Falha na importacao de folhas: " + e.GetType().Name + ": " + e.Message + (enviados > 0 ? " (" + enviados + " enviadas antes da falha)" : ""));
            ultimoErro = e.Message;
        }
        return enviados;
    }

    // ---- artigos: PHC -> artigos/{id} (sem precos) + artigos/{id}/privado/custo (so Master)
    IFonteArtigos fonteArtigos;
    IFonteArtigos FonteArtigos
    {
        get
        {
            if (fonteArtigos == null)
            {
                string teste = cfg.Caminho("FonteTesteArtigos");
                fonteArtigos = teste != "" ? (IFonteArtigos)new FonteCsvArtigos(teste) : (IFonteArtigos)new PhcSql(cfg);
            }
            return fonteArtigos;
        }
    }

    // Id do documento: a referencia, com os caracteres que o Firestore nao aceita trocados por ~XX.
    public static string IdArtigo(string r)
    {
        StringBuilder sb = new StringBuilder();
        foreach (char ch in r.Trim())
            if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.') sb.Append(ch);
            else sb.Append('~').Append(((int)ch).ToString("X2"));
        string id = sb.ToString();
        return id == "." || id == ".." || id == "" ? "~" + id : id;
    }

    public int CicloArtigos()
    {
        if (!cfg.GetBool("ImportarArtigos", false)) return 0;
        bool sim = cfg.Simular || cfg.GetBool("SimularArtigos", false);
        int enviados = 0;
        try
        {
            if (fs == null && !sim) fs = new Firestore(cfg);
            string fMarcaA = Path.Combine(cfg.Pasta, "estado_artigos.txt");
            string fCache = Path.Combine(cfg.Pasta, "estado_artigos_enviados.txt");
            DateTime? desde = null;
            if (File.Exists(fMarcaA)) desde = DateTime.ParseExact(File.ReadAllText(fMarcaA).Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture);
            DateTime inicio = DateTime.Today;
            Dictionary<string, string> cache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (File.Exists(fCache))
                foreach (string ln in File.ReadAllLines(fCache, Encoding.UTF8)) { int k = ln.IndexOf('\t'); if (k > 0) cache[ln.Substring(0, k)] = ln.Substring(k + 1); }
            List<string> refs = FonteArtigos.ArtigosAlterados(desde);
            int limite = cfg.GetInt("MaxEscritasPorDia", 15000);
            bool completo = true;
            for (int i = 0; i < refs.Count; i += 200)
            {
                List<ArtigoPHC> l = FonteArtigos.LerArtigos(refs.GetRange(i, Math.Min(200, refs.Count - i)));
                List<Documento> docs = new List<Documento>();
                List<ArtigoPHC> mudados = new List<ArtigoPHC>();
                foreach (ArtigoPHC a in l)
                {
                    string ass;
                    if (cache.TryGetValue(a.Ref, out ass) && ass == a.Assinatura()) continue;
                    mudados.Add(a);
                    Documento d = new Documento();
                    d.Id = IdArtigo(a.Ref);
                    d.Texto("ref", a.Ref); d.Texto("design", a.Design); d.Texto("unidade", a.Unidade); d.Texto("familia", a.Familia);
                    d.Bool("ativo", !a.Inativo);
                    d.Bool("comSerie", a.ComSerie);
                    d.Decimal("stock", a.Stock); d.Decimal("reservadoPHC", a.Reservado); d.Decimal("emGuiasPHC", a.EmGuias);
                    d.Lista("pesquisa", Regras.Tokens(a.Ref, a.Design));
                    d.Texto("origem", "phc");
                    docs.Add(d);
                    Documento p = new Documento();
                    p.Id = d.Id + "/privado/custo";
                    p.Decimal("custo", a.Custo);
                    docs.Add(p);
                }
                if (docs.Count == 0) continue;
                if (EscritasHoje() + docs.Count > limite) { Log.Info("Limite diario de escritas atingido; os artigos continuam amanha."); completo = false; break; }
                if (sim) Log.Info("SIMULACAO: enviaria " + mudados.Count + " artigos (ex.: " + mudados[0].Ref + " stock " + mudados[0].Stock + ", reservado " + mudados[0].Reservado + ", em guias " + mudados[0].EmGuias + ")");
                else
                {
                    fs.Gravar("artigos", docs); ContarEscritas(docs.Count);
                    foreach (ArtigoPHC a in mudados) cache[a.Ref] = a.Assinatura();
                    StringBuilder sb = new StringBuilder();
                    foreach (KeyValuePair<string, string> kv in cache) sb.Append(kv.Key).Append('\t').Append(kv.Value).Append("\r\n");
                    File.WriteAllText(fCache, sb.ToString(), Encoding.UTF8);
                }
                enviados += mudados.Count;
            }
            // a marca so avanca quando tudo foi enviado (o dia de hoje volta a ser visto no ciclo seguinte; a cache evita reenvios)
            if (!sim && completo) File.WriteAllText(fMarcaA, inicio.ToString("yyyy-MM-dd"));
            if (enviados > 0) Log.Info((sim ? "SIMULACAO: " : "") + enviados + " artigos " + (sim ? "seriam enviados." : "enviados (stock / reservas)."));
        }
        catch (Exception e)
        {
            Log.Erro("Falha na sincronizacao de artigos: " + e.GetType().Name + ": " + e.Message);
            ultimoErro = e.Message;
        }
        return enviados;
    }

    // ---- emails pedidos pela plataforma (ex.: relatorio ao cliente): emails/{id} com estado 'Pendente'
    // EmailsTeste=endereco -> em vez do cliente, envia tudo para esse endereco (fase de testes).
    public int CicloEmails()
    {
        if (!cfg.GetBool("EnviarEmails", false) || cfg.Simular) return 0;
        int n = 0;
        try
        {
            if (fs == null) fs = new Firestore(cfg);
            foreach (KeyValuePair<string, Dictionary<string, object>> e in fs.Consultar("emails", "estado", "Pendente", 20))
            {
                Dictionary<string, object> c = e.Value;
                string para = Firestore.Valor(c, "para"), assunto = Firestore.Valor(c, "assunto"), html = Firestore.Valor(c, "html"), texto = Firestore.Valor(c, "texto");
                string folhaId = Firestore.Valor(c, "folhaId");
                string teste = cfg.Get("EmailsTeste", "");
                string destino = teste != "" ? teste : para;
                if (teste != "") assunto = "[TESTE - seria para " + para + "] " + assunto;
                Documento d = new Documento();
                d.Id = e.Key;
                string estado = "Enviado", erro = "";
                try
                {
                    if (!Regex.IsMatch(para, @"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$")) throw new Exception("endereco invalido: " + para);
                    Dictionary<string, byte[]> imgs = new Dictionary<string, byte[]>();
                    string ass = Firestore.Valor(c, "assinaturaPng");
                    int k = ass.IndexOf("base64,");
                    if (k > 0) imgs["assinatura"] = Convert.FromBase64String(ass.Substring(k + 7));
                    Correio.Enviar(cfg, destino, assunto, html, texto == "" ? null : texto, imgs);
                    Log.Info("Email enviado para " + destino + ": " + assunto);
                    n++;
                }
                catch (Exception ex) { estado = "Erro"; erro = ex.Message; Log.Erro("Email " + e.Key + " nao enviado: " + ex.Message); }
                d.Texto("estado", estado);
                d.Texto("erro", erro);
                d.Texto("enviadoPara", estado == "Enviado" ? destino : "");
                d.Data("enviadoEm", DateTime.Now);
                List<Documento> docs = new List<Documento> { d };
                fs.Gravar("emails", docs);
                if (folhaId != "")
                {
                    Documento f = new Documento();
                    f.Id = folhaId;
                    Documento m = new Documento();
                    m.Texto("para", para); m.Texto("estado", estado); m.Texto("erro", erro); m.Texto("emailId", e.Key); m.Data("em", DateTime.Now);
                    f.Mapa(Firestore.Valor(c, "tipo") == "agendamento" ? "avisoEnviado" : "relatorioEnviado", m);
                    fs.Gravar("folhas", new List<Documento> { f });
                }
                ContarEscritas(folhaId != "" ? 2 : 1);
            }
        }
        catch (Exception e) { Log.Erro("Falha nos emails: " + e.GetType().Name + ": " + e.Message); }
        return n;
    }

    public List<KeyValuePair<string, Dictionary<string, object>>> Emails(string estado)
    {
        if (fs == null) fs = new Firestore(cfg);
        return fs.Consultar("emails", "estado", estado, 20);
    }

    public void CicloCompleto()
    {
        Ciclo();
        CicloFolhas();
        CicloArtigos();
        CicloEmails();
    }

    // ---- pedido de sincronizacao feito na plataforma (controlo/sincronizar: estado 'Pedido')
    public bool HaPedidoSincronizar()
    {
        if (cfg.Simular) return false;
        try
        {
            if (fs == null) fs = new Firestore(cfg);
            Dictionary<string, Dictionary<string, object>> r = fs.LerVarios("controlo", new List<string> { "sincronizar" });
            Dictionary<string, object> c;
            if (!r.TryGetValue("sincronizar", out c) || Firestore.Valor(c, "estado") != "Pedido") return false;
            Log.Info("Sincronizacao pedida na plataforma por " + Firestore.Valor(c, "pedidoPorNome") + ".");
            Documento d = new Documento();
            d.Id = "sincronizar";
            d.Texto("estado", "Em curso");
            d.Data("iniciadoEm", DateTime.Now);
            fs.Gravar("controlo", new List<Documento> { d });
            return true;
        }
        catch (Exception e) { Log.Erro("Falha ao ver pedidos de sincronizacao: " + e.Message); return false; }
    }
    public void ConcluirPedido()
    {
        try
        {
            Documento d = new Documento();
            d.Id = "sincronizar";
            d.Texto("estado", "Concluído");
            d.Texto("resultado", ultimoErro == "" || ultimoErro == "quota" ? "OK" + (ultimoErro == "quota" ? " (limite diário de escritas atingido)" : "") : "Erro: " + ultimoErro);
            d.Data("concluidoEm", DateTime.Now);
            fs.Gravar("controlo", new List<Documento> { d });
            ContarEscritas(2);
        }
        catch (Exception e) { Log.Erro("Falha ao concluir o pedido de sincronizacao: " + e.Message); }
    }

    void AcertarContador(int ano)
    {
        long maior = FonteFolhas.MaiorNumero(ano);
        Dictionary<string, Dictionary<string, object>> c = fs.LerVarios("contadores", new List<string> { "folhas-" + ano });
        long atual = 0;
        Dictionary<string, object> campos;
        if (c.TryGetValue("folhas-" + ano, out campos)) long.TryParse(Firestore.Valor(campos, "valor"), out atual);
        if (atual >= maior) return;
        Documento d = new Documento();
        d.Id = "folhas-" + ano;
        d.Inteiro("valor", maior);
        fs.Gravar("contadores", new List<Documento> { d });
        Log.Info("Numeracao das folhas " + ano + " acertada: a proxima folha criada na plataforma sera a " + (maior + 1) + ".");
    }

    public void Preparar()
    {
        Log.Limpar();
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

    HashSet<long> Enviados()
    {
        if (enviados != null) return enviados;
        enviados = new HashSet<long>();
        if (File.Exists(fEnviados))
            foreach (string l in File.ReadAllLines(fEnviados)) { long n; if (long.TryParse(l.Trim(), out n)) enviados.Add(n); }
        return enviados;
    }

    void MarcarEnviados(List<ClientePHC> l)
    {
        StringBuilder sb = new StringBuilder();
        foreach (ClientePHC c in l) if (Enviados().Add(c.No)) sb.Append(c.No).Append("\r\n");
        if (sb.Length > 0) File.AppendAllText(fEnviados, sb.ToString());
    }

    // Envia um lote; devolve o numero de documentos enviados.
    int Enviar(List<ClientePHC> l)
    {
        List<Documento> docs = new List<Documento>();
        foreach (ClientePHC c in l) if (c.Nome.Trim() != "") docs.Add(Converter(c));
        if (cfg.Simular)
        {
            foreach (Documento d in docs) Log.Info("SIMULACAO: enviaria clientes/" + d.Id);
            return docs.Count;
        }
        if (!File.Exists(fInicio)) File.WriteAllText(fInicio, DateTime.Today.ToString("yyyy-MM-dd"));
        fs.Gravar("clientes", docs);
        ContarEscritas(docs.Count);
        MarcarEnviados(l);
        return docs.Count;
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
                int n = Enviar(l);
                ClientePHC u = l[l.Count - 1];
                m.Data = u.Data; m.Hora = u.Hora; m.No = u.No;
                if (!cfg.Simular) m.Gravar(fMarca);
                enviados += n;
                if (l.Count < Math.Min(lote, livres)) break;
                if (cfg.Simular && enviados >= 2000) { Log.Info("SIMULACAO: parado aos 2000 clientes."); break; }
            }
            // Clientes que passaram a ter faturas/dossiers de climatizacao nos ultimos dias (a ficha nao mudou).
            int livres2 = limite - EscritasHoje();
            if (livres2 > 0 && !(cfg.Simular && enviados >= 2000))
            {
                List<ClientePHC> novos = fonte.ComDocumentosRecentes(DateTime.Today.AddDays(-cfg.GetInt("DiasDocumentos", 3)), Enviados(), Math.Min(lote, livres2));
                if (novos.Count > 0)
                {
                    enviados += Enviar(novos);
                    Log.Info((cfg.Simular ? "SIMULACAO: " : "") + novos.Count + " clientes com documentos recentes.");
                }
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
        if (File.Exists(fInicio)) File.Delete(fInicio);
        if (File.Exists(fEnviados)) File.Delete(fEnviados);
        string ff = Path.Combine(cfg.Pasta, "estado_folhas.txt");
        if (File.Exists(ff)) File.Delete(ff);
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
                int verificar = Math.Max(15, cfg.GetInt("VerificarPedidosSegundos", 30));
                while (!parar)
                {
                    m.CicloCompleto();
                    // ate ao proximo ciclo: de 30 em 30 s ve se ha pedido de sincronizacao (botao na plataforma) e emails por enviar
                    DateTime fim = DateTime.Now.AddSeconds(intervalo);
                    while (!parar && DateTime.Now < fim)
                    {
                        for (int i = 0; i < verificar * 2 && !parar && DateTime.Now < fim; i++) Thread.Sleep(500);
                        if (parar) break;
                        if (m.HaPedidoSincronizar()) { m.CicloCompleto(); m.ConcluirPedido(); }
                        else m.CicloEmails();
                    }
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
        if (chave != "SqlSenha" && chave != "SmtpSenha") { Console.WriteLine("Chave invalida. Use: SqlSenha ou SmtpSenha"); return 1; }
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
                Console.WriteLine("Clientes a enviar (estab 0" + (cfg.GetBool("IgnorarInativos", true) ? ", sem inativos" : "") +
                                  (cfg.Get("ClientesFiltro", "") != "" ? ", com o filtro " + cfg.Get("ClientesFiltro", "") : "") + "): " + m.Fonte.Total());
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
            if (cmd == "/valores" && args.Length >= 2 && args[1].Contains("."))
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql == null) { Console.WriteLine("So funciona com o SQL do PHC."); return 1; }
                string[] tc = args[1].ToLowerInvariant().Split('.');
                int nd = args.Length >= 3 ? int.Parse(args[2]) : 0;
                Console.WriteLine("Valores mais frequentes de " + args[1] + (nd > 0 ? " na serie " + nd : "") + ":");
                foreach (string v in sql.ValoresDossier(tc[0], tc[1], nd)) Console.WriteLine(v);
                Console.WriteLine("Nada foi enviado.");
                return 0;
            }
            if (cmd == "/valores" && args.Length == 2)
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql == null) { Console.WriteLine("So funciona com o SQL do PHC."); return 1; }
                Console.WriteLine("Valores mais frequentes de cl." + args[1] + (cfg.Get("ClientesFiltro", "") != "" ? " (com o filtro atual)" : "") + ":");
                foreach (string v in sql.Valores(args[1])) Console.WriteLine(v);
                Console.WriteLine("Nada foi enviado.");
                return 0;
            }
            if (cmd == "/series")
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql == null) { Console.WriteLine("So funciona com o SQL do PHC."); return 1; }
                foreach (string v in sql.ListaSeries()) Console.WriteLine(v);
                Console.WriteLine("Nada foi enviado.");
                return 0;
            }
            if (cmd == "/campos" && args.Length >= 2)
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql == null) { Console.WriteLine("So funciona com o SQL do PHC."); return 1; }
                foreach (string v in sql.CamposPreenchidos(int.Parse(args[1]))) Console.WriteLine(v);
                Console.WriteLine("Nada foi enviado.");
                return 0;
            }
            if (cmd == "/dossier" && args.Length >= 2)
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql == null) { Console.WriteLine("So funciona com o SQL do PHC."); return 1; }
                foreach (string v in sql.VerDossier(int.Parse(args[1]), args.Length >= 3 ? long.Parse(args[2]) : 0)) Console.WriteLine(v);
                Console.WriteLine("Nada foi enviado.");
                return 0;
            }
            if (cmd == "/artigo" && args.Length >= 2)
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql == null) { Console.WriteLine("So funciona com o SQL do PHC."); return 1; }
                foreach (string v in sql.VerArtigo(args[1])) Console.WriteLine(v);
                Console.WriteLine("Nada foi enviado.");
                return 0;
            }
            if (cmd == "/procurar" && args.Length >= 2)
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql == null) { Console.WriteLine("So funciona com o SQL do PHC."); return 1; }
                foreach (string v in sql.ProcurarArtigos(string.Join(" ", args, 1, args.Length - 1))) Console.WriteLine(v);
                Console.WriteLine("Nada foi enviado.");
                return 0;
            }
            if (cmd == "/guias")
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql == null) { Console.WriteLine("So funciona com o SQL do PHC."); return 1; }
                foreach (string v in sql.ResumoGuias()) Console.WriteLine(v);
                Console.WriteLine("Nada foi enviado.");
                return 0;
            }
            if (cmd == "/guias-abertas")
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql == null) { Console.WriteLine("So funciona com o SQL do PHC."); return 1; }
                foreach (string v in sql.GuiasAbertas()) Console.WriteLine(v);
                Console.WriteLine("Nada foi enviado.");
                return 0;
            }
            if (cmd == "/armazens")
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql == null) { Console.WriteLine("So funciona com o SQL do PHC."); return 1; }
                foreach (string v in sql.ListaArmazens()) Console.WriteLine(v);
                Console.WriteLine("Nada foi enviado.");
                return 0;
            }
            if (cmd == "/testar-email" && args.Length >= 2)
            {
                Correio.Enviar(cfg, args[1], "Teste da plataforma Climatizacao",
                    "<p>Este e um email de teste enviado pela <b>PontePHC</b> (servidor " + Environment.MachineName + ").</p><p>Se o recebeu, o envio de emails da plataforma esta a funcionar.</p>",
                    "Este e um email de teste enviado pela PontePHC (servidor " + Environment.MachineName + ").\r\nSe o recebeu, o envio de emails da plataforma esta a funcionar.");
                Console.WriteLine("Email de teste entregue ao servidor " + cfg.Get("SmtpServidor", "") + " para " + args[1] + ". Veja a caixa de correio (e o spam).");
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
                int nf = m.CicloFolhas();
                int na = m.CicloArtigos();
                int ne = m.CicloEmails();
                if (cfg.GetBool("EnviarEmails", false)) Console.WriteLine(ne + " emails enviados.");
                if (cfg.GetBool("ImportarArtigos", false)) Console.WriteLine(((cfg.Simular || cfg.GetBool("SimularArtigos", false)) ? "SIMULACAO: " : "") + na + " artigos com alteracoes.");
                bool simF = cfg.Simular || cfg.GetBool("SimularFolhas", false);
                if (cfg.GetBool("ImportarFolhas", false)) Console.WriteLine((simF ? "SIMULACAO: " : "") + nf + " folhas de obra " + (simF ? "seriam enviadas." : "enviadas."));
                Console.WriteLine((cfg.Simular ? "SIMULACAO: " : "") + n + " clientes " + (cfg.Simular ? "seriam enviados (nada enviado; veja Simular no .ini)." : "enviados."));
                return m.UltimoErro == "" || m.UltimoErro == "quota" ? 0 : 2;
            }
            if (cmd == "/emails")
            {
                Console.WriteLine("EnviarEmails=" + cfg.Get("EnviarEmails", "0") + "  EmailsTeste=" + cfg.Get("EmailsTeste", "") + "  SmtpServidor=" + cfg.Get("SmtpServidor", "") + "  EmailCopiaOculta=" + cfg.Get("EmailCopiaOculta", ""));
                foreach (string est in new string[] { "Pendente", "Erro", "Enviado" })
                {
                    List<KeyValuePair<string, Dictionary<string, object>>> l = m.Emails(est);
                    Console.WriteLine(est + ": " + l.Count + (l.Count == 20 ? "+" : ""));
                    foreach (KeyValuePair<string, Dictionary<string, object>> e in l)
                        Console.WriteLine("  " + e.Key + " | " + Firestore.Valor(e.Value, "folhaNumero") + " | para " + Firestore.Valor(e.Value, "para") + " | " + Firestore.Valor(e.Value, "erro"));
                }
                if (cfg.GetBool("EnviarEmails", false)) Console.WriteLine("A enviar os pendentes... " + m.CicloEmails() + " enviados.");
                else Console.WriteLine("EnviarEmails nao esta a 1 no PontePHC.ini: nada e enviado.");
                return 0;
            }
            if (cmd == "/estrutura" && args.Length >= 2)
            {
                PhcSql sql = m.Fonte as PhcSql;
                if (sql == null) { Console.WriteLine("So funciona com o SQL do PHC."); return 1; }
                foreach (string v in sql.Estrutura(int.Parse(args[1]))) Console.WriteLine(v);
                Console.WriteLine("Nada foi alterado.");
                return 0;
            }
            if (cmd == "/verificar-pedido")
            {
                m.Preparar();
                if (m.HaPedidoSincronizar()) { m.CicloCompleto(); m.ConcluirPedido(); Console.WriteLine("Pedido de sincronizacao atendido."); }
                else Console.WriteLine("Sem pedido de sincronizacao.");
                return 0;
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
                Console.WriteLine("  PontePHC.exe /series            series de faturas e dossiers (para SeriesFaturas/SeriesDossiers)");
                Console.WriteLine("  PontePHC.exe /dossier SERIE [N]  mostra um dossier completo (o ultimo, ou o numero N)");
                Console.WriteLine("  PontePHC.exe /campos SERIE      que campos de texto estao preenchidos numa serie (ex.: 114)");
                Console.WriteLine("  PontePHC.exe /artigo REF        ficha do artigo, stock por armazem e quantidades em dossiers");
                Console.WriteLine("  PontePHC.exe /armazens          armazens e stock de cada um");
                Console.WriteLine("  PontePHC.exe /procurar TEXTO    artigos com TEXTO na referencia ou designacao, e stock por armazem");
                Console.WriteLine("  PontePHC.exe /guias             como sao usadas as Guias 111 (estado, origem, armazens, viaturas)");
                Console.WriteLine("  PontePHC.exe /guias-abertas     linhas das Guias 111 abertas (levado e ja passado para FO)");
                Console.WriteLine("  PontePHC.exe /emails            emails da plataforma (pendentes, com erro, enviados) e envia os pendentes");
                Console.WriteLine("  PontePHC.exe /estrutura SERIE   colunas, gatilhos e ultimos documentos de uma serie (preparacao da Fase 5)");
                Console.WriteLine("  PontePHC.exe /valores COLUNA    valores mais frequentes de uma coluna dos clientes (ex.: tipo)");
                Console.WriteLine("  PontePHC.exe /valores bo.COLUNA SERIE   idem para dossiers (ex.: bo.tabela1 114)");
                Console.WriteLine("  PontePHC.exe /testar-firebase   testa a ligacao ao Firebase e a chave; nada e enviado");
                Console.WriteLine("  PontePHC.exe /testar-email DESTINO  envia um email de teste pelo Exchange");
                Console.WriteLine("  PontePHC.exe /sincronizar       faz uma sincronizacao agora");
                Console.WriteLine("  PontePHC.exe /recomecar         volta a enviar todos os clientes na proxima vez");
                Console.WriteLine("  PontePHC.exe /senha SqlSenha    grava a senha do SQL, cifrada (ou SmtpSenha)");
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
