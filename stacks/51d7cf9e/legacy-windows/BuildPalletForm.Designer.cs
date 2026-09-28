using System.Drawing;
using System.Windows.Forms;

namespace EimRf
{
    public partial class BuildPalletForm
    {
        private ComboBox SlocCombo;
        private Label SlocHintLabel;
        private Label PalletLabel;
        private TextBox PalletText;
        private Label PalletInfoLabel;
        private Label CountLabel;
        private Label CaseLabel;
        private TextBox CaseText;
        private Label LastCaseLabel;
        private ListBox ItemList;

        private void InitializeComponent()
        {
            SlocCombo = new ComboBox { Location = new Point(184, 45), Size = new Size(270, 28), DropDownStyle = ComboBoxStyle.DropDownList };
            SlocHintLabel = new Label { Text = "Storage location", Location = new Point(18, 47), Size = new Size(158, 25) };
            PalletLabel = new Label { Text = "Pallet / SSCC", Location = new Point(18, 88), Size = new Size(150, 27) };
            PalletText = new TextBox { Location = new Point(176, 86), Size = new Size(278, 31), Font = new Font("Microsoft Sans Serif", 14F) };
            PalletInfoLabel = new Label { Location = new Point(18, 129), Size = new Size(436, 38), BorderStyle = BorderStyle.FixedSingle, Padding = new Padding(5) };
            CountLabel = new Label { Text = "0 CS", Location = new Point(324, 178), Size = new Size(130, 60), TextAlign = ContentAlignment.MiddleRight, Font = new Font("Microsoft Sans Serif", 22F, FontStyle.Bold) };
            CaseLabel = new Label { Text = "Case label", Location = new Point(18, 195), Size = new Size(150, 27) };
            CaseText = new TextBox { Location = new Point(176, 193), Size = new Size(278, 31), Font = new Font("Microsoft Sans Serif", 14F) };
            LastCaseLabel = new Label { Text = "Last:", Location = new Point(18, 244), Size = new Size(436, 46), Font = new Font("Microsoft Sans Serif", 10F) };
            ItemList = new ListBox { Location = new Point(18, 300), Size = new Size(436, 142), Font = new Font("Courier New", 11F) };
            Controls.Add(SlocCombo);
            Controls.Add(SlocHintLabel);
            Controls.Add(PalletLabel);
            Controls.Add(PalletText);
            Controls.Add(PalletInfoLabel);
            Controls.Add(CountLabel);
            Controls.Add(CaseLabel);
            Controls.Add(CaseText);
            Controls.Add(LastCaseLabel);
            Controls.Add(ItemList);
        }
    }
}
