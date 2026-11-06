# KYC onboarding wireframes

Low-fidelity wireframes of the Corporate KYC journey served by vertical `526efb4c` (`/amex-kyc`). There is one wireframe per market. Each wireframe shows what the questionnaire for that market should look like before the UI is built. Reviewers can compare the requirements matrix with the screens without running the app.

> Fictional demo material. These are not American Express designs.

## Convention

- **One self-contained HTML file per country**, named `<ISO-3166 alpha-2>.html` (for example `US-baseline.html`, `DE.html`). Use inline CSS only, with no scripts, web fonts, images or external requests.
- **Grayscale boxes only.** Use white panels, gray borders and gray placeholder inputs. Use no brand colors or logos, so the review stays on content and not on visual design.
- **Real field labels.** Use the exact label text of the questionnaire (`MARKETS.<code>` in `app/services/verticals/526efb4c.js`), with `*` for required fields and the field type in the placeholder (`text`, `date`, `select`, `radio`, `file`).
- **One panel per step**, in journey order: landing / login, each questionnaire step, signature, and thank-you. Number the panels (`1`, `2`, …) and put the step `id` under the title.
- **Annotate every new or changed field** with the requirement ID it implements (for example `FR-REQ-07`). Put the ID in a dashed-outline tag to the right of the field, and give the field itself a dashed outline. Put a short reason on the tag when the change is not obvious from the label. Fields that are unchanged from the US baseline have no tag. Removed fields are shown struck through with their requirement ID.
- **Legend** at the top: market, source requirements file, and the key for unchanged / new / changed / removed fields.
- Keep the panel width at 360 px with panels wrapping in a grid, so the rendered PNG stays readable when embedded in a PR description.

`US-baseline.html` is the reference: it documents today's US journey and has no requirement tags.

## Rendering to PNG

Render with Playwright (already a dev dependency) to a full-page PNG next to the HTML file:

```bash
node -e "
const { chromium } = require('playwright');
(async () => {
  const [src, out] = process.argv.slice(1);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await p.goto('file://' + require('path').resolve(src));
  await p.screenshot({ path: out, fullPage: true });
  await b.close();
})();
" docs/amex-kyc/wireframes/US-baseline.html docs/amex-kyc/wireframes/US-baseline.png
```

If Playwright's bundled Chromium is not installed, pass `executablePath` for a local Chrome to `chromium.launch()` or run `npx playwright install chromium`.

## Using it in a PR

Commit the HTML and PNG together. Embed the PNG in the PR description, for example `![FR wireframe](docs/amex-kyc/wireframes/FR.png)`, next to the requirements summary and the before/after screenshots of the running UI.
