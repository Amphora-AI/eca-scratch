# Baseline workflows

Copy whichever you need into `.github/workflows/` in your project. They all assume `scripts/ci/provision-scratch.mjs` sits at that exact path (same as in this repo), so no edits are required beyond your own deploy/test steps.

| Workflow | Trigger | What it does |
|---|---|---|
| [`01-pr-validation.yml`](01-pr-validation.yml) | `pull_request` | Fresh org per PR → deploy `force-app` → `RunLocalTests` → **delete**. The core gate. |
| [`02-manual-scratch.yml`](02-manual-scratch.yml) | `workflow_dispatch` | Developer self-service org. Optionally deploys source, generates a password, prints credentials to the run summary, and **keeps** the org. |
| [`03-scheduled-credential-check.yml`](03-scheduled-credential-check.yml) | `schedule` (weekday 06:00 UTC) | Provisions and immediately deletes a bare org to prove the JWT credential and Dev Hub capacity still work — before a real PR discovers otherwise. |

## Secrets and variables

All three need the same three repository secrets, and optionally one variable:

| | Name | Notes |
|---|---|---|
| Secret | `SF_CLIENT_ID` | ECA consumer key |
| Secret | `SF_USERNAME` | Integration user the JWT runs as |
| Secret | `SF_JWT_KEY` | Full PEM contents of `server.key` |
| Variable | `SF_LOGIN_URL` | Only for a **sandbox** Dev Hub → `https://test.salesforce.com` |

**→ Full reference, including environment secrets, package installation keys, fork safety and troubleshooting: [`../../docs/secrets-and-variables.md`](../../docs/secrets-and-variables.md)**

## Two things worth copying, whatever you build

**Always delete in `if: always()`.** A failed test must still tear the org down. Scratch orgs count against the Dev Hub's active-org limit, and a pipeline that leaks them wedges within a day or two:

```yaml
      - name: Delete scratch org
        if: always() && steps.scratch.outputs.org_id != ''
        run: node scripts/ci/provision-scratch.mjs delete --org-id "${{ steps.scratch.outputs.org_id }}"
```

**Use `concurrency` on PR workflows.** Without it, three pushes in a minute mean three live orgs for the same PR:

```yaml
concurrency:
  group: scratch-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

## Step outputs

The provision step exposes these for later steps:

| Output | Example |
|---|---|
| `instance_url` | `https://<random-words>-dev-ed.scratch.my.salesforce.com` |
| `username` | `test-xxxxxxxxxxxx@example.com` |
| `org_id` | `00DXXXXXXXXXXXX` (15-char — what `delete` expects) |
| `scratch_org_info_id` | `2SRXXXXXXXXXXXXXXX` |

It also exports `SFDX_ACCESS_TOKEN` into the job environment, which is what lets `sf org login access-token` authenticate without an sfdx auth URL.
