# Bank Millennium Millenet — Windows desktop app

WPF (.NET 8) twin of the web client at `/bankmillennium` (`app/public/verticals/bf98154e.html`)
and the iOS app (`COG-GTM/event-driven-ios` `BankMillenniumMobile/`). Polish UI, Millennium branding, MOCK badge.

| Project | What it is | Runs on |
| --- | --- | --- |
| `BankMillennium.Core` | Customer directory, sign-in policies, dashboard data, failure reporter (no UI) | any OS |
| `BankMillennium.Core.Tests` | xUnit tests for the core | any OS |
| `BankMillennium.Desktop` | WPF app (`BankMillennium.exe`) | Windows (builds on Linux via `EnableWindowsTargeting`) |

```powershell
dotnet test windows/BankMillennium/BankMillennium.Core.Tests
$env:BM_DISABLE_FAILURE_REPORTS = "1"
dotnet run --project windows/BankMillennium/BankMillennium.Desktop
```

## Flow

**Logowanie do Millenetu** → Millekod (pre-filled `48213907`) → **DALEJ** → Hasło (pre-filled) → **ZALOGUJ** →
"Potwierdź logowanie w aplikacji mobilnej" → **Pulpit** (accounts and recent transactions).

Millekod `31570264` (Piotr Nowak) and `55018342` (Marta Wiśniewska) log in. The pre-filled customer
**Anna Kowalska (`48213907`)** cannot: the login step turns red with
"Nie możemy Cię teraz zalogować. Spróbuj ponownie później. Kod błędu: MIL-AUTH-4031".
An invalid Millekod or empty password shows an inline validation message and is never reported.

## Client identity contract

- service: `customer-bank-millennium`
- source: `bank-millennium/windows`
- endpoint: `POST /api/bankmillennium/login/error` on `https://devindemos.com` (override with `BM_ALERT_BASE_URL`)
- payload: `FailureReport` in `BankMillennium.Core/FailureReporter.cs` (same keys as the web and iOS clients)
- optional Devin identity: `BM_DEVIN_USER_ID`, `BM_DEVIN_EMAIL`, `BM_DEVIN_ORG_ID`

Do not change these values or the payload keys when fixing app code.

## Reproduction safety

Every accepted report raises a real Slack alert and starts a Devin session. Always set
`BM_DISABLE_FAILURE_REPORTS=1` for local runs unless the alert chain is being demonstrated
on purpose.
