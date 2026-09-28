using System.Globalization;
using System.Text.Json.Nodes;

namespace SapMock;

public class AbapException(string key, string message) : Exception(message)
{
    public string Key { get; } = key;
}

public record RfcContext(SapState S, Session Session, JsonObject Imports, JsonObject Tables)
{
    public string Str(string name) => (Imports[name]?.ToString() ?? "").Trim().ToUpperInvariant();
    public decimal Dec(string name, JsonObject? src = null) =>
        decimal.TryParse((src ?? Imports)[name]?.ToString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var d) ? d : 0m;
    public JsonObject Struct(string name) => Imports[name] as JsonObject ?? new JsonObject();
    public IEnumerable<JsonObject> Table(string name) => (Tables[name] as JsonArray ?? new JsonArray()).OfType<JsonObject>();
}

public class RfcResult
{
    public JsonObject Exports { get; } = new();
    public JsonObject Tables { get; } = new();
    public string? ExceptionKey { get; private init; }
    public string? Message { get; private init; }

    public static RfcResult Exception(string key, string message) => new() { ExceptionKey = key, Message = message };

    public RfcResult Ret(string type, string id, string number, string message)
    {
        var row = new JsonObject { ["TYPE"] = type, ["ID"] = id, ["NUMBER"] = number, ["MESSAGE"] = message };
        if (Tables["RETURN"] is JsonArray a) a.Add(row);
        else Tables["RETURN"] = new JsonArray(row);
        return this;
    }

    public JsonObject ToJson() => ExceptionKey is null
        ? new JsonObject { ["exports"] = Exports.DeepClone(), ["tables"] = Tables.DeepClone() }
        : new JsonObject { ["exception"] = ExceptionKey, ["message"] = Message };
}

public static class Rfc
{
    public static readonly Dictionary<string, Func<RfcContext, RfcResult>> Handlers = new()
    {
        ["BAPI_USER_GET_DETAIL"] = UserGetDetail,
        ["Z_EIM_GET_PLANT_PARAMS"] = GetPlantParams,
        ["BAPI_MATERIAL_GET_DETAIL"] = MaterialGetDetail,
        ["Z_EIM_GET_PALLET"] = GetPallet,
        ["Z_EIM_VALIDATE_BIN"] = ValidateBin,
        ["BAPI_GOODSMVT_CREATE"] = GoodsMovementCreate,
        ["L_TO_CREATE_SINGLE"] = TransferOrderCreate,
        ["BAPI_HU_CREATE"] = HuCreate,
        ["Z_EIM_ADD_CASE_TO_PALLET"] = AddCaseToPallet,
        ["Z_EIM_CLOSE_PALLET"] = ClosePallet,
        ["Z_EIM_PRINT_PALLET_LABEL"] = PrintPalletLabel,
        ["BAPI_TRANSACTION_COMMIT"] = Commit,
        ["BAPI_TRANSACTION_ROLLBACK"] = Rollback,
    };

    static RfcResult UserGetDetail(RfcContext c)
    {
        var r = new RfcResult();
        var user = c.Str("USERNAME");
        if (!c.S.Users.Contains(user)) return r.Ret("E", "01", "124", $"User {user} does not exist");
        r.Exports["ADDRESS"] = new JsonObject { ["FULLNAME"] = $"RF Operator {user}", ["DEPARTMENT"] = "WAREHOUSE" };
        r.Exports["LOGONDATA"] = new JsonObject { ["USTYP"] = "A", ["CLASS"] = "EIM_RF" };
        return r;
    }

    static RfcResult GetPlantParams(RfcContext c)
    {
        var werks = c.Str("IV_WERKS");
        if (!c.S.Plants.TryGetValue(werks, out var p)) throw new AbapException("PLANT_NOT_FOUND", $"Plant {werks} is not defined");
        var r = new RfcResult();
        r.Exports["ES_PLANT"] = new JsonObject { ["WERKS"] = p.Werks, ["NAME1"] = p.Name, ["LGNUM"] = p.Lgnum };
        r.Tables["ET_LGORT"] = new JsonArray(c.S.Slocs.Where(s => s.Werks == werks)
            .Select(s => (JsonNode)new JsonObject { ["LGORT"] = s.Lgort, ["LGOBE"] = s.Description, ["LGTYP"] = s.Lgtyp, ["STAGE_BIN"] = s.StagingBin }).ToArray());
        return r;
    }

