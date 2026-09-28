using System;
using System.Configuration;
using System.Windows.Forms;
using EimRf.Rfc;

namespace EimRf
{
    public partial class BuildPalletForm : RfForm
    {
        private string _sscc;
        private bool _active;
        private IRfcStructure _header;
        private IRfcTable _items;

        public BuildPalletForm() : base("BUILD PALLET", "F2 SLoc  F4 Close  F3 Back")
        {
            InitializeComponent();
            foreach (StorageLocationInfo sloc in RfSession.Slocs) SlocCombo.Items.Add(sloc.Lgort + " - " + sloc.Lgobe);
            for (int i = 0; i < SlocCombo.Items.Count; i++)
                if (SlocCombo.Items[i].ToString().StartsWith("COOL ", StringComparison.Ordinal)) SlocCombo.SelectedIndex = i;
            if (SlocCombo.SelectedIndex < 0 && SlocCombo.Items.Count > 0) SlocCombo.SelectedIndex = 0;
            PalletText.KeyDown += PalletKeyDown;
            CaseText.KeyDown += CaseKeyDown;
            CaseText.Enabled = false;
            FocusField(PalletText);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            FocusField(PalletText);
        }

        private string SelectedSloc()
        {
            if (SlocCombo.SelectedIndex < 0) return "COOL";
            return SlocCombo.SelectedItem.ToString().Substring(0, 4);
        }

        private string SelectedStageBin()
        {
            foreach (StorageLocationInfo sloc in RfSession.Slocs)
                if (sloc.Lgort == SelectedSloc()) return sloc.StageBin;
            return "";
        }

