using System;
using System.Configuration;
using System.Windows.Forms;
using EimRf.Rfc;

namespace EimRf
{
    public partial class LoginForm : RfForm
    {
        private bool _loggedIn;

        public LoginForm() : base("LOGIN", "ENTER Next  F1 Logon")
        {
            InitializeComponent();
            UserText.KeyDown += UserKeyDown;
            PlantText.KeyDown += PlantKeyDown;
            DeviceText.KeyDown += DeviceKeyDown;
            UserText.Text = "";
            PlantText.Text = ConfigurationManager.AppSettings["Default.Plant"];
            DeviceText.Text = ConfigurationManager.AppSettings["Device.Id"];
            FocusField(UserText);
        }

        private void UserKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter) { e.Handled = true; e.SuppressKeyPress = true; FocusField(PlantText); }
        }

        private void PlantKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter) { e.Handled = true; e.SuppressKeyPress = true; FocusField(DeviceText); }
        }

        private void DeviceKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter)
            {
                e.Handled = true;
                e.SuppressKeyPress = true;
                Logon();
            }
        }

        protected override bool OnFunctionKey(Keys key)
        {
            if (key == Keys.F1) { Logon(); return true; }
            return false;
        }

        private void Logon()
        {
            _loggedIn = false;
            string user = ScanValue(UserText);
            string plant = ScanValue(PlantText);
            string device = ScanValue(DeviceText);
            RunStep("Login", "Logon", delegate
            {
                RfcHelper.Require(user.Length > 0, "01/124", "Enter a user ID");
                RfcDestination destination = RfcHelper.GetDestination();
                IRfcFunction detail = destination.Repository.CreateFunction("BAPI_USER_GET_DETAIL");
                detail.SetValue("USERNAME", user);
                detail.Invoke(destination);
                RfcHelper.CheckReturn(detail.GetTable("RETURN"));
                string fullName = detail.GetStructure("ADDRESS").GetString("FULLNAME");

                IRfcFunction parameters = destination.Repository.CreateFunction("Z_EIM_GET_PLANT_PARAMS");
                parameters.SetValue("IV_WERKS", plant);
                parameters.SetValue("IV_DEVICE", device);
                parameters.Invoke(destination);
                IRfcStructure plantData = parameters.GetStructure("ES_PLANT");
                RfSession.User = user;
                RfSession.FullName = fullName;
                RfSession.Plant = plantData.GetString("WERKS");
                RfSession.PlantName = plantData.GetString("NAME1");
                RfSession.Lgnum = plantData.GetString("LGNUM");
                RfSession.Device = device;
                RfSession.Slocs.Clear();
                IRfcTable slocs = parameters.GetTable("ET_LGORT");
                foreach (IRfcStructure row in slocs)
                    RfSession.Slocs.Add(new StorageLocationInfo
                    {
                        Lgort = row.GetString("LGORT"), Lgobe = row.GetString("LGOBE"),
                        Lgtyp = row.GetString("LGTYP"), StageBin = row.GetString("STAGE_BIN")
                    });
                _loggedIn = true;
            });

            if (_loggedIn)
            {
                Hide();
                using (var menu = new MainMenuForm()) menu.ShowDialog();
                Show();
                UserText.Text = "";
                ClearMessage();
                FocusField(UserText);
            }
        }
    }
}