    static RfcResult MaterialGetDetail(RfcContext c)
    {
        var r = new RfcResult();
        var matnr = c.Str("MATERIAL");
        if (!c.S.Materials.TryGetValue(matnr, out var m))
        {
            r.Exports["RETURN"] = new JsonObject { ["TYPE"] = "E", ["ID"] = "M3", ["NUMBER"] = "305", ["MESSAGE"] = $"Material {matnr} does not exist" };
            return r;
        }
        r.Exports["MATERIAL_GENERAL_DATA"] = new JsonObject
        {
            ["MATL_DESC"] = m.Description, ["MATL_TYPE"] = m.MatlType, ["MATL_GROUP"] = m.MatlGroup, ["BASE_UOM"] = m.BaseUom,
            ["NET_WEIGHT"] = m.NetWeightLb, ["UNIT_OF_WT"] = "LB", ["STOR_CONDS"] = m.StorCond
        };
        r.Exports["RETURN"] = new JsonObject { ["TYPE"] = "S", ["ID"] = "", ["NUMBER"] = "000", ["MESSAGE"] = "" };
        return r;
    }

    static Pallet FindPallet(RfcContext c, string exidv)
    {
        if (!SapState.ValidSscc(exidv)) throw new AbapException("INVALID_SSCC", $"Handling unit {exidv} is not a valid SSCC");
        return c.S.Pallets.TryGetValue(exidv, out var p) ? p : throw new AbapException("NOT_FOUND", $"Handling unit {exidv} does not exist");
    }

    static JsonObject Header(Pallet p) => new()
    {
        ["EXIDV"] = p.Exidv, ["WERKS"] = p.Werks, ["LGNUM"] = p.Lgnum, ["LGORT"] = p.Lgort, ["LGTYP"] = p.Lgtyp, ["LGPLA"] = p.Lgpla,
        ["STATUS"] = p.Status, ["CASE_COUNT"] = p.Items.Sum(i => i.Uom == "CS" ? i.Qty : 0), ["ERNAM"] = p.CreatedBy,
        ["ERDAT"] = p.CreatedOn.ToString("yyyyMMdd")
    };

    static RfcResult GetPallet(RfcContext c)
    {
        var p = FindPallet(c, c.Str("IV_EXIDV"));
        var r = new RfcResult();
        r.Exports["ES_HEADER"] = Header(p);
        r.Tables["ET_ITEMS"] = new JsonArray(p.Items.GroupBy(i => (i.Matnr, i.Charg, i.Uom)).Select((g, n) => (JsonNode)new JsonObject
        {
            ["POSNR"] = ((n + 1) * 10).ToString("D6"), ["MATNR"] = g.Key.Matnr, ["CHARG"] = g.Key.Charg, ["VEMNG"] = g.Sum(i => i.Qty), ["VEMEH"] = g.Key.Uom
        }).ToArray());
        return r;
    }

    static RfcResult ValidateBin(RfcContext c)
    {
        var lgnum = c.Str("IV_LGNUM");
        var lgpla = c.Str("IV_LGPLA");
        var b = c.S.FindBin(lgnum, lgpla) ?? throw new AbapException("BIN_NOT_FOUND", $"Storage bin {lgnum} {lgpla} does not exist");
        var count = c.S.PalletsInBin(b);
        if (c.Str("IV_PUTAWAY") == "X")
        {
            if (b.Blocked) throw new AbapException("BIN_BLOCKED", $"Storage bin {lgpla} is blocked for putaway");
            if (count >= b.MaxPallets) throw new AbapException("BIN_FULL", $"Storage bin {lgpla} is full ({count}/{b.MaxPallets} SU)");
        }
        var sl = c.S.Sloc(b.Werks, b.Lgort);
        var r = new RfcResult();
        r.Exports["ES_BIN"] = new JsonObject
        {
            ["LGNUM"] = b.Lgnum, ["LGTYP"] = b.Lgtyp, ["LTYPT"] = sl.TypeText, ["LGPLA"] = b.Lgpla, ["WERKS"] = b.Werks, ["LGORT"] = b.Lgort,
            ["LGOBE"] = sl.Description, ["SKZUE"] = b.Blocked ? "X" : "", ["MAXLE"] = b.MaxPallets, ["ANZLE"] = count
        };
        return r;
    }

