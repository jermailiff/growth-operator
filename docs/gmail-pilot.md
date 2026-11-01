# Optional Gmail pilot

Experimental, local-only. Start with mocked tests; connecting a mailbox does not authorize sending.

## Prepare local pilot input

With the server stopped and only for a new pilot, create `data/pilot/` and copy `examples/pilot-input.json` to `data/pilot/input.json`. Never overwrite an existing pilot input or log. Replace all placeholder copy and the sender with owner-approved values. The empty contact list intentionally permits no batch.

Each contact needs `id`, `name`, `firstName`, `email`, and `eligibility` (`supported` or `provisional`). Retain the actual source evidence and gaps alongside those fields. Do not mark an uncertain record supported just to enable selection. Local file preparation is currently manual; there is no general contact-import UI. Do not copy real contact data into Git.



Open `http://127.0.0.1:4180/pilot.html`. Run Operator does not send email. The pilot is a separate, explicit owner action: connect → freeze local previews → approve exact batch → send unsent messages → manually refresh. No Gmail drafts, follow-ups, pixels, webhooks or background jobs are created.

Runtime files are ignored by Git:

- `data/pilot/input.json`: owner-supplied subjects/bodies, intended sender, criteria, contact evidence, provisional flags and shared signature preview. Keep original bodies unchanged; only `[First Name]` is substituted. Claims in copy remain owner-supplied.
- `data/pilot/sources/`: original source screenshots, with hashes recorded in the input.
- `data/pilot/pilot.jsonl`: append-only feedback, frozen random assignments, approvals, durable send reservations/results, Gmail reply responses, suppressions and owner observations.
- `data/pilot/credentials/gmail-token.json`: Google access/refresh tokens, created with mode 0600 in a private directory. Never include this file in reports, models or Git. The UI sees only connected mailbox identity.

Existing business state and decision history are not rewritten. On the next deliberate Run Operator, a separate `emailPilot` context field supplies cohort-level feedback and substantive pilot outcomes once, without Gmail transport envelopes or recursive request history. Incoming email is explicitly untrusted data; it cannot authorize execution. Uncertain reply correlations enter model context only as unresolved metadata, not trusted message content. Raw Gmail responses remain local for review.

### Exact local Gmail setup

