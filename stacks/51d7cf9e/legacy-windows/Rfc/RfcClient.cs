// Minimal SAP .NET Connector-compatible client that carries RFC calls over HTTP/JSON to the ECC RFC gateway.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Configuration;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

namespace EimRf.Rfc
{
    public abstract class RfcBaseException : Exception
    {
        protected RfcBaseException(string message, Exception inner = null) : base(message, inner) { }
    }

    public sealed class RfcCommunicationException : RfcBaseException
    {
        public RfcCommunicationException(string message, Exception inner = null) : base(message, inner) { }
    }

    public sealed class RfcLogonException : RfcBaseException
    {
        public RfcLogonException(string message, Exception inner = null) : base(message, inner) { }
    }

    public sealed class RfcAbapException : RfcBaseException
    {
        public string Key { get; private set; }
        public RfcAbapException(string key, string message) : base(message) { Key = key; }
    }

    public sealed class RfcDestination
    {
        internal readonly string Url;
        internal readonly string User;
        internal readonly string Client;
        public string Name { get; private set; }
        public RfcRepository Repository { get; private set; }

        internal RfcDestination(string name, string url, string user, string client)
        {
            Name = name;
            Url = url.TrimEnd('/');
            User = user;
            Client = client;
            Repository = new RfcRepository();
        }
    }

    public sealed class RfcDestinationManager
    {
        public static RfcDestination GetDestination(string name)
        {
            return new RfcDestination(name,
                ConfigurationManager.AppSettings["SapMock.Url"],
                ConfigurationManager.AppSettings["Rfc.User"],
                ConfigurationManager.AppSettings["Rfc.Client"]);
        }
    }

    public sealed class RfcRepository
    {
        public IRfcFunction CreateFunction(string name) { return new RfcFunction(name); }
    }

    public interface IRfcFunction
    {
        void SetValue(string name, object value);
        string GetString(string name);
        int GetInt(string name);
        decimal GetDecimal(string name);
        IRfcStructure GetStructure(string name);
        IRfcTable GetTable(string name);
        void Invoke(RfcDestination destination);
    }

    public interface IRfcStructure
    {
        void SetValue(string name, object value);
        string GetString(string name);
        int GetInt(string name);
        decimal GetDecimal(string name);
    }

    public interface IRfcTable : IEnumerable<IRfcStructure>
    {
        IRfcStructure Append();
        void SetValue(string name, object value);
        int RowCount { get; }
        int CurrentIndex { get; }
        IRfcStructure this[int index] { get; }
    }

    internal sealed class RfcStructure : IRfcStructure
    {
        internal readonly Dictionary<string, object> Values;
        internal RfcStructure(Dictionary<string, object> values) { Values = values; }
        public void SetValue(string name, object value) { Values[name] = value; }
        public string GetString(string name) { return Convert.ToString(Values.ContainsKey(name) ? Values[name] : null, CultureInfo.InvariantCulture) ?? ""; }
        public int GetInt(string name) { return Convert.ToInt32(Values.ContainsKey(name) ? Values[name] : 0, CultureInfo.InvariantCulture); }
        public decimal GetDecimal(string name) { return Convert.ToDecimal(Values.ContainsKey(name) ? Values[name] : 0, CultureInfo.InvariantCulture); }
    }

    internal sealed class RfcTable : IRfcTable
    {
        private readonly List<Dictionary<string, object>> _rows;
        public int CurrentIndex { get; private set; } = -1;
        public int RowCount { get { return _rows.Count; } }
        internal RfcTable(List<Dictionary<string, object>> rows) { _rows = rows; }
        public IRfcStructure Append()
        {
            var row = new Dictionary<string, object>();
            _rows.Add(row);
            CurrentIndex = _rows.Count - 1;
            return new RfcStructure(row);
        }
        public void SetValue(string name, object value)
        {
            if (CurrentIndex < 0) throw new InvalidOperationException("Append a table row first.");
            _rows[CurrentIndex][name] = value;
        }
        public IRfcStructure this[int index] { get { return new RfcStructure(_rows[index]); } }
        public IEnumerator<IRfcStructure> GetEnumerator()
        {
            foreach (var row in _rows) yield return new RfcStructure(row);
        }
        IEnumerator IEnumerable.GetEnumerator() { return GetEnumerator(); }
    }