    static RfcResult GoodsMovementCreate(RfcContext c)
    {
        var r = new RfcResult();
        var code = c.Struct("GOODSMVT_CODE")["GM_CODE"]?.ToString();
        if (code != "04") return r.Ret("E", "M7", "895", $"GM code {code} is not supported for transfer postings");
        var items = c.Table("GOODSMVT_ITEM").ToList();
        if (items.Count == 0) return r.Ret("E", "M7", "064", "No items transferred");
        foreach (var i in items)
        {
            var matnr = i["MATERIAL"]?.ToString() ?? "";
            if (!c.S.Materials.ContainsKey(matnr)) return r.Ret("E", "M7", "001", $"Material {matnr} does not exist");
            if (i["MOVE_TYPE"]?.ToString() != "311") return r.Ret("E", "M7", "021", "Movement type must be 311 for RF transfers");
            if (!c.S.Slocs.Any(s => s.Werks == i["PLANT"]?.ToString() && s.Lgort == i["MOVE_STLOC"]?.ToString()))
                return r.Ret("E", "M7", "026", $"Receiving storage location {i["MOVE_STLOC"]} does not exist");
            if (c.Dec("ENTRY_QNT", i) <= 0) return r.Ret("E", "M7", "064", "Enter a quantity");
        }
        var doc = (c.S.NextMatDoc++).ToString();
        c.Session.Pending.Add(() => c.S.MaterialDocuments.Add($"{doc}/{DateTime.Now:yyyy} 311 {items.Count} item(s) by {c.Session.User}"));
        r.Exports["MATERIALDOCUMENT"] = doc;
        r.Exports["MATDOCUMENTYEAR"] = DateTime.Now.Year.ToString();
        return r.Ret("S", "MIGO", "012", $"Material document {doc} posted");
    }

    static RfcResult TransferOrderCreate(RfcContext c)
    {
        var lgnum = c.Str("I_LGNUM");
        var p = FindPallet(c, c.Str("I_VLENR"));
        if (p.Lgnum != lgnum || p.Lgpla != c.Str("I_VLPLA"))
            throw new AbapException("SU_NOT_IN_SOURCE_BIN", $"Storage unit {p.Exidv} is not in bin {c.Str("I_VLPLA")}");
        if (p.Status != "CLOSED") throw new AbapException("SU_NOT_CLOSED", $"Storage unit {p.Exidv} is still open for packing");
        var dest = c.S.FindBin(lgnum, c.Str("I_NLPLA")) ?? throw new AbapException("BIN_NOT_FOUND", $"Storage bin {lgnum} {c.Str("I_NLPLA")} does not exist");
        if (dest.Lgtyp != c.Str("I_NLTYP")) throw new AbapException("WRONG_STORAGE_TYPE", $"Bin {dest.Lgpla} is not in storage type {c.Str("I_NLTYP")}");
        if (dest.Blocked) throw new AbapException("BIN_BLOCKED", $"Storage bin {dest.Lgpla} is blocked for putaway");
        foreach (var i in p.Items) RequireStorCond(c, i.Matnr, dest.Lgtyp);
        void RequireSpace()
        {
            var count = c.S.PalletsInBin(dest);
            if (p.Lgpla != dest.Lgpla && count >= dest.MaxPallets)
                throw new AbapException("BIN_FULL", $"Storage bin {dest.Lgpla} is full ({count}/{dest.MaxPallets} SU)");
        }
        RequireSpace();
        c.Session.Checks.Add(RequireSpace);
        var tanum = (c.S.NextTo++).ToString("D10");
        c.Session.Pending.Add(() =>
        {
            p.Lgpla = dest.Lgpla; p.Lgtyp = dest.Lgtyp; p.Lgort = dest.Lgort;
            c.S.TransferOrders.Add($"{tanum} {p.Exidv} -> {dest.Lgpla} by {c.Session.User}");
        });
        var r = new RfcResult();
        r.Exports["E_TANUM"] = tanum;
        return r;
    }

    static RfcResult HuCreate(RfcContext c)
    {
        var r = new RfcResult();
        var h = c.Struct("HEADERPROPOSAL");
        var exidv = h["HU_EXID"]?.ToString() ?? "";
        if (!SapState.ValidSscc(exidv)) return r.Ret("E", "HUGENERAL", "052", $"External HU identification {exidv} is not a valid SSCC");
        if (c.S.Pallets.ContainsKey(exidv)) return r.Ret("E", "HUGENERAL", "051", $"Handling unit {exidv} already exists");
        var werks = h["PLANT"]?.ToString() ?? "";
        var sl = c.S.Slocs.FirstOrDefault(s => s.Werks == werks && s.Lgort == h["STGE_LOC"]?.ToString());
        if (sl is null) return r.Ret("E", "HUGENERAL", "070", $"Storage location {h["STGE_LOC"]} not defined in plant {werks}");
        var pallet = new Pallet { Exidv = exidv, Werks = werks, Lgnum = c.S.Plants[werks].Lgnum, Lgort = sl.Lgort, Lgtyp = sl.Lgtyp, Lgpla = sl.StagingBin, Status = "OPEN", CreatedBy = c.Session.User, CreatedOn = DateTime.Today };
        c.Session.Pending.Add(() => c.S.Pallets[exidv] = pallet);
        r.Exports["HUKEY"] = exidv;
        r.Exports["HUHEADER"] = Header(pallet);
        return r.Ret("S", "HUGENERAL", "001", $"Handling unit {exidv} created");
    }

