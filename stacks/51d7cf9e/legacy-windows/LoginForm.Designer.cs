using System.Drawing;
using System.Windows.Forms;

namespace EimRf
{
    public partial class LoginForm
    {
        private Label MarkLabel;
        private Label TitleLabel;
        private Label DisclaimerLabel;
        private Label UserLabel;
        private Label PlantLabel;
        private Label DeviceLabel;
        private TextBox UserText;
        private TextBox PlantText;
        private TextBox DeviceText;

        private void InitializeComponent()
        {
            MarkLabel = new Label { Text = "TF", BorderStyle = BorderStyle.FixedSingle, Font = new Font("Microsoft Sans Serif", 17F, FontStyle.Bold), TextAlign = ContentAlignment.MiddleCenter, Location = new Point(24, 58), Size = new Size(56, 48) };
            TitleLabel = new Label { Text = "EIM RF", Font = new Font("Microsoft Sans Serif", 19F, FontStyle.Bold), Location = new Point(92, 62), Size = new Size(180, 40) };
            UserLabel = new Label { Text = "User ID", Location = new Point(26, 142), Size = new Size(130, 27) };
            UserText = new TextBox { Location = new Point(166, 140), Size = new Size(278, 30), Font = new Font("Microsoft Sans Serif", 14F) };
            PlantLabel = new Label { Text = "Plant", Location = new Point(26, 194), Size = new Size(130, 27) };
            PlantText = new TextBox { Location = new Point(166, 192), Size = new Size(278, 30), Font = new Font("Microsoft Sans Serif", 14F) };
            DeviceLabel = new Label { Text = "Device ID", Location = new Point(26, 246), Size = new Size(130, 27) };
            DeviceText = new TextBox { Location = new Point(166, 244), Size = new Size(278, 30), Font = new Font("Microsoft Sans Serif", 14F) };
            DisclaimerLabel = new Label { Text = "NOT A TYSON FOODS SYSTEM — internal demo", Location = new Point(25, 343), Size = new Size(430, 28), Font = new Font("Microsoft Sans Serif", 10F), TextAlign = ContentAlignment.MiddleCenter };
            Controls.Add(MarkLabel);
            Controls.Add(TitleLabel);
            Controls.Add(UserLabel);
            Controls.Add(UserText);
            Controls.Add(PlantLabel);
            Controls.Add(PlantText);
            Controls.Add(DeviceLabel);
            Controls.Add(DeviceText);
            Controls.Add(DisclaimerLabel);
        }
    }
}