    public sealed class RfcFunction : IRfcFunction
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();
        private readonly string _name;
        private readonly Dictionary<string, object> _imports = new Dictionary<string, object>();
        private readonly Dictionary<string, List<Dictionary<string, object>>> _inTables =
            new Dictionary<string, List<Dictionary<string, object>>>();
        private Dictionary<string, object> _exports = new Dictionary<string, object>();
        private Dictionary<string, object> _tables = new Dictionary<string, object>();

        static RfcFunction()
        {
            ServicePointManager.Expect100Continue = false;
            ServicePointManager.UseNagleAlgorithm = false;
        }

        internal RfcFunction(string name) { _name = name; }
        public void SetValue(string name, object value) { _imports[name] = value; }
        public string GetString(string name) { return Convert.ToString(GetValue(name), CultureInfo.InvariantCulture) ?? ""; }
        public int GetInt(string name) { return Convert.ToInt32(GetValue(name) ?? 0, CultureInfo.InvariantCulture); }
        public decimal GetDecimal(string name) { return Convert.ToDecimal(GetValue(name) ?? 0, CultureInfo.InvariantCulture); }

        private object GetValue(string name)
        {
            if (_exports.ContainsKey(name)) return _exports[name];
            return _imports.ContainsKey(name) ? _imports[name] : null;
        }

        public IRfcStructure GetStructure(string name)
        {
            if (_exports.ContainsKey(name))
            {
                var output = AsDictionary(_exports[name]);
                _exports[name] = output;
                return new RfcStructure(output);
            }
            if (!_imports.ContainsKey(name)) _imports[name] = new Dictionary<string, object>();
            var input = _imports[name] as Dictionary<string, object>;
            if (input == null) throw new InvalidOperationException(name + " is not a structure.");
            return new RfcStructure(input);
        }

        public IRfcTable GetTable(string name)
        {
            var output = _tables.ContainsKey(name) ? AsRows(_tables[name]) : null;
            if (output != null)
            {
                _tables[name] = output;
                return new RfcTable(output);
            }
            if (!_inTables.ContainsKey(name)) _inTables[name] = new List<Dictionary<string, object>>();
            return new RfcTable(_inTables[name]);
        }

        public void Invoke(RfcDestination destination)
        {
            RfcSessionManager.Context context = RfcSessionManager.Find(destination);
            string session = null;
            bool ownSession = context == null;
            try
            {
                if (ownSession)
                    session = Logon(destination);
                else
                    session = context.GetSession(destination);
                RfcTrace.Calls++;
                var request = new Dictionary<string, object>
                {
                    { "sessionId", session }, { "function", _name }, { "imports", _imports }, { "tables", _inTables }
                };
                var response = Post(destination, "/rfc/call", request, false);
                if (response.ContainsKey("exception"))
                    throw new RfcAbapException(Convert.ToString(response["exception"], CultureInfo.InvariantCulture),
                        Convert.ToString(response["message"], CultureInfo.InvariantCulture));
                _exports = response.ContainsKey("exports") ? AsDictionary(response["exports"]) : new Dictionary<string, object>();
                _tables = response.ContainsKey("tables") ? AsDictionary(response["tables"]) : new Dictionary<string, object>();
            }
            finally
            {
                if (ownSession && session != null) Logoff(destination, session);
            }
        }

        private static string Logon(RfcDestination destination)
        {
            try
            {
                var response = Post(destination, "/rfc/logon",
                    new Dictionary<string, object> { { "user", destination.User }, { "client", destination.Client } }, true);
                RfcTrace.Logons++;
                return Convert.ToString(response["sessionId"], CultureInfo.InvariantCulture);
            }
            catch (RfcLogonException) { throw; }
            catch (RfcBaseException ex) { throw new RfcLogonException(ex.Message, ex); }
        }

        private static void Logoff(RfcDestination destination, string session)
        {
            try { Post(destination, "/rfc/logoff", new Dictionary<string, object> { { "sessionId", session } }, false); }
            catch (RfcBaseException) { }
        }

