using System.Windows;
using AxaCarQuote.Core;

namespace AxaCarQuote.Desktop;

public partial class MainWindow : Window
{
    private readonly FailureReporter _reporter = FailureReporter.FromEnvironment();
    private Vehicle? _vehicle;

    public MainWindow()
    {
        InitializeComponent();
        ReportStatus.Text = _reporter.Enabled ? $"Failure reports: {_reporter.BaseUrl}" : "Failure reports: off (AXA_DISABLE_FAILURE_REPORTS=1)";
    }

    private void Show(UIElement view)
    {
        foreach (var v in new UIElement[] { HomeView, ComprehensiveView, QuoteView }) v.Visibility = v == view ? Visibility.Visible : Visibility.Collapsed;
        CarMenu.Visibility = Visibility.Collapsed;
        TopNav.Visibility = view == QuoteView ? Visibility.Collapsed : Visibility.Visible;
    }

    private void ShowStep(int step)
    {
        var steps = new[] { Step1, Step2, Step3, Step4 };
        for (var i = 0; i < steps.Length; i++) steps[i].Visibility = i + 1 == step ? Visibility.Visible : Visibility.Collapsed;
        var names = new[] { "1. Your car", "2. About you", "3. Your cover", "4. Your quote" };
        StepIndicator.Text = string.Join("  ›  ", names.Select((n, i) => i + 1 == step ? n.ToUpperInvariant() : n));
    }

    private static void Inline(System.Windows.Controls.TextBlock target, string? message)
    {
        target.Text = message ?? "";
        target.Visibility = string.IsNullOrEmpty(message) ? Visibility.Collapsed : Visibility.Visible;
    }

    private void Home_Click(object sender, RoutedEventArgs e) => Show(HomeView);
    private void Car_Click(object sender, RoutedEventArgs e) =>
        CarMenu.Visibility = CarMenu.Visibility == Visibility.Visible ? Visibility.Collapsed : Visibility.Visible;
    private void Comprehensive_Click(object sender, RoutedEventArgs e) => Show(ComprehensiveView);

    private void Quote_Click(object sender, RoutedEventArgs e)
    {
        Show(QuoteView);
        ShowStep(1);
    }

    private bool FindCar()
    {
        Inline(RegError, null);
        try
        {
            _vehicle = QuoteRating.LookupVehicle(RegBox.Text);
            VehicleText.Text = $"{_vehicle.Make} {_vehicle.Model}\nRegistration: {_vehicle.Registration}   Year: {_vehicle.Year}\nFuel: {_vehicle.FuelType}   Engine: {_vehicle.Engine}";
            VehicleCard.Visibility = Visibility.Visible;
            SummaryCar.Text = $"{_vehicle.Registration} · {_vehicle.Make} {_vehicle.Model}";
            return true;
        }
        catch (QuoteValidationException ex)
        {
            _vehicle = null;
            VehicleCard.Visibility = Visibility.Collapsed;
            SummaryCar.Text = "Not found yet";
            Inline(RegError, ex.Message);
            return false;
        }
    }

    private void FindCar_Click(object sender, RoutedEventArgs e) => FindCar();
    private void ToStep1_Click(object sender, RoutedEventArgs e) => ShowStep(1);

    private void ToStep2_Click(object sender, RoutedEventArgs e)
    {
        if (FindCar()) ShowStep(2);
    }

    private Driver CurrentDriver() => new(FirstNameBox.Text.Trim(), LastNameBox.Text.Trim(), DobBox.Text.Trim(), PostcodeBox.Text.Trim(), "FULL_UK", NcdBox.SelectedIndex);

    private void ToStep3_Click(object sender, RoutedEventArgs e)
    {
        Inline(DriverError, null);
        try
        {
            QuoteRating.ValidateDriver(CurrentDriver());
        }
        catch (QuoteValidationException ex)
        {
            Inline(DriverError, ex.Message);
            return;
        }
        SummaryDriver.Text = $"{FirstNameBox.Text} {LastNameBox.Text}, {PostcodeBox.Text.ToUpperInvariant()}";
        ShowStep(3);
    }

    private async void GetQuote_Click(object sender, RoutedEventArgs e)
    {
        ShowStep(4);
        QuoteErrorBanner.Visibility = Visibility.Collapsed;
        QuoteResult.Visibility = Visibility.Collapsed;
        var cover = CoverTpft.IsChecked == true ? CoverType.Tpft : CoverType.Comprehensive;
        try
        {
            var quote = QuoteRating.Calculate(RegBox.Text, CurrentDriver(), cover);
            QuoteTitle.Text = $"Your quote, {FirstNameBox.Text}";
            QuoteSub.Text = $"{quote.Vehicle.Registration} · {quote.Vehicle.Make} {quote.Vehicle.Model} · {(cover == CoverType.Tpft ? "Third party, fire and theft" : "Comprehensive")}";
            PriceStd.Text = QuoteRating.Money(quote.Annual);
            MonthlyStd.Text = $"or {QuoteRating.Money(quote.Monthly)} a month";
            PricePlus.Text = QuoteRating.Money(quote.Plus);
            MonthlyPlus.Text = $"or {QuoteRating.Money(quote.PlusMonthly)} a month";
            QuoteResult.Visibility = Visibility.Visible;
        }
        catch (QuoteValidationException ex)
        {
            if (ex.Field == "registration") { ShowStep(1); Inline(RegError, ex.Message); }
            else { ShowStep(2); Inline(DriverError, ex.Message); }
        }
        catch (QuoteRatingException ex)
        {
            QuoteErrorRef.Text = $"Error {QuoteRatingException.ErrorCode} · {DateTime.UtcNow:yyyy-MM-dd HH:mm:ss} UTC";
            QuoteErrorBanner.Visibility = Visibility.Visible;
            await _reporter.ReportAsync(FailureReport.From(ex, DevinIdentity.FromEnvironment()));
        }
    }
}
