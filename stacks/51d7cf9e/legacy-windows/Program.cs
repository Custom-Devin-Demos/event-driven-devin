using System;
using System.Configuration;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace EimRf
{
    internal static class Program
    {
        public static bool RdpSimEnabled { get; private set; }

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            RdpSimEnabled = ConfigurationManager.AppSettings["RdpSim.Enabled"] == "true";
            foreach (string arg in args)
                if (string.Equals(arg, "/rdpsim", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(arg, "-rdpsim", StringComparison.OrdinalIgnoreCase))
                    RdpSimEnabled = true;

            if (RdpSimEnabled)
            {
                try
                {
                    string assemblyPath = ResolvePath("RdpSim.AssemblyPath");
                    string profilePath = ResolvePath("Profile.Config");
                    int port = Convert.ToInt32(ConfigurationManager.AppSettings["RdpSim.Port"]);
                    Type host = Assembly.LoadFrom(assemblyPath).GetType("RdpSim.RdpHost", true);
                    host.GetMethod("Start", BindingFlags.Public | BindingFlags.Static)
                        .Invoke(null, new object[] { port, profilePath });
                }
                catch (Exception ex)
                {
                    RdpSimEnabled = false;
                    MessageBox.Show("RdpSim could not start: " + ex.GetBaseException().Message,
                        "EIM RF", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            }
            Application.Run(new LoginForm());
        }

        private static string ResolvePath(string key)
        {
            string value = ConfigurationManager.AppSettings[key];
            return Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, value));
        }
    }
}
