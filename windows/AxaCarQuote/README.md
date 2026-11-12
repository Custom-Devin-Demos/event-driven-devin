# AXA Car Insurance — Windows desktop (WPF)

THIS IS A MOCK. Demo client for the event-driven incident demo; not affiliated with AXA UK.

Windows twin of the AXA UK comprehensive car insurance quote journey served at `/axa` (web) and
`AxaCarCore/` + `AxaCarMobile/` in `COG-GTM/event-driven-ios` (iOS).

## Flow

Home → **CAR** → **Comprehensive car insurance** → **GET A QUOTE →** → registration `LK24 EVX`
(Tesla Model Y, seeded customer James Carter) → **FIND CAR** → **CONTINUE →** → **CONTINUE →** →
**GET MY QUOTE →** shows the red "Sorry, we can't give you a quote online right now" state with
`AXA-QTE-4221` and reports the failure. `MA21 PTR` (Ford Focus, petrol) and `YD19 DSL` (VW Golf,
diesel) quote normally. Bad registrations, postcodes and dates of birth stay inline and are never reported.

## Build and run

Requires the .NET 8 SDK; the desktop app needs Windows (WPF).

```powershell
dotnet test windows/AxaCarQuote/AxaCarQuote.Core.Tests
$env:AXA_DISABLE_FAILURE_REPORTS=1; dotnet run --project windows/AxaCarQuote/AxaCarQuote.Desktop
```

## Client identity contract

- service: `customer-axa-uk`
- source: `axa-car/windows`
- endpoint: `POST /api/axa/car-quote/error` on `https://devindemos.com` (override with `AXA_ALERT_BASE_URL`)
- identity: `AXA_DEVIN_USER_ID`, `AXA_DEVIN_EMAIL`, `AXA_DEVIN_ORG_ID`

Every accepted report raises a real Slack alert and Devin session: always set
`AXA_DISABLE_FAILURE_REPORTS=1` for local runs.
