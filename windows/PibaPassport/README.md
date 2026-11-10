# gov.il biometric passport — Windows desktop app

WPF (.NET 8) twin of the web replica at `/passport` (`app/public/verticals/b09e76ca.html`)
and the iOS app (`COG-GTM/event-driven-ios` `PibaPassportMobile/`). Hebrew, right-to-left.

| Project | What it is | Runs on |
| --- | --- | --- |
| `PibaPassport.Core` | Fee rules, branches, failure reporter (no UI) | any OS |
| `PibaPassport.Core.Tests` | xUnit tests for the core | any OS |
| `PibaPassport.Desktop` | WPF app (`PibaPassport.exe`) | Windows (builds on Linux via `EnableWindowsTargeting`) |

```powershell
dotnet test windows/PibaPassport/PibaPassport.Core.Tests
$env:PIBA_DISABLE_FAILURE_REPORTS = "1"
dotnet run --project windows/PibaPassport/PibaPassport.Desktop
```

## Flow

דרכון ביומטרי → reason → age → **לזימון תור והגשת בקשה** → הזדהות לאומית (pre-filled, **כניסה**) →
branch, date and time → **המשך לתשלום** → **לתשלום ואישור התור**.

A first passport and a lost/stolen passport pay and show the confirmation. **Renewing an expired
passport (חידוש דרכון שפג תוקפו)** fails: the step turns red, a red banner and an error dialog show
`PIBA-FEE-4221`, and nothing is charged.

## Client identity contract

- service: `customer-piba-passport`
- source: `piba-passport/windows`
- endpoint: `POST /api/piba/passport/error` on `https://devindemos.com` (override with `PIBA_ALERT_BASE_URL`)
- payload: `FailureReport` in `PibaPassport.Core/FailureReporter.cs` (same keys as the web and iOS clients)
- optional Devin identity: `PIBA_DEVIN_USER_ID`, `PIBA_DEVIN_EMAIL`, `PIBA_DEVIN_ORG_ID`

Do not change these values or the payload keys when fixing app code.

## Reproduction safety

Every accepted report raises a real Slack alert and starts a Devin session. Always set
`PIBA_DISABLE_FAILURE_REPORTS=1` for local runs unless the alert chain is being demonstrated
on purpose.