        private void PalletKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter) { e.Handled = true; e.SuppressKeyPress = true; ScanPallet(); }
        }

        private void CaseKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter) { e.Handled = true; e.SuppressKeyPress = true; ScanCase(); }
        }

        private void ScanPallet()
        {
            string scanned = ScanValue(PalletText);
            _active = false;
            RunStep("BuildPallet", "ScanPallet", delegate
            {
                _sscc = scanned;
                IRfcFunction pallet;
                try { pallet = RfcHelper.GetPallet(_sscc); }
                catch (RfcAbapException ex)
                {
                    if (ex.Key != "NOT_FOUND") throw;
                    RfcHelper.RenameStep("CreatePallet");
                    RfcDestination destination = RfcHelper.GetDestination();
                    RfcSessionManager.BeginContext(destination);
                    try
                    {
                        IRfcFunction create = RfcHelper.CreateFunction(destination, "BAPI_HU_CREATE");
                        IRfcStructure proposal = create.GetStructure("HEADERPROPOSAL");
                        proposal.SetValue("HU_EXID", _sscc);
                        proposal.SetValue("PACK_MAT", "PAL-EUR");
                        proposal.SetValue("PLANT", RfSession.Plant);
                        proposal.SetValue("STGE_LOC", SelectedSloc());
                        create.Invoke(destination);
                        RfcHelper.CheckReturn(create.GetTable("RETURN"));
                        _header = create.GetStructure("HUHEADER");
                        IRfcFunction commit = RfcHelper.CreateFunction(destination, "BAPI_TRANSACTION_COMMIT");
                        commit.SetValue("WAIT", "X");
                        commit.Invoke(destination);
                    }
                    finally { RfcSessionManager.EndContext(destination); }
                    _items = new RfcEmptyTable();
                    ShowSuccess("Pallet created in " + SelectedSloc() + " " + SelectedStageBin());
                    SetPalletDisplay();
                    _active = true;
                    CaseText.Enabled = true;
                    FocusField(CaseText);
                    return;
                }

                _header = pallet.GetStructure("ES_HEADER");
                _items = pallet.GetTable("ET_ITEMS");
                RfcHelper.Require(_header.GetString("STATUS") == "OPEN", "PALLET_CLOSED",
                    "Pallet " + _sscc + " is CLOSED - cannot add cases");
                SetPalletDisplay();
                _active = true;
                CaseText.Enabled = true;
                ClearMessage();
                FocusField(CaseText);
            });
        }

        private void SetPalletDisplay()
        {
            PalletInfoLabel.Text = _sscc + "  " + _header.GetString("STATUS") + "  " +
                _header.GetString("LGORT") + " " + _header.GetString("LGPLA");
            CountLabel.Text = _header.GetInt("CASE_COUNT").ToString() + " CS";
            ItemList.Items.Clear();
            foreach (IRfcStructure row in _items)
                ItemList.Items.Add(row.GetString("MATNR") + "  " + row.GetString("CHARG") + "  " +
                    row.GetDecimal("VEMNG").ToString("0.##") + " " + row.GetString("VEMEH"));
        }

        private void ScanCase()
        {
            if (!_active) { ShowError("Scan an OPEN pallet first"); return; }
            string barcode = ScanValue(CaseText);
            RunStep("BuildPallet", "ScanCase", delegate
            {
                RfcDestination destination = RfcHelper.GetDestination();
                RfcSessionManager.BeginContext(destination);
                try
                {
                    IRfcFunction add = RfcHelper.CreateFunction(destination, "Z_EIM_ADD_CASE_TO_PALLET");
                    add.SetValue("IV_EXIDV", _sscc);
                    add.SetValue("IV_CASE_BARCODE", barcode);
                    add.Invoke(destination);
                    IRfcStructure caseInfo = add.GetStructure("ES_CASE");
                    IRfcFunction commit = RfcHelper.CreateFunction(destination, "BAPI_TRANSACTION_COMMIT");
                    commit.SetValue("WAIT", "X");
                    commit.Invoke(destination);
                    LastCaseLabel.Text = "Last: " + caseInfo.GetString("MATNR") + " " + caseInfo.GetString("MAKTX") +
                        "  " + caseInfo.GetString("CHARG") + "  " + caseInfo.GetDecimal("MENGE").ToString("0.##") +
                        " " + caseInfo.GetString("MEINS");
                }
                finally { RfcSessionManager.EndContext(destination); }

                IRfcFunction pallet = RfcHelper.GetPallet(_sscc);
                _header = pallet.GetStructure("ES_HEADER");
                _items = pallet.GetTable("ET_ITEMS");
                SetPalletDisplay();
                CaseText.Clear();
                FocusField(CaseText);
            });
        }

        private void ClosePallet()
        {
            if (!_active) { ShowError("Scan an OPEN pallet first"); return; }
            RunStep("BuildPallet", "ClosePallet", delegate
            {
                int count;
                RfcDestination destination = RfcHelper.GetDestination();
                RfcSessionManager.BeginContext(destination);
                try
                {
                    IRfcFunction close = RfcHelper.CreateFunction(destination, "Z_EIM_CLOSE_PALLET");
                    close.SetValue("IV_EXIDV", _sscc);
                    close.Invoke(destination);
                    count = close.GetInt("EV_CASE_COUNT");
                    IRfcFunction commit = RfcHelper.CreateFunction(destination, "BAPI_TRANSACTION_COMMIT");
                    commit.SetValue("WAIT", "X");
                    commit.Invoke(destination);
                }
                finally { RfcSessionManager.EndContext(destination); }

                IRfcFunction pallet = RfcHelper.GetPallet(_sscc);
                _header = pallet.GetStructure("ES_HEADER");
                _items = pallet.GetTable("ET_ITEMS");
                RfcHelper.ValidateBin(RfSession.Lgnum, _header.GetString("LGPLA"), false);
                IRfcFunction label = RfcHelper.Invoke("Z_EIM_PRINT_PALLET_LABEL", f =>
                {
                    f.SetValue("IV_EXIDV", _sscc);
                    f.SetValue("IV_PADEST", ConfigurationManager.AppSettings["Label.Printer"]);
                });
                _active = false;
                CaseText.Enabled = false;
                SetPalletDisplay();
                ShowSuccess("Pallet closed: " + count + " CS - label spool " +
                    label.GetString("EV_SPOOLID") + " on " + label.GetString("EV_PRINTER"));
                FocusField(PalletText);
            });
        }

        protected override bool OnFunctionKey(Keys key)
        {
            if (key == Keys.F2)
            {
                if (SlocCombo.Items.Count > 0) SlocCombo.SelectedIndex = (SlocCombo.SelectedIndex + 1) % SlocCombo.Items.Count;
                SlocHintLabel.Text = "Storage location: " + SelectedSloc();
                return true;
            }
            if (key == Keys.F4) { ClosePallet(); return true; }
            if (key == Keys.F3) { CloseToMenu(); return true; }
            return false;
        }
    }

    internal sealed class RfcEmptyTable : IRfcTable
    {
        public int RowCount { get { return 0; } }
        public int CurrentIndex { get { return -1; } }
        public IRfcStructure this[int index] { get { throw new IndexOutOfRangeException(); } }
        public IRfcStructure Append() { throw new NotSupportedException(); }
        public void SetValue(string name, object value) { throw new NotSupportedException(); }
        public System.Collections.Generic.IEnumerator<IRfcStructure> GetEnumerator()
        {
            yield break;
        }
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() { return GetEnumerator(); }
    }
}
