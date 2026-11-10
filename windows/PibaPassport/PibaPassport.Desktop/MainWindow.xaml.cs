using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using PibaPassport.Core;

namespace PibaPassport.Desktop;

public partial class MainWindow : Window
{
    private static readonly CultureInfo Hebrew = new("he-IL");
    private readonly FailureReporter _reporter = FailureReporter.FromEnvironment();
    private RequestReason? _reason;
    private AgeBand? _ageBand;
    private Branch? _branch;
    private DateOnly? _date;
    private string? _slot;

    public MainWindow()
    {
        InitializeComponent();
        Show(ScreenInfo, 1);
    }

    private void Show(FrameworkElement screen, int step, bool failed = false)
    {
        foreach (var s in new FrameworkElement[] { ScreenInfo, ScreenLogin, ScreenBranch, ScreenPay, ScreenDone })
        {
            s.Visibility = s == screen ? Visibility.Visible : Visibility.Collapsed;
        }
        var steps = new[] { Step1, Step2, Step3, Step4 };
        for (var i = 0; i < steps.Length; i++)
        {
            var n = i + 1;
            var isFailed = failed && n == step;
            steps[i].FontWeight = n == step ? FontWeights.Bold : FontWeights.Normal;
            steps[i].Foreground = isFailed ? (Brush)FindResource("Red") : n == step ? (Brush)FindResource("Gov") : n < step ? (Brush)FindResource("Ok") : (Brush)FindResource("Soft");
            steps[i].Background = isFailed ? (Brush)FindResource("RedSoft") : n == step ? (Brush)FindResource("GovSoft") : Brushes.Transparent;
        }
    }

    private static void Pick(Panel panel, ToggleButton selected)
    {
        foreach (var toggle in panel.Children.OfType<ToggleButton>()) toggle.IsChecked = toggle == selected;
    }

    private void OnIdCard(object sender, RoutedEventArgs e)
    {
        DocIdCard.IsChecked = false;
        IdCardNote.Visibility = Visibility.Visible;
    }

    private void OnPassport(object sender, RoutedEventArgs e)
    {
        DocPassport.IsChecked = true;
        IdCardNote.Visibility = Visibility.Collapsed;
        PassportOptions.Visibility = Visibility.Visible;
    }

    private void OnReason(object sender, RoutedEventArgs e)
    {
        var toggle = (ToggleButton)sender;
        Pick((Panel)toggle.Parent, toggle);
        _reason = Enum.Parse<RequestReason>((string)toggle.Tag);
        StartButton.IsEnabled = _reason is not null && _ageBand is not null;
    }

    private void OnAge(object sender, RoutedEventArgs e)
    {
        var toggle = (ToggleButton)sender;
        Pick((Panel)toggle.Parent, toggle);
        _ageBand = Enum.Parse<AgeBand>((string)toggle.Tag);
        StartButton.IsEnabled = _reason is not null && _ageBand is not null;
    }

    private void OnStart(object sender, RoutedEventArgs e) => Show(ScreenLogin, 2);

    private void OnLogin(object sender, RoutedEventArgs e)
    {
        RenderBranch();
        Show(ScreenBranch, 3);
    }

    private void RenderBranch()
    {
        BranchList.Children.Clear();
        foreach (var branch in Branches.All)
        {
            var toggle = new ToggleButton
            {
                Style = (Style)FindResource("Choice"),
                HorizontalContentAlignment = HorizontalAlignment.Left,
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Content = $"{branch.Name}\n{branch.Address} · עמדת שירות דיגיטלית",
                IsChecked = _branch == branch,
            };
            toggle.Click += (_, _) => { _branch = branch; RenderBranch(); };
            BranchList.Children.Add(toggle);
        }

        DateList.Children.Clear();
        foreach (var day in Branches.WorkingDays(DateOnly.FromDateTime(DateTime.Today), 5))
        {
            var toggle = new ToggleButton { Style = (Style)FindResource("Choice"), MinWidth = 0, Content = day.ToString("ddd dd/MM/yyyy", Hebrew), IsChecked = _date == day };
            toggle.Click += (_, _) => { _date = day; RenderBranch(); };
            DateList.Children.Add(toggle);
        }

        SlotList.Children.Clear();
        foreach (var slot in Branches.Slots)
        {
            var toggle = new ToggleButton { Style = (Style)FindResource("Choice"), MinWidth = 0, Content = slot, IsChecked = _slot == slot };
            toggle.Click += (_, _) => { _slot = slot; RenderBranch(); };
            SlotList.Children.Add(toggle);
        }

        BranchNext.IsEnabled = _branch is not null && _date is not null && _slot is not null;
    }

