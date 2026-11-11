using BankMillennium.Core;

namespace BankMillennium.Core.Tests;

public class SignInPoliciesTests
{
    [Theory]
    [InlineData("31570264", "STANDARD", 10)]
    [InlineData("55018342", "PRIVATE_BANKING", 15)]
    public void StandardAndPrivateBankingCustomersSignIn(string millekod, string segment, int minutes)
    {
        var (customer, policy) = SignInPolicies.SignIn(millekod, CustomerDirectory.DemoPassword, "windows");
        Assert.Equal(segment, customer.Segment);
        Assert.Equal(SecondFactor.MobileAuthorization, policy.SecondFactor);
        Assert.Equal(minutes, policy.SessionMinutes);
    }

    // Documents the planted demo defect: the identity service now returns MILLENNIUM_PRESTIGE
    // for the seeded Prestige customer. Replace with a passing regression test when remediating.
    [Fact]
    public void SeededPrestigeCustomerHasNoSignInPolicy()
    {
        var error = Assert.Throws<SignInPolicyException>(
            () => SignInPolicies.SignIn(CustomerDirectory.SeededMillekod, CustomerDirectory.DemoPassword, "windows"));
        Assert.Equal("MILLENNIUM_PRESTIGE", error.Segment);
        Assert.Equal("No sign-in policy for segment MILLENNIUM_PRESTIGE (Millekod 4821****, channel windows)", error.Message);
    }

    [Theory]
    [InlineData("1234", "Demo2026!")]
    [InlineData("4821390a", "Demo2026!")]
    [InlineData("99999999", "Demo2026!")]
    [InlineData("31570264", "")]
    [InlineData("31570264", "wrong-password")]
    public void InvalidCredentialsAreValidationErrors(string millekod, string password)
    {
        Assert.Throws<LoginValidationException>(() => SignInPolicies.SignIn(millekod, password, "windows"));
    }
}
