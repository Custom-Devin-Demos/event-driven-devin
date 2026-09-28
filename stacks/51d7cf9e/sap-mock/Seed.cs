namespace SapMock;

public record Plant(string Werks, string Name, string Lgnum);
public record StorageLocation(string Werks, string Lgort, string Description, string Lgtyp, string TypeText, string StagingBin);
public record Material(string Matnr, string Description, string MatlType, string MatlGroup, string BaseUom, decimal NetWeightLb, string StorCond);
public record CaseLabel(string Barcode, string Matnr, string Charg, decimal Qty);

public class Bin
{
    public required string Lgnum { get; init; }
    public required string Lgtyp { get; init; }
    public required string Lgpla { get; init; }
    public required string Lgort { get; init; }
    public required string Werks { get; init; }
    public bool Blocked { get; set; }
    public int MaxPallets { get; init; } = 4;
}

public class PalletItem
{
    public required string Matnr { get; init; }
    public required string Charg { get; init; }
    public decimal Qty { get; set; }
    public string Uom { get; init; } = "CS";
    public string? CaseBarcode { get; init; }
}

public class Pallet
{
    public required string Exidv { get; init; }
    public required string Werks { get; init; }
    public required string Lgnum { get; set; }
    public required string Lgort { get; set; }
    public required string Lgtyp { get; set; }
    public required string Lgpla { get; set; }
    public string Status { get; set; } = "CLOSED";
    public string CreatedBy { get; init; } = "RFOP01";
    public DateTime CreatedOn { get; init; } = DateTime.Today.AddDays(-1);
    public List<PalletItem> Items { get; } = new();
}

public class SapState
{
    public Dictionary<string, Plant> Plants { get; } = new();
    public List<StorageLocation> Slocs { get; } = new();
    public Dictionary<string, Material> Materials { get; } = new();
    public List<Bin> Bins { get; } = new();
    public Dictionary<string, Pallet> Pallets { get; } = new();
    public Dictionary<string, CaseLabel> Cases { get; } = new();
    public HashSet<string> Users { get; } = new() { "RFOP01", "RFOP02", "RFOP03", "RFLEAD1" };
    public List<string> MaterialDocuments { get; } = new();
    public List<string> TransferOrders { get; } = new();
    public long NextMatDoc = 4900012840;
    public long NextTo = 20417;

    public Bin? FindBin(string lgnum, string lgpla) => Bins.FirstOrDefault(b => b.Lgnum == lgnum && b.Lgpla == lgpla);
    public int PalletsInBin(Bin b) => Pallets.Values.Count(p => p.Lgnum == b.Lgnum && p.Lgpla == b.Lgpla);
    public StorageLocation Sloc(string werks, string lgort) => Slocs.First(s => s.Werks == werks && s.Lgort == lgort);

