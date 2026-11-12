# Mayo Clinic — Request an Appointment assets

Source: https://www.mayoclinic.org/appointments and https://www.mayoclinic.org/forms/us-resident-appointment (live DOM, computed styles and assets captured November 12, 2026).

The landing page reproduces the "Start your appointment request here." hero (new / returning / referring physician cards, emergency notes, phone numbers by campus). The new-patient path reproduces the request wizard: logo + Help | Manage Cookies header, the Part 1 / Part 2 stepper and the bordered radio cards with the blue pill **Next** button. The Mayo Clinic Sans / Serif Display fonts and logos are served locally.

| File | Original URL |
|------|--------------|
| `logo.svg` | https://assets.mayoclinic.org/content/dam/mayoclinic/images/logos/mayo-clinic-logo.svg |
| `logo.png` | https://onlineservices.mayoclinic.org/NewAppointments/React/assets/mayo-clinic-logo-black-CxIV04U1.png |
| `MayoClinicSans-Regular.woff2`, `MayoClinicSans-Bold.woff2`, `MayoClinicSerifDisplay-Bold.woff2` | https://www.mayoclinic.org/mayofonts/Fonts/mayo/ |

No original site scripts, analytics or reCAPTCHA are included. The pre-filled patient (Jordan Ellis), member ID and concern are synthetic. Specialty list, triage queues, SLAs and follow-up windows are demo fixtures. All trademarks and original assets remain the property of their respective owners. This is an unlisted demonstration; no request reaches Mayo Clinic.

## Incident flow

1. Open `/mayo` (alias of `/8d8c2937`) and click **New patients**.
2. Keep the pre-filled answers and click **Next** through Patient info, Medical concerns (Cardiovascular Medicine), Insurance details and Preferences (Rochester, Minnesota).
3. Click **Submit request**. The API returns HTTP 500 / `TypeError: Cannot read properties of undefined (reading 'callbackSlaHours')` and the page shows "Something went wrong." with the request reference.
4. The service captures Sentry telemetry and invokes the shared instant alert/session flow (`alert_path: instant`; the webhook slug guard prevents a duplicate session). The prompt tells Devin to fix the specialty/triage key mismatch and open a PR against `main` without merging or deploying.
5. Healthy path: **Review my answers** → Back to Medical concerns → choose **Dermatology** → Submit. Part 2 offers follow-up windows; confirming shows the request summary.

The intentional defect is in `app/services/verticals/8d8c2937.js` (`TRIAGE_QUEUES`). Keep it in this demo baseline. Local verification must run without Sentry/Slack/Devin credentials to avoid starting real sessions.
