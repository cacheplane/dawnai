# OSS Foundation Design

## Goal

Bring Dawn's public repository up to a baseline open-source project standard without adding DCO enforcement or a CLA workflow in this pass.

## Context

The repository is public and publishes MIT-licensed packages, but GitHub does not currently detect a root license or most community-health files. GitHub repository metadata also still points at an old Vercel URL, and post-merge branch deletion is disabled. The repo already has `CONTRIBUTORS.md`, which is useful for internal monorepo setup and should remain the detailed engineering guide.

## Design

Add a small set of GitHub-native community files:

- `LICENSE` with MIT license text and a contributor-based copyright holder.
- `CONTRIBUTING.md` as the public contribution entrypoint.
- `CODE_OF_CONDUCT.md` using Contributor Covenant 2.1.
- `SECURITY.md` for vulnerability reporting.
- `SUPPORT.md` for where to ask questions, report bugs, and file security issues.
- `.github/pull_request_template.md`.
- `.github/ISSUE_TEMPLATE/bug_report.yml`.
- `.github/ISSUE_TEMPLATE/feature_request.yml`.
- `.github/ISSUE_TEMPLATE/config.yml`.
- `.github/dependabot.yml`.
- `.github/workflows/scorecard.yml`.

Update `README.md` so the public contributing link points to `CONTRIBUTING.md` while preserving `CONTRIBUTORS.md` for detailed repo layout and verification commands. Add a root `license` field to `package.json` for consistency with the publishable package manifests.

Use `gh` to update repository metadata and settings:

- Set description.
- Set homepage to `https://dawn-ai.org`.
- Add relevant topics.
- Enable delete-branch-on-merge.
- Enable auto-merge if GitHub allows it.
- Enable repository security features where available: Dependabot security updates, secret scanning, and push protection.

## Out Of Scope

- DCO enforcement.
- CLA enforcement or CLA Assistant.
- Branch protection and required checks.
- CodeQL.
- Governance roles beyond basic public contribution guidance.

## Validation

- Validate the YAML files syntactically.
- Run markdown/docs checks.
- Query GitHub community profile after push to confirm the files are recognized.
- Query repo metadata through `gh` after settings updates.
