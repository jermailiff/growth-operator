# Optional prospect discovery

## M3: approved prospect discovery and selective enrichment

Apollo is an optional supported provider, not blanket approval for a particular use. There is no recurring generic compliance-research step. Concrete source or provider restrictions stop execution. This does not enable sending, personal-email/phone reveals, waterfall services, profile scraping, LinkedIn automation, CRM mutation or background jobs.

Configure `APOLLO_API_KEY` in the existing local `.env`, with access to `/mixed_companies/search`, `/mixed_people/api_search` and `/people/bulk_match`. The key stays server-side. Configure `APOLLO_ORGANIZATION_CREDIT_CEILING` (default `1` per page) and `APOLLO_ENRICHMENT_CREDIT_CEILING` (default `1` per person) to conservative ceilings confirmed against your account. These are charge estimates/reservations, not invented actual usage. Actual `credits_consumed` and rate headers are saved when returned. Missing actual usage remains unknown. If returned charges exceed a configured ceiling, execution stops; already-incurred provider charges cannot be undone. No credits are purchased automatically.

Start locally using `node --env-file=.env src/server.js`. No new database, worker or runtime dependency is required. A missing Apollo key disables Apollo acquisition, not ordinary operator work, proposals or separately configured public-web acquisition.

### Owner flow

1. Enter an audience hypothesis and desired review size in the ordinary context/idea fields. Size is runtime input, not a universal cohort constant.
2. Run Operator. When useful, its existing decision call produces a bounded acquisition proposal alongside the decision. It can instead question or reject the hypothesis.
3. Review provider, companies, person locations, optional titles, purpose of each field, pool/cohort/enrichment limits, call/deadline limits and credit allowance. Approve the exact proposal with **Approve & build cohort**. This permits acquisition, not outreach.
4. The app resolves unambiguous current organizations, discovers one bounded pool, deduplicates by provider identity and excludes prior cohort members, applies supported discovery-stage criteria, and freezes the cohort in provider return order. It does not score or use hidden enrichment attributes. It enriches only selected records missing requested useful fields, in batches of at most ten, capped by approval. Unspent allowance is not a reason to enrich. Conflicting enrichment is withheld with an explicit limitation; no replacement cohort is fetched.
5. The existing model produces an assessment from captured provider records. Review each prospect with approve/reject, optional raw reason and optional correction. This is an outcome, not sending permission.
6. The first review asks for minutes reviewing, whether extra manual research was needed, and one rough estimate of equivalent normal prospecting time. Later reviews do not require repeating these estimates.
7. Start the next operator run deliberately. It receives cohort records and raw reviews without API envelopes. It may infer tentative patterns and propose a refined audience. A second cohort requires its own approval.

Supported selection criteria are current company, provider person-location filters and optional titles. Use concrete cities/states/countries supported by the provider. Known returned location/title conflicts are excluded; missing location data is explicitly filter-based/unknown. Criteria requiring unavailable enrichment attributes are not selection features. Requested fields are name, company, title, location, professional profile, business email and optional employment history, each with a purpose; unsupported fields are rejected. No buying-intent, wealth or quality scores exist.

Requests must fit approved bounds and endpoint safety ceilings: up to 100 search results, 100 review records, five companies, twenty provider calls and a 30–300 second acquisition deadline. These ceilings are not recommended sizes. The operator should propose much smaller practical cohorts. Acquisitions make no automatic retries; used approval remains consumed on failure, including ambiguous provider completion.

All old history stays readable. New append-only events record exact proposal approval, provider requests/responses, cohort selection/enrichment, strategic response and reviews. Raw provider data stays in local audit; selected provider attributes carry source references and provider-claim status. Original provider values, model hypotheses and owner corrections remain separate. Web citation and research-inference accounting rules are unchanged.

### Verification

`npm test` includes mocked adapter, selection, budget, identity, approval and review-continuity tests. No real API key is used by tests. The optional browser check uses Playwright and a local Chrome executable:

```
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_PATH="/absolute/path/to/Chrome" \
node scripts/test-m3-browser.mjs
```

It creates disposable runtimes and uses fake Apollo/model responses only. Do not substitute live credentials or providers for this check.

### Supervised public-web cohorts

The operator can propose `public_web` prospecting in addition to Apollo. Record the audience and your instruction to use supervised public-web prospecting as an owner response, then Run Operator. Review the proposed companies, person locations, roles, the complete source scope and page/contact/location/reporting rules, candidate ceiling, call limit and deadline. **Approve & build cohort** authorizes that exact one-time acquisition, not sending. No supplier inquiry is a prerequisite for this capability; concrete source restrictions still block that source.

This uses the existing `OPENAI_API_KEY` and `OPERATOR_MODEL`; no new environment variables or Apollo credits are required. Model and hosted web usage incur the configured OpenAI API charges. Each approved invocation is capped at five web calls, 180 seconds, 6,000 output tokens and 25 candidates (the proposal can set lower limits). There are no retries, automatic top-ups or background loops.

Candidates carry source-linked professional fields, published professional contact routes where found, and explicit unknowns. Citation admission checks source provenance, not semantic truth, identity accuracy, freshness, deliverability or permission to contact. A missing or nonmatching location/role remains a review gap. Unsupported candidates are excluded in full. Fewer or zero candidates is an honest result. No personal phone/home-address collection, guessed contacts, authenticated/social-profile operation or sending is supported. Use the existing per-person review to record contact willingness, raw reasons and corrections; this feeds the next deliberate run. Historical records remain unchanged.

Mock browser verification: run `scripts/test-public-web-browser.mjs` with the same Playwright/Chrome environment used for `scripts/test-m3-browser.mjs`. Both scripts use isolated temporary stores and mocked provider responses only.

Future public-web approvals carry their full scope in `request.scope`. `exact_hosts` uses literal hostnames only (no implicit subdomains/www equivalence); `public_professional` authorizes discovery across the specified professional page types, without a fixed hostname list. The latter is a distinct, newly approved scope, never an expansion of an old approval. Legacy scope proposals stay readable but cannot be executed under the new contract.

This boundary controls permitted source use and deliberate targeting; hosted search is not a guaranteed zero-off-host network fence. Consulted-source metadata is not a page visit. Provider-observed actions and model-reported incidents are stored separately. Excluded incidental results and reported redirects may be recorded without poisoning unrelated evidence; a false compliance flag, deliberate off-scope targeting/access/evidence use, or an unclassifiable incident still stops execution. Page type, first-party linkage and current-employment classification remain source-attributed model claims, not independent semantic verification; missing support is excluded, never inferred as permission. First-party contact links require a cited originating biography and a captured link passage. No automatic link traversal/crawler is added.

Cohort counts now separate returned records, admitted records, supported employer-plus-exact-location-label matches, provisional records, contact routes and routes among supported matches. Historical affiliation and missing/nonmatching location do not count as supported audience matches. A source-supported count is not verified employment or buying intent.
