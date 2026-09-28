using System;
using System.Drawing;
using System.Windows.Forms;

namespace EimRf
{
    public partial class MainMenuForm : RfForm
    {
        public MainMenuForm() : base("MAIN MENU", "1-3 Select  F3 Logoff")
        {
            InitializeComponent();
            WelcomeLabel.Text = RfSession.FullName + "\r\n" + RfSession.Plant + "  " + RfSession.PlantName;
            KeyPress += MenuKeyPress;
        }

        private void MenuKeyPress(object sender, KeyPressEventArgs e)
        {
            if (e.KeyChar == '1') { e.Handled = true; OpenScreen(new MoveInventoryForm()); }
            else if (e.KeyChar == '2') { e.Handled = true; OpenScreen(new BuildPalletForm()); }
            else if (e.KeyChar == '3') { e.Handled = true; OpenScreen(new PalletInquiryForm()); }
        }

        protected override bool OnFunctionKey(Keys key)
        {
            if (key == Keys.F3) { Close(); return true; }
            return false;
        }

        private void OpenScreen(RfForm screen)
        {
            Hide();
            using (screen) screen.ShowDialog();
            Show();
        }
    }
}
