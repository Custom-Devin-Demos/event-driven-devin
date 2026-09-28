using System.Drawing;
using System.Windows.Forms;

namespace EimRf
{
    public partial class PalletInquiryForm
    {
        private Label PalletLabel;
        private TextBox PalletText;
        private Label HeaderLabelInfo;
        private ListBox ItemList;

        private void InitializeComponent()
        {
            PalletLabel = new Label { Text = "Pallet / SSCC", Location = new Point(18, 48), Size = new Size(150, 27) };
            PalletText = new TextBox { Location = new Point(176, 46), Size = new Size(285, 31), Font = new Font("Microsoft Sans Serif", 14F) };
            HeaderLabelInfo = new Label { Location = new Point(18, 94), Size = new Size(442, 116), BorderStyle = BorderStyle.FixedSingle, Padding = new Padding(5), Font = new Font("Microsoft Sans Serif", 10F) };
            ItemList = new ListBox { Location = new Point(18, 226), Size = new Size(442, 218), Font = new Font("Courier New", 11F) };
            Controls.Add(PalletLabel);
            Controls.Add(PalletText);
            Controls.Add(HeaderLabelInfo);
            Controls.Add(ItemList);
        }
    }
}