        internal static Dictionary<string, object> Post(RfcDestination destination, string path,
            Dictionary<string, object> data, bool logon)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(destination.Url + path);
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Proxy = null;
                request.Timeout = 30000;
                request.Headers["X-EIM-Txn"] = RfcTrace.CurrentTxn;
                byte[] bytes = Encoding.UTF8.GetBytes(Serializer.Serialize(data));
                request.ContentLength = bytes.Length;
                using (Stream stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                    return NormalizeDictionary(Serializer.DeserializeObject(reader.ReadToEnd()));
            }
            catch (WebException ex)
            {
                string message = ex.Message;
                string key = "RFC_COMMUNICATION_FAILURE";
                var response = ex.Response as HttpWebResponse;
                if (response != null)
                {
                    key = response.StatusCode == HttpStatusCode.NotFound ? "FU_NOT_FOUND" : "RFC_COMMUNICATION_FAILURE";
                    try
                    {
                        using (var reader = new StreamReader(response.GetResponseStream()))
                        {
                            var body = Serializer.DeserializeObject(reader.ReadToEnd()) as Dictionary<string, object>;
                            if (body != null && body.ContainsKey("message")) message = Convert.ToString(body["message"], CultureInfo.InvariantCulture);
                        }
                    }
                    catch { }
                    if (response.StatusCode == HttpStatusCode.Unauthorized) key = "RFC_INVALID_HANDLE";
                    response.Close();
                }
                if (logon) throw new RfcLogonException(message, ex);
                throw new RfcCommunicationException(key + ": " + message, ex);
            }
            catch (RfcBaseException) { throw; }
            catch (Exception ex) { throw new RfcCommunicationException("RFC_COMMUNICATION_FAILURE: " + ex.Message, ex); }
        }

        private static Dictionary<string, object> NormalizeDictionary(object value)
        {
            var source = value as Dictionary<string, object>;
            var result = new Dictionary<string, object>();
            if (source != null)
                foreach (var pair in source) result[pair.Key] = Normalize(pair.Value);
            return result;
        }

        private static object Normalize(object value)
        {
            var dict = value as Dictionary<string, object>;
            if (dict != null) return NormalizeDictionary(dict);
            var array = value as ArrayList;
            if (array != null) return array.ToArray();
            return value;
        }

        private static Dictionary<string, object> AsDictionary(object value)
        {
            var dict = value as Dictionary<string, object>;
            if (dict != null) return dict;
            return new Dictionary<string, object>();
        }

        private static List<Dictionary<string, object>> AsRows(object value)
        {
            var rows = value as object[];
            var result = new List<Dictionary<string, object>>();
            if (rows != null)
                foreach (object row in rows) result.Add(AsDictionary(row));
            return result;
        }

        internal static string OpenSession(RfcDestination destination)
        {
            var response = Post(destination, "/rfc/logon",
                new Dictionary<string, object> { { "user", destination.User }, { "client", destination.Client } }, true);
            RfcTrace.Logons++;
            return Convert.ToString(response["sessionId"], CultureInfo.InvariantCulture);
        }

        internal static void CloseSession(RfcDestination destination, string session)
        {
            try { Post(destination, "/rfc/logoff", new Dictionary<string, object> { { "sessionId", session } }, false); }
            catch (RfcBaseException) { }
        }
    }

    public static class RfcTrace
    {
        public static string CurrentTxn { get; set; } = "";
        public static int Logons { get; set; }
        public static int Calls { get; set; }
    }

    public static class RfcSessionManager
    {
        internal sealed class Context
        {
            private string _session;
            internal string GetSession(RfcDestination destination)
            {
                if (_session == null) _session = RfcFunction.OpenSession(destination);
                return _session;
            }
            internal string SessionId { get { return _session; } }
        }

        private static readonly Dictionary<RfcDestination, Context> Contexts = new Dictionary<RfcDestination, Context>();
        public static void BeginContext(RfcDestination destination)
        {
            lock (Contexts)
            {
                if (Contexts.ContainsKey(destination)) throw new InvalidOperationException("RFC context already active.");
                Contexts[destination] = new Context();
            }
        }
        internal static Context Find(RfcDestination destination)
        {
            lock (Contexts) { Context context; return Contexts.TryGetValue(destination, out context) ? context : null; }
        }
        public static void EndContext(RfcDestination destination)
        {
            Context context;
            lock (Contexts)
            {
                if (!Contexts.TryGetValue(destination, out context)) return;
                Contexts.Remove(destination);
            }
            if (context.SessionId != null) RfcFunction.CloseSession(destination, context.SessionId);
        }
    }
}
