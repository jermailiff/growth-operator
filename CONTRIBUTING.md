# Development

Use Node 22+. Core tests need no credentials or npm dependencies:

```bash
npm test
```

Browser tests additionally need Playwright and Chromium. Install them in a separate tools directory so the app stays dependency-free:

```bash
mkdir -p /tmp/growth-browser-tools
npm install --prefix /tmp/growth-browser-tools playwright
/tmp/growth-browser-tools/node_modules/.bin/playwright install chromium
export PLAYWRIGHT_MODULE=/tmp/growth-browser-tools/node_modules/playwright/index.mjs
node scripts/test-m3-browser.mjs
node scripts/test-public-web-browser.mjs
node scripts/test-pilot-browser.mjs
```

Alternatively set `CHROME_PATH` to an installed Chrome executable. The scripts inject fake providers, use isolated temporary stores, and block non-local browser network requests. Do not replace them with real credentials for routine testing.

Use synthetic fixtures. Preserve evidence statuses, exact citation admission, inference accounting, append-only history, approval binding and no-retry behavior. Changes to these contracts need focused regression tests. Keep business-specific copy and contacts in ignored runtime data, never generic application code.

The isolated research CLI is retained for developers; it is not the normal startup flow and requires its own valid origin artifacts. No historic private evaluation artifacts ship with the repository.

Before submitting a change, run the automated and browser suites and `git diff --check`. Describe the behavior changed, verification and limitations. Never include keys, personal records or raw live provider payloads in a pull request.
