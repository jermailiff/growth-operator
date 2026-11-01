# Growth Operator

An experimental, local-first assistant for small-business growth work: give it an objective and ideas, let it reason and research, review its work, and record what actually happened before the next deliberate run.

**Status: public prototype, not a hosted service.** It runs on your computer, requires your own provider credentials, and keeps you in control of consequential actions. It is not an autonomous campaign platform. Model quality and real-world results are not guaranteed by the mocked tests.

## What it does

- Reasons from your business context, initiatives and recorded outcomes.
- Uses bounded public-document research when useful, then produces an evidence-backed decision.
- Distinguishes sourced facts, provider claims, owner information, inferences and unknowns.
- Keeps provisional same-run candidates separate from completed decision history.
- Offers separately approved prospect discovery and per-person cohort review.
- Includes an optional experimental Gmail A/B pilot with exact-batch approval and manual result refresh.

Run Operator does not send emails. Gmail sending is a separate action on the optional pilot page. Connecting a mailbox or approving a cohort is not permission to send.

## Quick start

Requirements: **Node.js 22+**, Git, and an OpenAI API account for real model runs. The core app has no npm runtime dependencies.

```bash
git clone https://github.com/jermailiff/growth-operator.git
cd growth-operator
cp .env.example .env
cp examples/state.json data/state.json
```

These copy commands are for a fresh checkout only. Never overwrite an existing `.env` or `data/state.json`.

Edit `.env` locally:

```dotenv
OPENAI_API_KEY=your-own-key
OPERATOR_MODEL=your-accessible-model-id
PORT=4180
```

Choose a model that supports the Responses API, hosted `web_search` and strict JSON-schema outputs together. There is no automatic model fallback. Provider availability, account permissions and billing must be checked in your own account.

```bash
npm start
```

Open **http://127.0.0.1:4180**. Fill in your actual business context, objective and initiatives before running. The starter file contains placeholders, not a preconfigured business or historical results.

1. Enter an objective and idea.
2. Click **Run Operator** and wait for the final result or an honest failure.
3. Review the completed work, evidence, uncertainty and any required input or approval.
4. Record your response or actual outcome.
5. Start the next run deliberately. There are no background investigations.

Stop with Ctrl+C. Restart after editing `.env`. Use one server process per runtime directory.

## Costs and bounds

Real model, hosted search and optional provider calls can incur charges. The app does not guarantee a dollar spending cap.

| Operation | Enforced boundary |
| --- | --- |
| Public-document research | Up to 5 hosted web actions, 180-second application deadline, 6,000 output tokens |
| Initial and final decisions | Separate 180-second timeouts; no automatic retries |
| Public-web prospecting | Separate explicit approval; up to 5 actions, 180 seconds, 6,000 output tokens and 25 candidates, with lower proposal limits allowed |
| Email pilot | Explicit exact-batch approval, one initial message per selected person, no automatic follow-ups |

A complete operator run can take several minutes. A local timeout cannot guarantee the provider stopped processing or charging. Research may correctly use zero searches when existing evidence is sufficient. Missing evidence remains unknown. Structural validation does not independently prove a source's truth or freshness.

## Data and privacy

- `data/state.json` holds business context, objective, initiatives and current observations.
- `data/decisions.jsonl` is append-only run and owner-outcome history.
- Optional prospect and pilot records, raw requests/responses and credentials remain in local runtime storage.
- Model-facing context includes substantive history, not recursive copies of old API requests. Non-substantive failed executions stay in the audit/UI; owner feedback and validated partial work remain available to future runs.
- Research does not automatically rewrite durable business state.
- `.env` and `data/` contents are ignored by Git. Do not attach them to issues or commit them.

**Local storage does not mean local inference.** Runs send relevant context/history to OpenAI. Optional Apollo and Gmail operations send data to those providers. Read [SECURITY.md](SECURITY.md) before using confidential data. Back up `data/` with the server stopped. Do not manually edit the log while the app is running.

## Optional capabilities

- [Prospect discovery and cohort feedback](docs/prospecting.md): public-web discovery or Apollo, with explicit bounded acquisition approval. Provider restrictions still apply.
- [Gmail pilot](docs/gmail-pilot.md): owner-authorized primary mailbox, local previews, frozen A/B assignment, explicit send approval, durable send reservations and manually refreshed results. Experimental; not needed for ordinary operator use.
- [Development and tests](CONTRIBUTING.md): deterministic tests with fake providers.

Optional credentials are listed in `.env.example`. Leave them blank if unused. Gmail requires a user-controlled Google Cloud OAuth project; the repository supplies no shared OAuth client or credentials. Provider credit ceilings must reflect the account's actual pricing.

## Verification

```bash
npm test
```

Tests use fake model/provider responses and temporary runtimes. No API keys are required. See [VERIFICATION.md](VERIFICATION.md) for release checks and [CONTRIBUTING.md](CONTRIBUTING.md) for browser tests.

## Limits and troubleshooting

- This is a single-user localhost app without a remote authentication/tenant system. Do not expose it through a public tunnel or bind it to a public interface.
- HTTP 429 can mean different provider limits. Inspect the saved provider error; do not assume waiting fixes exhausted credits or oversized requests.
- Failed or incomplete outputs remain failed. No automatic repair, retry or campaign launch is performed.
- Source matching checks provenance, not permission to contact. A published email is not verified deliverability, interest or consent.
- Cohort review and email result classification need human review. A small A/B sample cannot establish a statistically proven winner.
- No CRM, background monitoring, calendar integration, automatic follow-ups, tracking pixels or general web crawler.

The public repository starts with a source-only release snapshot. Private development history, business records, contacts, campaign copy and experimental artifacts are not included.

## License

MIT. See [LICENSE](LICENSE).
