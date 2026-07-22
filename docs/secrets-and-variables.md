# Secrets and variables

Everything the workflows need, where to put it, and how to verify it.

## Required repository secrets

**Settings → Secrets and variables → Actions → Secrets → New repository secret**

| Secret | Value | Where it comes from |
|---|---|---|
| `SF_CLIENT_ID` | The External Client App's **consumer key** | Setup → External Client Apps → your app → **Consumer Key and Secret** |
| `SF_USERNAME` | Username of the integration user the JWT runs as | e.g. `ci@yourcompany.com` — must be pre-authorized on the ECA |
| `SF_JWT_KEY` | **Entire contents** of `server.key`, including the `-----BEGIN…` / `-----END…` lines | The keypair you generated at setup |

Via CLI:

```bash
gh secret set SF_CLIENT_ID  --body "3MVG9..."
gh secret set SF_USERNAME   --body "ci@yourcompany.com"
gh secret set SF_JWT_KEY    < server.key      # reads the file, preserves newlines
```

> Use `< server.key` rather than pasting. A PEM with mangled line breaks fails with a
> confusing signing error rather than an obvious one. (The script also accepts a key whose
> newlines were flattened to `\n`, but the file redirect avoids the question entirely.)

## Optional repository variables

**…→ Variables → New repository variable**

| Variable | Default | Set it when |
|---|---|---|
| `SF_LOGIN_URL` | `https://login.salesforce.com` | Your Dev Hub is a **sandbox** → `https://test.salesforce.com`. A wrong value here is the #1 cause of `invalid_grant`. |

```bash
gh variable set SF_LOGIN_URL --body "https://test.salesforce.com"
```

## Optional: package installation keys

Only if you install **protected** packages. Reference the key by *env var name* in your package config so the key itself never lands in the repo:

```json
{ "packages": [
  { "id": "04t...", "name": "Protected pkg", "installationKeyEnv": "PKG_ACME_KEY" }
] }
```

```bash
gh secret set PKG_ACME_KEY --body "the-installation-key"
```

Then surface it to the step:

```yaml
      - name: Provision scratch org
        env:
          PKG_ACME_KEY: ${{ secrets.PKG_ACME_KEY }}
        run: node scripts/ci/provision-scratch.mjs provision
```

## Repository secrets vs environment secrets

Repository secrets are fine for most teams. Reach for **Environments** when you want approval gates or different credentials per target:

| Use | Choose |
|---|---|
| One Dev Hub, all workflows | **Repository secrets** (simplest) |
| Separate sandbox vs production Dev Hubs | **Environment secrets** — one environment each, same secret names |
| Require a human to approve before an org is created | **Environment** with required reviewers |
| A workflow only some branches may run | **Environment** with a branch protection rule |

To use an environment, name it on the job — the same secret names then resolve to that environment's values:

```yaml
jobs:
  validate:
    runs-on: ubuntu-latest
    environment: salesforce-dev      # <-- secrets/vars resolve from here
    env:
      SF_CLIENT_ID: ${{ secrets.SF_CLIENT_ID }}
```

```bash
gh secret set SF_CLIENT_ID --env salesforce-dev --body "3MVG9..."
```

> Environment secrets **override** repository secrets of the same name for that job, so you
> can keep a repo-level default and override only where it differs.

## Fork safety

Secrets are **not** exposed to workflows triggered by `pull_request` from a fork — by design. A forked PR will fail at the JWT step. If you accept external contributions, either gate on a label with `pull_request_target` (understand the security implications first) or run scratch validation only on branches in your own repo.

## Verify before trusting a pipeline

Confirm the values work locally, using the same three inputs CI will use:

```bash
export SF_CLIENT_ID="3MVG9..."
export SF_USERNAME="ci@yourcompany.com"
export SF_JWT_KEY="$(cat server.key)"
node scripts/ci/provision-scratch.mjs provision
```

A successful run prints the new org's instance URL, username and id. Clean up with:

```bash
node scripts/ci/provision-scratch.mjs delete --org-id <org id>
```

Then confirm what's registered in the repo:

```bash
gh secret list
gh variable list
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `invalid_grant` | Integration user not pre-authorized on the ECA; or `SF_LOGIN_URL` wrong (sandbox needs `test.salesforce.com`); or the cert on the ECA doesn't match `SF_JWT_KEY`. |
| `Could not sign the JWT with SF_JWT_KEY` | The secret isn't a valid PEM — usually mangled newlines from pasting. Re-set it with `gh secret set SF_JWT_KEY < server.key`. |
| `REQUIRED_FIELD_MISSING [ConnectedAppConsumerKey…]` | You're calling the API without the pin. The script always sends both required fields. |
| `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` | A bad `securityType` / `nameConflictResolution` in your package config — see the allowed values in [scratch-org-ci.md](scratch-org-ci.md#installing-packages-after-provisioning). |
| Secrets appear empty in a PR run | The PR is from a **fork** — see Fork safety above. |
