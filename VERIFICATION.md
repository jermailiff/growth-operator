# Public prototype verification

Checked October 31, 2026 against a source-only copy of local implementation commit `c7752e20aad81a8a29fa755330ea0482982adb87`.

- **194 automated tests passed**, zero failures or skips.
- **17 mocked browser scenarios passed**: four Apollo/cohort scenarios, seven public-web scenarios and six Gmail-pilot scenarios.
- Fresh-install check passed in a disposable copy: the documented example state loads, history starts empty, and the main and pilot pages return successfully without credentials.
- Production JavaScript and browser assets are byte-identical to the source implementation. Release changes concern documentation, neutral examples, package metadata, empty model configuration and CI. One historical test-fixture note was made generic.
- No real model, search, Apollo or Gmail requests were made by verification. No email was sent and no owner runtime was modified.
- Current release files and historical tracked blobs were checked for common credential patterns; no matches were found. No `.env` or private runtime records were found in tracked history. This is not a comprehensive security audit.
- The public repository uses a new source-only history. Private runtime records, contact lists, business copy and development audit artifacts are excluded.

Local verification used Node 24 and installed Chrome with Playwright. CI is configured to run Node 22 and mocked browser tests; its result must be checked separately after publication. Tests establish deterministic behavior, not live model quality, provider permissions, deliverability, market demand or production security.
