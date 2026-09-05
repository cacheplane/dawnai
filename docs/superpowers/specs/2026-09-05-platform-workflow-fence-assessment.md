# Platform-generated workflows and the recovery fence

Date: 2026-09-05. Status: read-only assessment; production admission remains
blocked. This is an unresolved integration obligation, not a successful fence
contract or authorization to disable a service.

## Finding

The complete GitHub workflow inventory for `cacheplane/dawnai`, repository ID
`1210070282`, contains 15 entries. Thirteen have repository YAML paths; two do
not:

| Workflow ID | Exact path | Observed state |
| --- | --- | --- |
| `342414828` | `dynamic/agents/copilot-pull-request-reviewer` | active |
| `272837823` | `dynamic/dependabot/dependabot-updates` | active |

The raw GET response is retained at
`/tmp/dawn-recovery-live-workflows-20260905.json`; its `total_count` equals the
returned inventory length. The current
[fence contract](./2026-09-05-recovery-fence-contract.md) requires repository
workflow paths and Git source bindings. It therefore cannot represent this
actual topology. Filtering these entries would make its completeness claim
false. Accepting every `dynamic/*` path as a nonwriter would introduce an
unsupported authority claim.

GitHub documents Dependabot workflows as generated per run, outside
`.github/workflows`. It also documents that this service bypasses repository and
organization Actions policy checks and disablement. That does not establish
the behavior of disabling its individual workflow ID.
[Dependabot on Actions](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-on-actions)

## Bounded evidence

Two completed jobs were inspected through read-only APIs and logs:

| Sample | Reported job-token permissions | Reported secret source |
| --- | --- | --- |
| Copilot run `33708863267`, job `100503855970` | Deployments: write; Metadata: read | AgentSecrets |
| Dependabot run `33888847826`, job `101075269117` | Contents: read; Metadata: read; Packages: read | None |

Both runs used the `dynamic` event. These observations concern those particular
job tokens. They do not prove historical or future grants, service-token
authority, or the absence of separately configured credentials.
[Copilot sample](https://github.com/cacheplane/dawnai/actions/runs/33708863267),
[Dependabot sample](https://github.com/cacheplane/dawnai/actions/runs/33888847826)

The documented Dependabot restrictions for events such as `pull_request` and
`push` cannot simply be transferred to the observed `dynamic` event.
[Event-specific restrictions](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-on-actions)

Current repository `dependabot.yml` contains npm and GitHub Actions update
configurations with no registry declarations. This is not proof about historical
configuration or organization-level registry credentials. GitHub documents
private registry access and configurable external-code execution, as well as
organization registry configuration.
[Registry configuration](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/configure-access-to-private-registries),
[Organization registry fallback](https://github.blog/changelog/2025-07-22-centralized-private-registry-configuration-for-dependabot-is-now-generally-available/)

Copilot review can consume repository instructions and skills. Its environment
can include setup workflows and configurable MCP tools or credentials. Whether
those extensions can reach this repository's release records has not been
established. A platform path or one restricted job token cannot answer that
question.
[Code review inputs](https://docs.github.com/en/copilot/concepts/agents/code-review),
[Setup environment](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment),
[MCP configuration](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers)

## Requirements for a representation change

A future platform topology variant must identify the exact supported service
path, repository ID, workflow ID, and a digest-bound review record. Both entries
must remain in the complete, bracketed inventory; replacement IDs, renamed
paths, new services, and unknown authority must block. No wildcard or implicit
empty-source exemption is acceptable.

The review must distinguish service-owned behavior from repository-controlled
extensions. Bind the relevant current-default configuration bytes and explicit
absence checks; account for historical reruns, head-controlled inputs, setup
execution, MCP tools, service secrets, and registry configuration. Settings that
cannot be freshly read require an explicit reviewed operational assumption and
change-invalidation procedure. They cannot be silently treated as absent.

The existing workflow-ID-wide nonwriter classification is a reviewed semantic
assertion, not machine-derived permission proof. A platform variant would need
an equally explicit authority contract without pretending that nonexistent YAML
can be hashed. No successful platform exclusion record has been prepared or
admitted. Required fencing of `release.yml` and
`published-artifact-verify.yml` remains unchanged.

## Required disposable evidence

An authorized rehearsal must trigger the actual platform-generated workflows,
with positive controls before and after any proposed disable/enable mechanism.
Test fresh platform triggers, supported historical all/failed/job reruns,
settlement, drainage, and workflow identity recreation. An unsupported
`workflow_dispatch` denial is not a fence proof for a service that never
supports that entrypoint.

Use harmless fixture targets for configurable setup or MCP authority, and
restore the owned service settings and runs afterward. The ordinary workflow
disable endpoint does not document a dynamic-service-specific revocation
guarantee. If workflow-ID disablement is ineffective, any feature-disablement or
credential-revocation alternative needs its own evidence. Global Actions
disablement is insufficient for Dependabot.
[Workflow disable API](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#disable-a-workflow)

The immediate result is an explicit admission blocker and a concrete evidence
gap. Runtime/CLI work may continue dormant; implementation tests cannot replace
this service and configuration review.
