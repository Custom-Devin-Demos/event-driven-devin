using System.Drawing;
using System.Windows.Forms;

namespace EimRf
{
    public partial class MainMenuForm
    {
        private Label WelcomeLabel;
        private Label MenuLabel;
        private void InitializeComponent()
        {
            WelcomeLabel = new Label { Location = new Point(26, 56), Size = new Size(430, 65), TextAlign = ContentAlignment.MiddleLeft, Font = new Font("Microsoft Sans Serif", 12F, FontStyle.Bold) };
            MenuLabel = new Label { Location = new Point(34, 161), Size = new Size(420, 190), Font = new Font("Microsoft Sans Serif", 16F, FontStyle.Regular), Text = "1  Move Inventory\r\n\r\n2  Build Pallet\r\n\r\n3  Pallet Inquiry" };
            Controls.Add(WelcomeLabel);
            Controls.Add(MenuLabel);
        }
    }
}