    public static SapState Create()
    {
        var s = new SapState();
        s.Plants["1010"] = new Plant("1010", "Riverbend Protein Plant", "101");
        s.Plants["1020"] = new Plant("1020", "Cedar Hollow Further Processing", "102");

        foreach (var w in new[] { "1010", "1020" })
        {
            s.Slocs.Add(new StorageLocation(w, "RAW1", "Raw Material", "100", "Raw receiving", "R-STAGE"));
            s.Slocs.Add(new StorageLocation(w, "COOL", "Cooler", "200", "Cooler 34F", "C-STAGE"));
            s.Slocs.Add(new StorageLocation(w, "FRZR", "Freezer", "300", "Blast/holding freezer -10F", "F-STAGE"));
            s.Slocs.Add(new StorageLocation(w, "SHIP", "Shipping Dock", "910", "Shipping dock doors", "D-STAGE"));
        }

        void AddBins(string werks, string lgort, int max, params string[] names)
        {
            var sl = s.Sloc(werks, lgort);
            foreach (var n in names)
                s.Bins.Add(new Bin { Werks = werks, Lgnum = s.Plants[werks].Lgnum, Lgort = lgort, Lgtyp = sl.Lgtyp, Lgpla = n, MaxPallets = n.EndsWith("STAGE") ? 20 : max });
        }
        AddBins("1010", "RAW1", 4, "R-01-01", "R-01-02", "R-STAGE");
        AddBins("1010", "COOL", 4, "C-01-01", "C-01-02", "C-01-03", "C-02-01", "C-02-02", "C-STAGE");
        AddBins("1010", "FRZR", 4, "F-01-01", "F-01-02", "F-02-01", "F-STAGE");
        AddBins("1010", "FRZR", 1, "F-02-02");
        AddBins("1010", "SHIP", 6, "D-DOOR-01", "D-DOOR-02", "D-DOOR-03", "D-STAGE");
        AddBins("1020", "COOL", 4, "C-01-01", "C-STAGE");
        AddBins("1020", "FRZR", 4, "F-01-01", "F-STAGE");
        AddBins("1020", "SHIP", 4, "D-DOOR-01", "D-STAGE");
        s.Bins.First(b => b.Werks == "1010" && b.Lgpla == "C-02-02").Blocked = true;

        foreach (var m in new[]
        {
            new Material("10004512", "CHKN BRST BNLS SKNLS 4X10LB", "FERT", "PLTRY", "CS", 40m, "CH"),
            new Material("10004520", "CHKN WING SEGMENTS IQF 30LB", "FERT", "PLTRY", "CS", 30m, "FZ"),
            new Material("10004533", "CHKN THIGH BNLS SKNLS 40LB", "FERT", "PLTRY", "CS", 40m, "CH"),
            new Material("10004547", "CHKN TENDERLOIN IQF 4X5LB", "FERT", "PLTRY", "CS", 20m, "FZ"),
            new Material("20001105", "BEEF CHUCK ROLL 2PC CH", "FERT", "BEEF", "CS", 62m, "CH"),
            new Material("20001118", "BEEF GRND 80/20 CHUB 8X10LB", "FERT", "BEEF", "CS", 80m, "CH"),
            new Material("20001126", "BEEF BRISKET PKR FZN", "FERT", "BEEF", "CS", 55m, "FZ"),
            new Material("30002210", "PORK LOIN BNLS CC 2PC", "FERT", "PORK", "CS", 38m, "CH"),
            new Material("30002237", "PORK BELLY SKIN-ON FZN", "FERT", "PORK", "CS", 60m, "FZ"),
            new Material("90000014", "CHKN WOG RAW BULK COMBO", "ROH", "RAWPL", "KG", 900m, "RW"),
        }) s.Materials[m.Matnr] = m;

        var serial = 100000001;
        void AddPallet(string werks, string lgort, string lgpla, string status, params (string matnr, string charg, decimal qty)[] items)
        {
            var sl = s.Sloc(werks, lgort);
            var p = new Pallet { Exidv = Sscc(serial++), Werks = werks, Lgnum = s.Plants[werks].Lgnum, Lgort = lgort, Lgtyp = sl.Lgtyp, Lgpla = lgpla, Status = status };
            foreach (var (m, c, q) in items) p.Items.Add(new PalletItem { Matnr = m, Charg = c, Qty = q, Uom = s.Materials[m].BaseUom });
            s.Pallets[p.Exidv] = p;
        }
        AddPallet("1010", "COOL", "C-01-01", "CLOSED", ("10004512", "26268RB01", 40));
        AddPallet("1010", "COOL", "C-01-01", "CLOSED", ("10004533", "26268RB02", 40));
        AddPallet("1010", "COOL", "C-01-02", "CLOSED", ("20001105", "26267RB01", 24), ("20001118", "26267RB03", 12));
        AddPallet("1010", "COOL", "C-01-03", "CLOSED", ("30002210", "26268RB04", 36));
        AddPallet("1010", "COOL", "C-02-01", "CLOSED", ("10004512", "26269RB01", 40));
        AddPallet("1010", "FRZR", "F-01-01", "CLOSED", ("10004520", "26261RB01", 48));
        AddPallet("1010", "FRZR", "F-01-02", "CLOSED", ("20001126", "26259RB02", 20));
        AddPallet("1010", "FRZR", "F-02-02", "CLOSED", ("30002237", "26262RB01", 22));
        AddPallet("1010", "FRZR", "F-02-01", "CLOSED", ("10004547", "26263RB01", 60), ("10004520", "26263RB02", 20));
        AddPallet("1010", "RAW1", "R-01-01", "CLOSED", ("90000014", "26269RW01", 850));
        AddPallet("1010", "SHIP", "D-DOOR-01", "CLOSED", ("10004512", "26266RB01", 40));
        AddPallet("1010", "SHIP", "D-DOOR-02", "CLOSED", ("20001118", "26266RB03", 48));
        AddPallet("1010", "COOL", "C-STAGE", "OPEN", ("10004533", "26269RB02", 6));
        AddPallet("1020", "COOL", "C-01-01", "CLOSED", ("30002210", "26268CH01", 30));
        AddPallet("1020", "FRZR", "F-01-01", "CLOSED", ("10004547", "26264CH01", 50));

        var caseNo = 1;
        foreach (var (m, c, n) in new[] { ("10004512", "26269RB01", 8), ("10004533", "26269RB02", 6), ("20001118", "26268RB03", 6) })
            for (var i = 0; i < n; i++)
            {
                var bc = "0" + m + "0" + c.Substring(0, 5) + (caseNo++).ToString("D5");
                s.Cases[bc] = new CaseLabel(bc, m, c, 1);
            }
        return s;
    }

    public static string Sscc(int serial)
    {
        var body = "0" + "0614141" + serial.ToString("D9");
        return body + CheckDigit(body);
    }

    public static char CheckDigit(string d17)
    {
        var sum = 0;
        for (var i = 0; i < d17.Length; i++) sum += (d17[i] - '0') * ((d17.Length - i) % 2 == 1 ? 3 : 1);
        return (char)('0' + (10 - sum % 10) % 10);
    }

    public static bool ValidSscc(string s) => s.Length == 18 && s.All(char.IsDigit) && CheckDigit(s[..17]) == s[17];
}
