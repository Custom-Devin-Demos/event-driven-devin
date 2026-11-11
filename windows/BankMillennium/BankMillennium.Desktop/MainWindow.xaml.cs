using System.Globalization;
using System.Windows;
using BankMillennium.Core;

namespace BankMillennium.Desktop;

public partial class MainWindow : Window
{
    private const string Channel = "windows";
    private static readonly CultureInfo Pl = CultureInfo.GetCultureInfo("pl-PL");
    private readonly FailureReporter _reporter = FailureReporter.FromEnvironment();

    public MainWindow()
    {
        InitializeComponent();
        PasswordBox.Password = CustomerDirectory.DemoPassword;
        ReportStatus.Text = _reporter.Enabled ? $"Raporty błędów: {_reporter.BaseUrl}" : "Raporty błędów: wyłączone (BM_DISABLE_FAILURE_REPORTS=1)";
    }

    private void ShowError(string message, bool policyFailure)
    {
        ErrorText.Text = message;
        ErrorBanner.Visibility = Visibility.Visible;
        PasswordFrame.BorderThickness = policyFailure ? new Thickness(2) : new Thickness(0);
    }

    private void ClearError()
    {
        ErrorBanner.Visibility = Visibility.Collapsed;
        PasswordFrame.BorderThickness = new Thickness(0);
    }

    private void Next_Click(object sender, RoutedEventArgs e)
    {
        ClearError();
        var millekod = MillekodBox.Text.Trim();
        if (!SignInPolicies.IsValidMillekod(millekod))
        {
            ShowError("Nieprawidłowy Millekod lub hasło.", policyFailure: false);
            return;
        }
        MillekodEcho.Text = $"Millekod: {millekod}";
        StepMillekod.Visibility = Visibility.Collapsed;
        StepPassword.Visibility = Visibility.Visible;
        PasswordBox.Focus();
    }

    private void Back_Click(object sender, RoutedEventArgs e)
    {
        ClearError();
        StepPassword.Visibility = Visibility.Collapsed;
        StepMillekod.Visibility = Visibility.Visible;
    }

    private async void SignIn_Click(object sender, RoutedEventArgs e)
    {
        ClearError();
        try
        {
            var (customer, policy) = SignInPolicies.SignIn(MillekodBox.Text, PasswordBox.Password, Channel);
            StepPassword.Visibility = Visibility.Collapsed;
            StepAuthorize.Visibility = Visibility.Visible;
            AuthorizeDetail.Text = $"Wysłaliśmy powiadomienie do aplikacji Bank Millennium na telefonie klienta {customer.FullName}.";
            await Task.Delay(1500);
            ShowDashboard(customer, policy);
        }
        catch (LoginValidationException error)
        {
            ShowError(error.Message, policyFailure: false);
        }
        catch (SignInPolicyException error)
        {
            ShowError($"Nie możemy Cię teraz zalogować. Spróbuj ponownie później. Kod błędu: {SignInPolicyException.ErrorCode}", policyFailure: true);
            var result = await _reporter.ReportAsync(FailureReport.From(error, DevinIdentity.FromEnvironment()));
            ReportStatus.Text = result.Sent ? $"Zgłoszenie wysłane: {result.Reference}" : $"Zgłoszenie: {result.Status}";
        }
    }

    private void ShowDashboard(Customer customer, SignInPolicy policy)
    {
        LoginView.Visibility = Visibility.Collapsed;
        DashboardView.Visibility = Visibility.Visible;
        StepAuthorize.Visibility = Visibility.Collapsed;
        Greeting.Text = $"Dzień dobry, {customer.FirstName}";
        PolicyLine.Text = $"Zalogowano: {customer.FullName} · sesja {policy.SessionMinutes} min · polityka {SignInPolicies.PolicyVersion}";
        SessionLabel.Text = $"{customer.FullName} · Millekod {customer.MillekodMasked}";
        AccountsList.ItemsSource = Dashboard.AccountsFor(customer)
            .Select(a => new { a.Name, a.Number, BalanceText = a.Balance.ToString("N2", Pl) + " PLN" }).ToList();
        TransactionsList.ItemsSource = Dashboard.Transactions
            .Select(t => new { t.Title, AmountText = (t.Amount > 0 ? "+" : "") + t.Amount.ToString("N2", Pl) + " PLN" }).ToList();
    }

    private void Logout_Click(object sender, RoutedEventArgs e)
    {
        DashboardView.Visibility = Visibility.Collapsed;
        LoginView.Visibility = Visibility.Visible;
        StepPassword.Visibility = Visibility.Collapsed;
        StepMillekod.Visibility = Visibility.Visible;
        SessionLabel.Text = "Millenet — Windows";
        PasswordBox.Password = CustomerDirectory.DemoPassword;
        ClearError();
    }
}
