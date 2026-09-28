using System.Drawing;
using System.Windows.Forms;

namespace EimRf
{
    public partial class MoveInventoryForm
    {
        private Label PalletLabel;
        private TextBox PalletText;
        private Label PalletInfoLabel;
        private Label DestLabel;
        private TextBox DestText;
        private Label DestInfoLabel;

        private void InitializeComponent()
        {
            PalletLabel = new Label { Text = "Pallet / SSCC", Location = new Point(18, 46), Size = new Size(150, 27) };
            PalletText = new TextBox { Location = new Point(176, 44), Size = new Size(285, 31), Font = new Font("Microsoft Sans Serif", 14F) };
            PalletInfoLabel = new Label { Location = new Point(18, 91), Size = new Size(442, 130), BorderStyle = BorderStyle.FixedSingle, Padding = new Padding(5), Font = new Font("Microsoft Sans Serif", 10F) };
            DestLabel = new Label { Text = "Dest bin", Location = new Point(18, 246), Size = new Size(150, 27) };
            DestText = new TextBox { Location = new Point(176, 244), Size = new Size(285, 31), Font = new Font("Microsoft Sans Serif", 14F) };
            DestInfoLabel = new Label { Location = new Point(18, 292), Size = new Size(442, 52), BorderStyle = BorderStyle.FixedSingle, Padding = new Padding(5), Font = new Font("Microsoft Sans Serif", 10F) };
            Controls.Add(PalletLabel);
            Controls.Add(PalletText);
            Controls.Add(PalletInfoLabel);
            Controls.Add(DestLabel);
            Controls.Add(DestText);
            Controls.Add(DestInfoLabel);
        }
    }
}
