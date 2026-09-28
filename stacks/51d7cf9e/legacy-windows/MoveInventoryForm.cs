using System;
using System.Configuration;
using System.Drawing;
using System.Windows.Forms;
using EimRf.Rfc;

namespace EimRf
{
    public partial class MoveInventoryForm : RfForm
    {
        private string _sscc;
        private string _sourceBin;
        private string _sourceSloc;
        private string _destinationBin;
        private string _document;
        private string _transferOrder;
        private bool _hasPallet;
        private bool _destinationReady;
        private bool _confirmed;
        private IRfcStructure _palletHeader;
        private IRfcStructure _sourceInfo;
        private IRfcStructure _destinationInfo;
        private IRfcTable _items;
        private string _material;
        private string _storageConditions;

        public MoveInventoryForm() : base("MOVE INVENTORY", "F1 Confirm  F4 Post  F3 Back")
        {
            InitializeComponent();
            PalletText.KeyDown += PalletKeyDown;
            DestText.KeyDown += DestKeyDown;
            FocusField(PalletText);
        }

        private void PalletKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter) { e.Handled = true; e.SuppressKeyPress = true; ScanPallet(); }
        }

        private void DestKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter) { e.Handled = true; e.SuppressKeyPress = true; ScanDestination(); }
        }

        private void ScanPallet()
        {
            string scanned = ScanValue(PalletText);
            _hasPallet = false;
            _destinationReady = false;
            _confirmed = false;
            RunStep("MoveInventory", "ScanPallet", delegate
            {
                _sscc = scanned;
                IRfcFunction pallet = RfcHelper.GetPallet(_sscc);
                _palletHeader = pallet.GetStructure("ES_HEADER");
                _items = pallet.GetTable("ET_ITEMS");
                RfcHelper.Require(_palletHeader.GetString("WERKS") == RfSession.Plant, "WRONG_PLANT",
                    "Pallet " + _sscc + " belongs to plant " + _palletHeader.GetString("WERKS"));
                _sourceBin = _palletHeader.GetString("LGPLA");
                _sourceSloc = _palletHeader.GetString("LGORT");
                _material = _items.RowCount > 0 ? _items[0].GetString("MATNR") : "";
                IRfcStructure material = RfcHelper.GetMaterial(_material, RfSession.Plant);
                _storageConditions = material.GetString("STOR_CONDS");
                _sourceInfo = RfcHelper.ValidateBin(RfSession.Lgnum, _sourceBin, false);
                string more = _items.RowCount > 1 ? "  +" + (_items.RowCount - 1) + " more lines" : "";
                string batch = _items.RowCount > 0 ? _items[0].GetString("CHARG") : "";
                string qty = _items.RowCount > 0 ? _items[0].GetDecimal("VEMNG").ToString("0.##") + " " + _items[0].GetString("VEMEH") : "";
                PalletInfoLabel.Text = _sscc + "\r\n" + _material + "  " + material.GetString("MATL_DESC") + "\r\n" +
                    qty + "   Batch " + batch + more + "\r\nSource: " + _sourceSloc + " " + _sourceBin + "  " +
                    _sourceInfo.GetString("LGOBE") + " / " + _sourceInfo.GetString("LTYPT");
                _hasPallet = true;
                ClearMessage();
                FocusField(DestText);
            });
        }

        private void ScanDestination()
        {
            if (!_hasPallet) { ShowError("Scan a pallet first"); return; }
            string bin = ScanValue(DestText);
            _destinationReady = false;
            _confirmed = false;
            _destinationBin = null;
            _destinationInfo = null;
            DestInfoLabel.Text = "";
            RunStep("MoveInventory", "ScanDestBin", delegate
            {
                IRfcStructure info = RfcHelper.ValidateBin(RfSession.Lgnum, bin, true);
                IRfcStructure material = RfcHelper.GetMaterial(_material, RfSession.Plant);
                RfcHelper.Require(bin != _sourceBin, "SAME_BIN", "Destination bin is the same as the source bin");
                string type = info.GetString("LGTYP");
                bool allowed = _storageConditions == "FZ" ? type == "300" || type == "910" :
                    _storageConditions == "CH" ? type == "200" || type == "910" :
                    _storageConditions == "RW" ? type == "100" || type == "200" : true;
                if (!allowed)
                    RfcHelper.Require(false, "STOR_COND", "Material " + _material + " (" + _storageConditions +
                        ") not allowed in storage type " + type + " " + info.GetString("LTYPT"));
                IRfcFunction pallet = RfcHelper.GetPallet(_sscc);
                _palletHeader = pallet.GetStructure("ES_HEADER");
                _items = pallet.GetTable("ET_ITEMS");
                _destinationInfo = info;
                _destinationBin = bin;
                DestInfoLabel.Text = "Dest: " + bin + "  " + info.GetString("LGOBE") +
                    " / " + info.GetString("LTYPT") + "  (" + info.GetString("ANZLE") +
                    "/" + info.GetString("MAXLE") + ")";
                _destinationReady = true;
                ShowSuccess("F1 Confirm");
            });
        }

        private void ConfirmMove()
        {
            if (!_destinationReady) { ShowError("Scan a destination bin first"); return; }
            RunStep("MoveInventory", "Confirm", delegate
            {
                IRfcFunction pallet = RfcHelper.GetPallet(_sscc);
                IRfcStructure current = pallet.GetStructure("ES_HEADER");
                RfcHelper.Require(current.GetString("LGPLA") == _sourceBin, "SU_NOT_IN_SOURCE_BIN",
                    "Pallet " + _sscc + " is no longer in " + _sourceBin);
                RfcHelper.ValidateBin(RfSession.Lgnum, _destinationBin, true);
                _confirmed = true;
                ShowSuccess("Confirmed - F4 to post");
            });
        }

        private void PostMove()
        {
            if (!_confirmed) { ShowError("F1 Confirm first"); return; }
            RunStep("MoveInventory", "Post", delegate
            {
                _document = null;
                _transferOrder = null;
                string warning = "";
                RfcDestination destination = RfcHelper.GetDestination();
                RfcSessionManager.BeginContext(destination);
                try
                {
                    if (_sourceSloc != _destinationInfo.GetString("LGORT"))
                    {
                        IRfcFunction goods = RfcHelper.CreateFunction(destination, "BAPI_GOODSMVT_CREATE");
                        IRfcStructure header = goods.GetStructure("GOODSMVT_HEADER");
                        header.SetValue("PSTNG_DATE", DateTime.Today.ToString("yyyyMMdd"));
                        header.SetValue("DOC_DATE", DateTime.Today.ToString("yyyyMMdd"));
                        header.SetValue("PR_UNAME", RfSession.User);
                        goods.GetStructure("GOODSMVT_CODE").SetValue("GM_CODE", "04");
                        IRfcTable lines = goods.GetTable("GOODSMVT_ITEM");
                        foreach (IRfcStructure item in _items)
                        {
                            IRfcStructure row = lines.Append();
                            row.SetValue("MATERIAL", item.GetString("MATNR"));
                            row.SetValue("PLANT", RfSession.Plant);
                            row.SetValue("STGE_LOC", _sourceSloc);
                            row.SetValue("BATCH", item.GetString("CHARG"));
                            row.SetValue("MOVE_TYPE", "311");
                            row.SetValue("ENTRY_QNT", item.GetDecimal("VEMNG"));
                            row.SetValue("ENTRY_UOM", item.GetString("VEMEH"));
                            row.SetValue("MOVE_STLOC", _destinationInfo.GetString("LGORT"));
                        }
                        goods.Invoke(destination);
                        RfcHelper.CheckReturn(goods.GetTable("RETURN"));
                        _document = goods.GetString("MATERIALDOCUMENT");
                    }
                    IRfcStructure first = _items[0];
                    IRfcFunction transfer = RfcHelper.CreateFunction(destination, "L_TO_CREATE_SINGLE");
                    transfer.SetValue("I_LGNUM", RfSession.Lgnum);
                    transfer.SetValue("I_BWLVS", "999");
                    transfer.SetValue("I_MATNR", first.GetString("MATNR"));
                    transfer.SetValue("I_WERKS", RfSession.Plant);
                    transfer.SetValue("I_LGORT", _sourceSloc);
                    transfer.SetValue("I_CHARG", first.GetString("CHARG"));
                    transfer.SetValue("I_ANFME", first.GetDecimal("VEMNG"));
                    transfer.SetValue("I_ALTME", first.GetString("VEMEH"));
                    transfer.SetValue("I_VLTYP", _palletHeader.GetString("LGTYP"));
                    transfer.SetValue("I_VLPLA", _sourceBin);
                    transfer.SetValue("I_VLENR", _sscc);
                    transfer.SetValue("I_NLTYP", _destinationInfo.GetString("LGTYP"));
                    transfer.SetValue("I_NLPLA", _destinationBin);
                    transfer.SetValue("I_SQUIT", "X");
                    transfer.Invoke(destination);
                    _transferOrder = transfer.GetString("E_TANUM");
                    IRfcFunction commit = RfcHelper.CreateFunction(destination, "BAPI_TRANSACTION_COMMIT");
                    commit.SetValue("WAIT", "X");
                    commit.Invoke(destination);
                    _hasPallet = false;
                    _destinationReady = false;
                    _confirmed = false;

                    try
                    {
                        RfcHelper.GetPallet(_sscc);
                        RfcHelper.ValidateBin(RfSession.Lgnum, _destinationBin, false);
                    }
                    catch (RfcBaseException ex) { warning = "  WARNING: re-read failed - " + ex.Message; }
                }
                finally { RfcSessionManager.EndContext(destination); }

                string document = string.IsNullOrEmpty(_document) ? "" : " / Mat doc " + _document;
                string success = "Posted: TO " + _transferOrder + document + " - pallet now in " +
                    _destinationBin + " (" + _items.RowCount + " line(s))" + warning;
                PalletInfoLabel.Text = "";
                DestInfoLabel.Text = "";
                PalletText.Clear();
                DestText.Clear();
                ShowSuccess(success);
                FocusField(PalletText);
            });
        }

        protected override bool OnFunctionKey(Keys key)
        {
            if (key == Keys.F1) { ConfirmMove(); return true; }
            if (key == Keys.F4) { PostMove(); return true; }
            if (key == Keys.F3) { CloseToMenu(); return true; }
            return false;
        }
    }
}
