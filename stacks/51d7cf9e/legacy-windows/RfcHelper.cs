using System;
using System.Configuration;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using EimRf.Rfc;

namespace EimRf
{
    public sealed class BapiReturnException : Exception
    {
        public string Id { get; private set; }
        public string Number { get; private set; }
        public BapiReturnException(string id, string number, string message) : base(message)
        {
            Id = id;
            Number = number;
        }
    }

    internal sealed class WorkflowException : Exception
    {
        public string Key { get; private set; }
        public WorkflowException(string key, string message) : base(message) { Key = key; }
    }

    public sealed class StorageLocationInfo
    {
        public string Lgort;
        public string Lgobe;
        public string Lgtyp;
        public string StageBin;
    }

    public static class RfSession
    {
        public static string User = "";
        public static string FullName = "";
        public static string Plant = "";
        public static string PlantName = "";
        public static string Lgnum = "";
        public static string Device = "";
        public static readonly System.Collections.Generic.List<StorageLocationInfo> Slocs =
            new System.Collections.Generic.List<StorageLocationInfo>();
    }

    public static class RfcHelper
    {
        private static Stopwatch _watch;
        private static string _workflow;
        private static string _step;

        public static void BeginStep(string workflow, string step)
        {
            _workflow = workflow;
            _step = step;
            RfcTrace.CurrentTxn = workflow + "/" + step;
            RfcTrace.Logons = 0;
            RfcTrace.Calls = 0;
            _watch = Stopwatch.StartNew();
        }

        public static void RenameStep(string step)
        {
            _step = step;
            RfcTrace.CurrentTxn = _workflow + "/" + step;
        }

        public static long EndStep(string result)
        {
            _watch.Stop();
            string path = ConfigurationManager.AppSettings["Timings.Path"];
            path = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, path));
            string directory = Path.GetDirectoryName(path);
            if (!Directory.Exists(directory)) Directory.CreateDirectory(directory);
            bool header = !File.Exists(path);
            using (var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                if (header) writer.WriteLine("timestamp,workflow,step,ms,logons,calls,result");
                writer.WriteLine(DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss.fff", CultureInfo.InvariantCulture) + "," +
                    _workflow + "," + _step + "," + _watch.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture) + "," +
                    RfcTrace.Logons + "," + RfcTrace.Calls + "," + result);
            }
            return _watch.ElapsedMilliseconds;
        }

        public static RfcDestination GetDestination()
        {
            return RfcDestinationManager.GetDestination(ConfigurationManager.AppSettings["Rfc.Destination"]);
        }

        public static IRfcFunction CreateFunction(RfcDestination destination, string name)
        {
            return destination.Repository.CreateFunction(name);
        }

        public static IRfcFunction GetPallet(string sscc)
        {
            RfcDestination destination = GetDestination();
            IRfcFunction function = CreateFunction(destination, "Z_EIM_GET_PALLET");
            function.SetValue("IV_EXIDV", sscc);
            function.Invoke(destination);
            return function;
        }

        public static IRfcStructure ValidateBin(string lgnum, string lgpla, bool putaway)
        {
            RfcDestination destination = GetDestination();
            IRfcFunction function = CreateFunction(destination, "Z_EIM_VALIDATE_BIN");
            function.SetValue("IV_LGNUM", lgnum);
            function.SetValue("IV_LGPLA", lgpla);
            function.SetValue("IV_PUTAWAY", putaway ? "X" : "");
            function.Invoke(destination);
            return function.GetStructure("ES_BIN");
        }

        public static IRfcStructure GetMaterial(string matnr, string plant)
        {
            RfcDestination destination = GetDestination();
            IRfcFunction function = CreateFunction(destination, "BAPI_MATERIAL_GET_DETAIL");
            function.SetValue("MATERIAL", matnr);
            function.SetValue("PLANT", plant);
            function.Invoke(destination);
            IRfcStructure result = function.GetStructure("RETURN");
            CheckReturn(result);
            return function.GetStructure("MATERIAL_GENERAL_DATA");
        }

        public static void CheckReturn(IRfcStructure result)
        {
            string type = result.GetString("TYPE");
            if (type == "E" || type == "A")
                throw new BapiReturnException(result.GetString("ID"), result.GetString("NUMBER"), result.GetString("MESSAGE"));
        }

        public static void CheckReturn(IRfcTable result)
        {
            foreach (IRfcStructure row in result)
            {
                string type = row.GetString("TYPE");
                if (type == "E" || type == "A")
                    throw new BapiReturnException(row.GetString("ID"), row.GetString("NUMBER"), row.GetString("MESSAGE"));
            }
        }

        public static IRfcFunction Invoke(string name, Action<IRfcFunction> prepare)
        {
            RfcDestination destination = GetDestination();
            IRfcFunction function = CreateFunction(destination, name);
            prepare(function);
            function.Invoke(destination);
            return function;
        }

        public static void Require(bool condition, string key, string message)
        {
            if (!condition) throw new WorkflowException(key, message);
        }
    }
}
