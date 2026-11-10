namespace PibaPassport.Core;

public enum DocumentType { Passport }

public enum RequestReason { First, Renewal, Lost }

public enum AgeBand { Adult, Minor }

public enum FeeRate { OnlineSummer, OnlineWinter }

public sealed record PassportRequest(DocumentType DocumentType, RequestReason Reason, AgeBand AgeBand);

public sealed record Branch(string Id, string Name, string Address);

public sealed record PaymentOrder(string ServiceCode, string FeeSchedule, AgeBand AgeBand, FeeRate FeeRate, int Amount);

public static class Labels
{
    public static string Wire(this RequestReason reason) => reason switch
    {
        RequestReason.First => "first",
        RequestReason.Renewal => "renewal",
        _ => "lost",
    };

    public static string Wire(this AgeBand band) => band == AgeBand.Adult ? "adult" : "minor";

    public static string Wire(this FeeRate rate) => rate == FeeRate.OnlineWinter ? "online-winter" : "online-summer";

    public static string Hebrew(this RequestReason reason) => reason switch
    {
        RequestReason.First => "דרכון ביומטרי ראשון",
        RequestReason.Renewal => "חידוש דרכון ביומטרי שפג תוקפו",
        _ => "דרכון ביומטרי במקום שאבד, נגנב או הושחת",
    };

    public static string Hebrew(this AgeBand band) => band == AgeBand.Adult ? "מעל גיל 18" : "מתחת לגיל 18";
}

public static class Branches
{
    public static readonly IReadOnlyList<Branch> All = new[]
    {
        new Branch("tlv", "תל אביב-יפו — קריית הממשלה", "דרך מנחם בגין 125"),
        new Branch("jlm", "ירושלים — שלומציון המלכה", "רחוב שלומציון המלכה 1"),
        new Branch("hfa", "חיפה — פל-ים", "שדרות פל-ים 15"),
        new Branch("rlz", "ראשון לציון", "רחוב ישראל גלילי 3"),
        new Branch("bsh", "באר שבע — קריית הממשלה", "שדרות התקווה 4"),
    };

    public static readonly IReadOnlyList<string> Slots = new[] { "08:20", "09:40", "11:00", "12:20", "13:40", "15:00" };

    /// <summary>The next working days (Sunday to Thursday) after <paramref name="from"/>.</summary>
    public static IReadOnlyList<DateOnly> WorkingDays(DateOnly from, int count)
    {
        var days = new List<DateOnly>();
        var day = from;
        while (days.Count < count)
        {
            day = day.AddDays(1);
            if (day.DayOfWeek is not (DayOfWeek.Friday or DayOfWeek.Saturday)) days.Add(day);
        }
        return days;
    }
}
