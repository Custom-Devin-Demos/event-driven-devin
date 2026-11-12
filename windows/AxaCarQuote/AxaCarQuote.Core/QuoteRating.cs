using System.Globalization;
using System.Text.RegularExpressions;

namespace AxaCarQuote.Core;

public enum CoverType { Comprehensive, Tpft }

public sealed record Vehicle(string Registration, string Make, string Model, int Year, string FuelType, string Engine, decimal Value, int Group);

public sealed record Driver(string FirstName, string LastName, string DateOfBirth, string Postcode, string Licence, int NcdYears);

public sealed record RatingFactor(string FuelType, decimal Loading, string RepairCentre);

public sealed record Quote(Vehicle Vehicle, CoverType Cover, string RepairCentre, decimal Annual, decimal Plus, decimal Monthly, decimal PlusMonthly, string RatingVersion);

/// <summary>User-input problem shown inline next to the field; never reported.</summary>
public sealed class QuoteValidationException : Exception
{
    public QuoteValidationException(string field, string message) : base(message) => Field = field;
    public string Field { get; }
}

/// <summary>Pricing-engine failure: shown as the red "can't give you a quote" state and reported.</summary>
public sealed class QuoteRatingException : Exception
{
    public const string ErrorType = "QuoteRatingError";
    public const string ErrorKind = "fuelTypeNotRated";
    public const string ErrorCode = "AXA-QTE-4221";

    public QuoteRatingException(string fuelType, string registrationMasked, string coverType)
        : base($"No rating factor for fuel type {fuelType} (vehicle {registrationMasked}, cover {coverType})")
    {
        FuelType = fuelType;
        RegistrationMasked = registrationMasked;
        CoverType = coverType;
    }

    public string FuelType { get; }
    public string RegistrationMasked { get; }
    public string CoverType { get; }
}

/// <summary>AXA car quote rules, kept equivalent to the web (QUOTE_RATING block) and iOS (AxaCarCore) clients.</summary>
public static class QuoteRating
{
    public const string RatingVersion = "2026-11";
    public const decimal PlusUplift = 86m;

    /// <summary>Registration lookup (DVLA-style); FuelType is exactly what the registration feed returns.</summary>
    public static readonly IReadOnlyDictionary<string, Vehicle> Vehicles = new Dictionary<string, Vehicle>
    {
        ["LK24EVX"] = new("LK24 EVX", "TESLA", "MODEL Y LONG RANGE AWD", 2024, "ELECTRICITY", "Dual motor", 46990m, 50),
        ["MA21PTR"] = new("MA21 PTR", "FORD", "FOCUS ST-LINE 1.0 ECOBOOST", 2021, "PETROL", "999cc", 17450m, 18),
        ["YD19DSL"] = new("YD19 DSL", "VOLKSWAGEN", "GOLF 2.0 TDI MATCH", 2019, "DIESEL", "1968cc", 13200m, 20),
    };

    /// <summary>Pricing rating factors by fuel type (rating version 2026-11).</summary>
    public static readonly IReadOnlyDictionary<string, RatingFactor> RatingFactors = new Dictionary<string, RatingFactor>
    {
        ["PETROL"] = new("PETROL", 1.00m, "STANDARD"),
        ["DIESEL"] = new("DIESEL", 1.04m, "STANDARD"),
        ["HYBRID"] = new("HYBRID", 1.08m, "STANDARD"),
        ["ELECTRIC"] = new("ELECTRIC", 1.18m, "EV_APPROVED"),
    };

    private static readonly IReadOnlyDictionary<CoverType, decimal> CoverBase = new Dictionary<CoverType, decimal>
    {
        [CoverType.Comprehensive] = 486m,
        [CoverType.Tpft] = 412m,
    };

    private static readonly decimal[] NcdDiscount = { 0m, 0.25m, 0.35m, 0.45m, 0.55m, 0.6m, 0.62m, 0.65m, 0.67m, 0.7m };

    public static string CoverCode(CoverType cover) => cover == CoverType.Tpft ? "TPFT" : "COMPREHENSIVE";

    public static string NormalizeRegistration(string? registration) =>
        Regex.Replace((registration ?? "").ToUpperInvariant(), "[^A-Z0-9]", "");

    public static string MaskRegistration(string registration)
    {
        var r = NormalizeRegistration(registration);
        return (r.Length > 4 ? r[..4] : r) + " ***";
    }

    public static Vehicle LookupVehicle(string? registration)
    {
        var key = NormalizeRegistration(registration);
        if (key.Length == 0) throw new QuoteValidationException("registration", "Enter your car registration");
        if (!Regex.IsMatch(key, "^[A-Z]{2}[0-9]{2}[A-Z]{3}$"))
            throw new QuoteValidationException("registration", "Enter a valid UK registration, like AB12 CDE");
        if (!Vehicles.TryGetValue(key, out var vehicle))
            throw new QuoteValidationException("registration", "We couldn't find a car with that registration");
        return vehicle;
    }

    public static void ValidateDriver(Driver driver)
    {
        if (string.IsNullOrWhiteSpace(driver.FirstName) || string.IsNullOrWhiteSpace(driver.LastName))
            throw new QuoteValidationException("name", "Enter the main driver's name");
        if (!Regex.IsMatch(driver.DateOfBirth ?? "", @"^\d{2}/\d{2}/\d{4}$"))
            throw new QuoteValidationException("dob", "Enter date of birth as DD/MM/YYYY");
        if (!DateTime.TryParseExact(driver.DateOfBirth, "dd/MM/yyyy", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var dob)
            || dob.Year < 1900 || dob > DateTime.UtcNow.Date)
            throw new QuoteValidationException("dob", "Enter a real date of birth");
        if (!Regex.IsMatch(driver.Postcode ?? "", "^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$", RegexOptions.IgnoreCase))
            throw new QuoteValidationException("postcode", "Enter a valid UK postcode");
    }

    public static RatingFactor RatingFactorFor(Vehicle vehicle, CoverType cover)
    {
        if (!RatingFactors.TryGetValue(vehicle.FuelType, out var factor))
            throw new QuoteRatingException(vehicle.FuelType, MaskRegistration(vehicle.Registration), CoverCode(cover));
        return factor;
    }

    public static Quote Calculate(string registration, Driver driver, CoverType cover)
    {
        var vehicle = LookupVehicle(registration);
        ValidateDriver(driver);
        var factor = RatingFactorFor(vehicle, cover);
        var ncd = Math.Clamp(driver.NcdYears, 0, 9);
        var annual = Round(CoverBase[cover] * factor.Loading * (1 + vehicle.Group / 100m) * (1 - NcdDiscount[ncd]));
        var plus = Round(annual + PlusUplift);
        return new Quote(vehicle, cover, factor.RepairCentre, annual, plus, Round(annual / 12), Round(plus / 12), RatingVersion);
    }

    public static string Money(decimal amount) => amount.ToString("C2", CultureInfo.GetCultureInfo("en-GB"));

    private static decimal Round(decimal value) => Math.Round(value, 2, MidpointRounding.AwayFromZero);
}