    private void OnBranchBack(object sender, RoutedEventArgs e) => Show(ScreenInfo, 1);

    private void OnBranchNext(object sender, RoutedEventArgs e)
    {
        var now = DateTime.Now;
        Summary.Text = string.Join("\n",
            "שם המבקש: יעל לוי",
            $"מספר זהות: {IdNumber.Text}",
            $"סוג הבקשה: {_reason!.Value.Hebrew()}",
            $"גיל המבקש: {_ageBand!.Value.Hebrew()}",
            $"לשכה: {_branch!.Name}",
            $"מועד: {_date!.Value.ToString("ddd dd/MM/yyyy", Hebrew)} · {_slot}");
        FeeLabel.Text = "אגרה — תעריף מקוון " + (FeeRules.OnlineRateFor(now) == FeeRate.OnlineWinter ? "חורף" : "קיץ");
        FeeAmount.Text = "₪" + FeeRules.PublicFee(_reason.Value, _ageBand.Value, now);
        PayError.Visibility = Visibility.Collapsed;
        Show(ScreenPay, 4);
    }

    private void OnPayBack(object sender, RoutedEventArgs e) => Show(ScreenBranch, 3);

    private async void OnPay(object sender, RoutedEventArgs e)
    {
        PayButton.IsEnabled = false;
        PayButton.Content = "מעבד תשלום…";
        await Task.Delay(700);
        PayButton.IsEnabled = true;
        PayButton.Content = "לתשלום ואישור התור";

        var request = new PassportRequest(DocumentType.Passport, _reason!.Value, _ageBand!.Value);
        PaymentOrder order;
        try
        {
            order = FeeRules.BuildPaymentOrder(request, DateTime.Now);
        }
        catch (FeeScheduleException error)
        {
            await FailPayment(error, request);
            return;
        }

        DoneText.Text = $"אסמכתה {Random.Shared.Next(10_000_000, 99_999_999)} · {_branch!.Name} · {_date!.Value.ToString("dd/MM/yyyy", Hebrew)} {_slot} · שולם ₪{order.Amount}";
        Show(ScreenDone, 5);
    }

    private async Task FailPayment(FeeScheduleException error, PassportRequest request)
    {
        PayErrorCode.Text = $"{FeeScheduleException.ErrorCode} · {error.ServiceCode}";
        PayError.Visibility = Visibility.Visible;
        Show(ScreenPay, 4, failed: true);

        var appointment = $"{_date!.Value:yyyy-MM-dd}T{_slot}";
        var report = FailureReport.From(error, request, _branch!.Id, appointment, DevinIdentity.FromEnvironment());
        var sending = _reporter.ReportAsync(report);
        MessageBox.Show(this,
            $"התשלום לא בוצע והתור לא נקבע.\nמערכת חישוב האגרות לא הצליחה להפיק הזמנת תשלום עבור הבקשה.\n\n{FeeScheduleException.ErrorCode}",
            "לא ניתן להשלים את התשלום", MessageBoxButton.OK, MessageBoxImage.Error, MessageBoxResult.OK, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);
        var result = await sending;
        if (result.Reference is not null) PayErrorCode.Text += $" · Ref {result.Reference}";
    }

    private void OnDoneHome(object sender, RoutedEventArgs e)
    {
        _branch = null;
        _date = null;
        _slot = null;
        Show(ScreenInfo, 1);
    }
}
