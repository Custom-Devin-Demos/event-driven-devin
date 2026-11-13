# Docusign eSignature signing experience (128703d6)

Unlisted demo at `/docusign` (also `/docusign-signing`, `/128703d6`). Mocks the Docusign eSignature recipient flow:
Agreements inbox → **Sign** → Electronic Record and Signature Disclosure (agree + **Continue**) → yellow **Start** / **Sign** / **Initial** / **Fill In** guide tag → **Adopt Your Signature** (Select Style / Draw) → **Finish** → "You're done signing" + Certificate of Completion → Inbox shows **Completed**.

- Envelope state is in memory per browser (`x-demo-id` from localStorage), so viewers never collide. Reset with **Reset demo** (Inbox footer, Other Actions menu, completion page), `Alt+R`, or `?reset=1`.
- `?signer=Jane%20Doe` changes the recipient name.
- No on-call path yet: nothing in this flow posts alerts or starts Devin sessions. `COMPLETION_STEPS` in `app/services/verticals/128703d6.js` is the seam for a future planted failure.
- Assets: `logo.svg` and DS Indigo fonts from docusign.com; signature fonts (Dancing Script, Homemade Apple, Mrs Saint Delafield, Caveat) from Google Fonts. All agreements, people and companies are synthetic. Docusign® is a trademark of Docusign, Inc.; this is a demonstration, not affiliated with Docusign.