    static RfcResult AddCaseToPallet(RfcContext c)
    {
        var p = FindPallet(c, c.Str("IV_EXIDV"));
        if (p.Status != "OPEN") throw new AbapException("PALLET_CLOSED", $"Pallet {p.Exidv} is closed");
        var bc = c.Str("IV_CASE_BARCODE");
        var cs = c.S.Cases.GetValueOrDefault(bc) ?? throw new AbapException("CASE_NOT_FOUND", $"Case label {bc} not found in production records");
        if (c.S.Pallets.Values.Any(x => x.Items.Any(i => i.CaseBarcode == bc)))
            throw new AbapException("CASE_ALREADY_PACKED", $"Case {bc} is already packed on a pallet");
        var m = c.S.Materials[cs.Matnr];
        RequireStorCond(c, cs.Matnr, p.Lgtyp);
        c.Session.Pending.Add(() => p.Items.Add(new PalletItem { Matnr = cs.Matnr, Charg = cs.Charg, Qty = cs.Qty, Uom = m.BaseUom, CaseBarcode = bc }));
        var r = new RfcResult();
        r.Exports["ES_CASE"] = new JsonObject { ["MATNR"] = cs.Matnr, ["MAKTX"] = m.Description, ["CHARG"] = cs.Charg, ["MENGE"] = cs.Qty, ["MEINS"] = m.BaseUom };
        r.Exports["EV_CASE_COUNT"] = p.Items.Sum(i => i.Qty) + cs.Qty;
        return r;
    }

    static RfcResult ClosePallet(RfcContext c)
    {
        var p = FindPallet(c, c.Str("IV_EXIDV"));
        if (p.Status != "OPEN") throw new AbapException("ALREADY_CLOSED", $"Pallet {p.Exidv} is already closed");
        if (p.Items.Count == 0) throw new AbapException("PALLET_EMPTY", $"Pallet {p.Exidv} has no cases");
        c.Session.Pending.Add(() => p.Status = "CLOSED");
        var r = new RfcResult();
        r.Exports["EV_CASE_COUNT"] = p.Items.Sum(i => i.Qty);
        return r;
    }

    static RfcResult PrintPalletLabel(RfcContext c)
    {
        var p = FindPallet(c, c.Str("IV_EXIDV"));
        var r = new RfcResult();
        r.Exports["EV_SPOOLID"] = (31000 + c.S.Pallets.Count + c.S.TransferOrders.Count).ToString();
        r.Exports["EV_PRINTER"] = string.IsNullOrEmpty(c.Str("IV_PADEST")) ? "LBL1" : c.Str("IV_PADEST");
        r.Exports["EV_TEXT"] = $"SSCC {p.Exidv} {p.Items.Sum(i => i.Qty)} CS";
        return r;
    }

    static void RequireStorCond(RfcContext c, string matnr, string lgtyp)
    {
        var cond = c.S.Materials[matnr].StorCond;
        var allowed = cond switch
        {
            "FZ" => lgtyp is "300" or "910",
            "CH" => lgtyp is "200" or "910",
            "RW" => lgtyp is "100" or "200",
            _ => true
        };
        if (!allowed)
            throw new AbapException("STOR_COND", $"Material {matnr} ({cond}) not allowed in storage type {lgtyp}");
    }

    static RfcResult Commit(RfcContext c)
    {
        try { foreach (var check in c.Session.Checks) check(); }
        catch (AbapException)
        {
            c.Session.Pending.Clear();
            c.Session.Checks.Clear();
            throw;
        }
        c.Session.Checks.Clear();
        foreach (var a in c.Session.Pending) a();
        var n = c.Session.Pending.Count;
        c.Session.Pending.Clear();
        var r = new RfcResult();
        r.Exports["RETURN"] = new JsonObject { ["TYPE"] = "", ["ID"] = "", ["NUMBER"] = "000", ["MESSAGE"] = $"{n} update(s) committed" };
        return r;
    }

    static RfcResult Rollback(RfcContext c)
    {
        c.Session.Pending.Clear();
        c.Session.Checks.Clear();
        var r = new RfcResult();
        r.Exports["RETURN"] = new JsonObject { ["TYPE"] = "", ["ID"] = "", ["NUMBER"] = "000", ["MESSAGE"] = "" };
        return r;
    }
}
