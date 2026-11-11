namespace BankMillennium.Core;

public enum SecondFactor { MobileAuthorization }

public sealed record SignInPolicy(string Segment, SecondFactor SecondFactor, int SessionMinutes);

public sealed record Customer(string Millekod, string FirstName, string LastName, string Segment)
{
    public string FullName => $"{FirstName} {LastName}";
    public string MillekodMasked => Millekod.Length >= 4 ? $"{Millekod[..4]}****" : "****";
}

/// <summary>Demo customer directory as returned by the identity service (IAM v3).</summary>
public static class CustomerDirectory
{
    public const string SeededMillekod = "48213907";
    public const string DemoPassword = "Demo2026!";

    public static readonly IReadOnlyList<Customer> Customers = new[]
    {
        new Customer("48213907", "Anna", "Kowalska", "MILLENNIUM_PRESTIGE"),
        new Customer("31570264", "Piotr", "Nowak", "STANDARD"),
        new Customer("55018342", "Marta", "Wiśniewska", "PRIVATE_BANKING"),
    };

    public static Customer? Find(string millekod) => Customers.FirstOrDefault(c => c.Millekod == millekod);
}

public sealed class SignInPolicyException : Exception
{
    public const string ErrorType = "SignInPolicyError.segmentNotInPolicy";
    public const string ErrorCode = "MIL-AUTH-4031";

    public SignInPolicyException(string segment, string millekodMasked, string channel)
        : base($"No sign-in policy for segment {segment} (Millekod {millekodMasked}, channel {channel})")
    {
        Segment = segment;
        MillekodMasked = millekodMasked;
        Channel = channel;
    }

    public string Segment { get; }
    public string MillekodMasked { get; }
    public string Channel { get; }
}

public sealed class LoginValidationException : Exception
{
    public LoginValidationException() : base("Nieprawidłowy Millekod lub hasło.") { }
}

/// <summary>Millenet sign-in policies (policy version 2026-10), keyed by customer segment.</summary>
public static class SignInPolicies
{
    public const string PolicyVersion = "2026-10";

    public static readonly IReadOnlyDictionary<string, SignInPolicy> Policies = new Dictionary<string, SignInPolicy>
    {
        ["STANDARD"] = new("STANDARD", SecondFactor.MobileAuthorization, 10),
        ["PRESTIGE"] = new("PRESTIGE", SecondFactor.MobileAuthorization, 15),
        ["PRIVATE_BANKING"] = new("PRIVATE_BANKING", SecondFactor.MobileAuthorization, 15),
    };

    public static SignInPolicy PolicyFor(Customer customer, string channel) =>
        Policies.TryGetValue(customer.Segment, out var policy)
            ? policy
            : throw new SignInPolicyException(customer.Segment, customer.MillekodMasked, channel);

    public static bool IsValidMillekod(string millekod) => millekod.Length == 8 && millekod.All(char.IsAsciiDigit);

    /// <summary>Resolves the customer and the sign-in policy for a Millekod + password login.</summary>
    public static (Customer Customer, SignInPolicy Policy) SignIn(string millekod, string password, string channel)
    {
        millekod = millekod.Trim();
        if (!IsValidMillekod(millekod) || password != CustomerDirectory.DemoPassword) throw new LoginValidationException();
        var customer = CustomerDirectory.Find(millekod) ?? throw new LoginValidationException();
        return (customer, PolicyFor(customer, channel));
    }
}

public sealed record Account(string Name, string Number, decimal Balance);
public sealed record Transaction(string Title, decimal Amount);

public static class Dashboard
{
    public static IReadOnlyList<Account> AccountsFor(Customer customer) => customer.Millekod switch
    {
        "48213907" => new[]
        {
            new Account("Konto 360°", "PL61 1160 2202 0000 0004 8213 9071", 12480.55m),
            new Account("Konto Oszczędnościowe Profit", "PL27 1160 2202 0000 0004 8213 9188", 48900.00m),
        },
        "55018342" => new[]
        {
            new Account("Konto Prestige", "PL83 1160 2202 0000 0005 5018 3421", 86302.17m),
            new Account("Lokata", "PL09 1160 2202 0000 0005 5018 3512", 120000.00m),
        },
        _ => new[] { new Account("Konto 360°", "PL44 1160 2202 0000 0003 1570 2641", 3214.90m) },
    };

    public static readonly IReadOnlyList<Transaction> Transactions = new[]
    {
        new Transaction("Biedronka Warszawa", -86.40m),
        new Transaction("Przelew od: Jan Kowalski", 1200.00m),
        new Transaction("Orlen Stacja 412", -254.13m),
    };
}
