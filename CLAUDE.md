# gmail-assistant

Google Apps Script that turns Gmail job and subscription emails into one Notion row per job.
Source is in `src/` (pasted into Apps Script as-is), tests in `tests/` run with `npm test`.
Public repo: never commit secrets, real company names, or anyone's inbox data.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for faizanbukhari22/gmail-assistant, via the gh CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five roles: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: GLOSSARY.md and docs/adr/ at the repo root, created lazily. See `docs/agents/domain.md`.