1. Confirm the intended sender is the mailbox owner's **primary Google/Gmail or Google Workspace mailbox**. This first version does not send through aliases, delegated accounts, a different facilitator account, Microsoft mailboxes, or arbitrary SMTP. If the intended address is not Google-hosted, stop: do not substitute another account.
2. In a Google Cloud project controlled by the mailbox owner/authorized administrator, enable **Gmail API**. Configure the OAuth consent screen (Google Auth Platform → Branding/Audience/Data Access). For a single Workspace organization, Internal may be appropriate if available; otherwise use External/Testing and add the exact mailbox owner as a test user. Do not publish broadly for this local pilot.
3. Create an **OAuth client ID → Web application**. Add exactly `http://127.0.0.1:4180/api/pilot/oauth/callback` as an authorized redirect URI. If `PORT` differs, use the same port in both configuration and browser URL. No service account or domain-wide delegation is needed.
4. Request only `https://www.googleapis.com/auth/gmail.send` and `https://www.googleapis.com/auth/gmail.readonly`. Readonly is needed for actual reply bodies and message reconciliation; metadata alone is insufficient. No compose/draft, modify, delete, contacts, calendar or settings-write permission is requested. These Google grants cover the mailbox; the application constrains reads to pilot references, participants/subjects/times and related delivery notices. They are not a provider-enforced pilot-only fence.
5. Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` in the local ignored `.env`, then restart the idle local server with the existing `npm start` command. Do not place the downloaded secret JSON or tokens in the source tree outside ignored credentials/runtime paths. Existing `OPENAI_API_KEY`, `OPERATOR_MODEL` and optional `PORT` configuration is unchanged. No model key is used by the pilot sending/refresh actions.
6. On the pilot page, the named owner must authorize the connection, click **Connect intended mailbox**, and choose their own account at Google. The callback verifies the actual primary mailbox against the intended runtime sender. Wrong-account credentials are discarded. Connecting sends nothing and grants no batch approval.
7. Workspace administrators may block unverified/external applications or restricted scopes. The admin must permit this OAuth client if policy requires it. `gmail.readonly` is a restricted scope. External testing has test-user limits, and refresh tokens for this use may expire after seven days; reconnect rather than relaxing scopes. Public distribution or server-side hosting would require a separate Google verification/policy review, outside this local milestone.

Official references: [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [token expiration](https://developers.google.com/identity/protocols/oauth2#expiration), [sending](https://developers.google.com/workspace/gmail/api/guides/sending), [message search](https://developers.google.com/workspace/gmail/api/guides/list-messages).

### Before send approval

Connecting and reviewing contacts are not sending approval. The preview can be frozen while checks are pending, but approval/send are blocked until the owner records all of:

- exact primary sender authorization;
- actual service/source suitability and supporting account/policy review (public email availability does not establish suitability);
- complete approved footer with business postal address and monitored reply-based opt-out instructions;
- checked signature destinations;
- evidence from a **separately approved controlled authentication test**, including received authentication results. This app does not initiate that test. A prior DMARC failure is not resolved by checking a box without reviewing the actual evidence. Do not invent DNS values or change DNS automatically.

Screenshots preserve visible link text, not hidden hyperlink targets. Those targets and the business postal address must be supplied/checked before approval. Any observed failure involving differing authentication domains remains unresolved until the actual sender/transport and received headers are checked. No DNS or mailbox settings are changed by this application.

### Freeze, approve, send and pause

Select only supported contacts with published professional emails. Provisional contacts cannot enter a batch. The application stores a cryptographically random seed, approximately equal A/B assignment, complete contact snapshots, original copy, rendered messages, sender and readiness evidence. Each person receives one variant. A frozen preview is not a send approval. The **Approve this exact send batch** action binds its hash; changing runtime input or creating a replacement preview invalidates the earlier batch for sending. A changed footer belongs in a new preview requiring fresh approval.

Sending runs in the foreground browser, one request/recipient at a time. Closing the page stops subsequent requests (an in-flight message may still complete). **Pause unsent messages** persists a pause, including while a send is in flight; it cannot recall a sent message. The server reserves each recipient durably before calling Gmail. Duplicate clicks, stale revisions, restarts and previously sent/uncertain addresses cannot resend. Definite rejection pauses the batch; ambiguous timeouts/5xx/unreadable responses are **uncertain**, never automatically retried. Refresh looks for the exact outbound Message-ID and verifies sender/recipient before reconciling a sent result. No match is not proof of non-delivery: uncertainty remains and blocks continuation. If the process crashes leaving `operation.lock`, stop all server processes and inspect reservations before manually removing that lock. Do not clear reservations or restart the batch.

### Results and limitations

**Refresh results** reads only targeted message searches and referenced thread participants, deduplicates Gmail message IDs, and records raw Gmail responses locally. Delivery notices are also searched outside the original thread. Uncertain correlations remain explicitly marked for owner review and are excluded from substantive model evidence. Delivery notices pause the remaining batch. Explicit recognized opt-outs immediately create suppressions; subsequent sends recheck them. No automatic reply or follow-up is sent. Text/HTML parsing and deterministic labels are preliminary: the owner reviews ambiguous messages and records corrections. The system does not infer interest from a generic reply, read receipt or auto-response.

Record interested replies, corrections, meetings and opportunities on the pilot page. A reply correction uses its displayed Gmail reply ID; otherwise the entry is a new owner observation. Raw observations are preserved. Each variant shows selected-recipient denominator, accepted-send count, failed/uncertain sends and recipient-level response categories. Human replies include interested replies and explicit opt-outs. Meetings/opportunities are owner-recorded events, not independently verified. Accepted send is not inbox delivery. A small A/B batch compares the complete messages, not isolated subject lines, and cannot establish a statistically proven winner.

### Verification (all providers mocked)

Run `npm test` and the checked-in `scripts/test-m3-browser.mjs`, `scripts/test-public-web-browser.mjs`, and `scripts/test-pilot-browser.mjs`. For bundled Playwright, set `PLAYWRIGHT_MODULE` to its `index.mjs`; use `CHROME_PATH` for installed Chrome if bundled browser binaries are absent. Browser tests block non-local browser network requests. Gmail and model adapters are fake. No real mailbox is required for verification.
