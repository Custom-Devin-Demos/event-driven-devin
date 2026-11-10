namespace PibaPassport.Core;

/// <summary>Raised when the tariff engine cannot price a request.</summary>
public sealed class FeeScheduleException : Exception
{
    public const string ErrorCode = "PIBA-FEE-4221";
    public const string ErrorType = "FeeScheduleError.serviceNotInSchedule";

    public FeeScheduleException(string serviceCode, AgeBand ageBand, FeeRate feeRate)
        : base($"No fee schedule entry for service {serviceCode} (fee schedule {FeeRules.FeeScheduleVersion}, {ageBand.Wire()}, {feeRate.Wire()})")
    {
        ServiceCode = serviceCode;
        AgeBand = ageBand;
        FeeRate = feeRate;
    }

    public string ServiceCode { get; }
    public AgeBand AgeBand { get; }
    public FeeRate FeeRate { get; }
}

/// <summary>
/// Fee rules shared with the web replica (app/public/verticals/b09e76ca.html, FEE_RULES block)
/// and the iOS app (event-driven-ios PibaPassportCore/FeeRules.swift).
/// </summary>
public static class FeeRules
{
    public const string FeeScheduleVersion = "2026-01-01";

    private sealed record Rates(int Office, int OnlineSummer, int OnlineWinter)
    {
        public int For(FeeRate rate) => rate == FeeRate.OnlineWinter ? OnlineWinter : OnlineSummer;
    }

    /// <summary>Service catalogue (2026): the tariff code each request is billed under.</summary>
    public static readonly IReadOnlyDictionary<RequestReason, string> PassportServiceCatalog = new Dictionary<RequestReason, string>
    {
        [RequestReason.First] = "PASSPORT_FIRST",
        [RequestReason.Renewal] = "PASSPORT_BIOMETRIC_RENEWAL",
        [RequestReason.Lost] = "PASSPORT_LOST",
    };

    /// <summary>Fee schedule effective 1.1.2026, in shekels, per tariff code and age band.</summary>
    private static readonly IReadOnlyDictionary<string, IReadOnlyDictionary<AgeBand, Rates>> FeeSchedule2026 =
        new Dictionary<string, IReadOnlyDictionary<AgeBand, Rates>>
        {
            ["PASSPORT_FIRST"] = new Dictionary<AgeBand, Rates>
            {
                [AgeBand.Adult] = new(315, 290, 185),
                [AgeBand.Minor] = new(165, 145, 110),
            },
            ["PASSPORT_RENEWAL"] = new Dictionary<AgeBand, Rates>
            {
                [AgeBand.Adult] = new(315, 290, 185),
                [AgeBand.Minor] = new(165, 145, 110),
            },
            ["PASSPORT_LOST"] = new Dictionary<AgeBand, Rates>
            {
                [AgeBand.Adult] = new(645, 620, 515),
                [AgeBand.Minor] = new(330, 310, 275),
            },
        };

    /// <summary>Online winter rate: 1 November to the last day of February.</summary>
    public static FeeRate OnlineRateFor(DateTime date) =>
        date.Month >= 11 || date.Month <= 2 ? FeeRate.OnlineWinter : FeeRate.OnlineSummer;

    /// <summary>Public price list shown before payment (gov.il fees page: first and renewal share one row).</summary>
    public static int PublicFee(RequestReason reason, AgeBand ageBand, DateTime date)
    {
        var lost = reason == RequestReason.Lost;
        var winter = OnlineRateFor(date) == FeeRate.OnlineWinter;
        return (lost, ageBand, winter) switch
        {
            (false, AgeBand.Adult, true) => 185,
            (false, AgeBand.Adult, false) => 290,
            (false, AgeBand.Minor, true) => 110,
            (false, AgeBand.Minor, false) => 145,
            (true, AgeBand.Adult, true) => 515,
            (true, AgeBand.Adult, false) => 620,
            (true, AgeBand.Minor, true) => 275,
            _ => 310,
        };
    }

    /// <summary>Prices the request with the tariff engine and returns the payment order charged to the card.</summary>
    public static PaymentOrder BuildPaymentOrder(PassportRequest request, DateTime paidAt)
    {
        var serviceCode = PassportServiceCatalog[request.Reason];
        var rate = OnlineRateFor(paidAt);
        if (!FeeSchedule2026.TryGetValue(serviceCode, out var schedule))
        {
            throw new FeeScheduleException(serviceCode, request.AgeBand, rate);
        }
        return new PaymentOrder(serviceCode, FeeScheduleVersion, request.AgeBand, rate, schedule[request.AgeBand].For(rate));
    }
}
