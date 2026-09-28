using System;
using System.Windows.Forms;
using EimRf.Rfc;

namespace EimRf
{
    public partial class PalletInquiryForm : RfForm
    {
        public PalletInquiryForm() : base("PALLET INQUIRY", "ENTER Display  F3 Back")
        {
            InitializeComponent();
            PalletText.KeyDown += PalletKeyDown;
            FocusField(PalletText);
        }

        private void PalletKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter) { e.Handled = true; e.SuppressKeyPress = true; ScanPallet(); }
        }

        private void ScanPallet()
        {
            string sscc = ScanValue(PalletText);
            RunStep("PalletInquiry", "ScanPallet", delegate
            {
                IRfcFunction pallet = RfcHelper.GetPallet(sscc);
                IRfcStructure header = pallet.GetStructure("ES_HEADER");
                IRfcTable items = pallet.GetTable("ET_ITEMS");
                IRfcStructure bin = RfcHelper.ValidateBin(header.GetString("LGNUM"), header.GetString("LGPLA"), false);
                HeaderLabelInfo.Text = "SSCC " + sscc + "  " + header.GetString("STATUS") + "\r\nPlant " +
                    header.GetString("WERKS") + "  " + header.GetString("LGORT") + "  " + header.GetString("LGPLA") +
                    "  " + bin.GetString("LGOBE") + " / " + bin.GetString("LTYPT") + "\r\nCases " +
                    header.GetString("CASE_COUNT") + "  Created " + header.GetString("ERNAM") + " / " +
                    header.GetString("ERDAT") + "\r\nBin " + bin.GetString("ANZLE") + "/" + bin.GetString("MAXLE") + " SU";
                ItemList.Items.Clear();
                foreach (IRfcStructure item in items)
                {
                    IRfcStructure material = RfcHelper.GetMaterial(item.GetString("MATNR"), header.GetString("WERKS"));
                    ItemList.Items.Add(item.GetString("POSNR") + " " + item.GetString("MATNR") + " " +
                        item.GetString("CHARG") + " " + item.GetDecimal("VEMNG").ToString("0.##") + " " +
                        item.GetString("VEMEH"));
                    ItemList.Items.Add("     " + material.GetString("MATL_DESC"));
                }
                ClearMessage();
                FocusField(PalletText);
            });
        }

        protected override bool OnFunctionKey(Keys key)
        {
            if (key == Keys.F3) { CloseToMenu(); return true; }
            return false;
        }
    }
}
