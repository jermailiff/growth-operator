# Security and privacy

This is an experimental single-user localhost application, not a hardened hosted service. Keep its loopback binding and do not expose it to a network or tunnel. Use a trusted computer and browser profile.

Never commit `.env`, runtime records, access/refresh tokens, raw provider responses or real contact lists. `.gitignore` is a safeguard, not a secret scanner. Audit exported files and Git history before sharing.

API requests transmit selected business context and substantive history to the configured provider. Local audit logs may contain the complete request/response, contact data and email content. Protect and back up them accordingly. Provider `store: false` is not a promise of local-only processing or zero provider retention.

Public pages and incoming messages are untrusted data. Evidence checks, execution bounds and explicit approvals limit behavior but do not establish semantic correctness, permission to contact, or resistance to every prompt injection. Review consequential recommendations and pending acquisition/send approvals.

The optional Gmail grant is mailbox-wide at the provider; app-side filters are not a provider-enforced pilot-only permission. Read the Gmail guide before connecting. Do not use the pilot with sensitive inboxes without independently reviewing the implementation and its data handling.

Do not post secrets or private records in public issues. Report reproducible security problems with synthetic data. There is no guaranteed security-response SLA for this prototype.
