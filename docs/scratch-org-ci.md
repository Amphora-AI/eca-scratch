# Scratch-org CI without a Connected App

Provisions scratch orgs in CI using an **External Client App + JWT bearer** for Dev Hub auth — no classic Connected App, no `sf org login web`, and **no stored sfdx auth URL**.

## The problem this solves

Per [forcedotcom/cli#3515](https://github.com/forcedotcom/cli/issues/3515) (open since March 2026, `investigating`/`validated`, no fix): once you authenticate a Dev Hub with an ECA via JWT bearer, `sf org login jwt` succeeds but **`sf org create scratch` always fails**:

> We encountered a problem while attempting to configure and approve the Connected App
> for your org. Verify the Connected App configuration with your Salesforce admin.

That's error **C-1016**. Salesforce's "Proxy Signup" step tries to replicate *the session's* Connected App into the new scratch; an ECA has no equivalent, so signup dies. Salesforce's own guidance in that thread is to **open a support case per Dev Hub** to re-enable classic Connected App creation — which doesn't scale (one commenter filed for 60 production orgs; another described needing "a case every time we want to integrate new orgs with CI/CD").

## How this works around it

Signup only fails because it *derives* its app from the session. So don't let it: insert the `ScratchOrgInfo` record directly and pin

```
ConnectedAppConsumerKey = 'PlatformCLI'
```

`PlatformCLI` is Salesforce's own built-in CLI app — it already exists in every org, so signup merely **references** it and never tries to **create** anything. C-1016 can't fire. The `sf` CLI offers no flag for this, which is why the signup is done over REST here.

You keep the ECA + JWT service credential *and* get working scratch creation — normally mutually exclusive.

Flow: mint JWT → Dev Hub access token → insert `ScratchOrgInfo` (pinned) → poll to `Active` → exchange the signup `AuthCode` for the scratch's tokens → hand the CLI an access token.

Teardown deletes the `ActiveScratchOrg` record over REST, so it also avoids the CLI's `sf org delete scratch` (which has the same Connected App dependency).

## Files

Copy these two into the target repo:

| In `eca-scratch` | Put it at in the target repo |
|---|---|
| `scripts/ci/provision-scratch.mjs` | `scripts/ci/provision-scratch.mjs` *(same path — no edits needed)* |
| `examples/workflows/01-pr-validation.yml` | `.github/workflows/pr-validation.yml` |

The script path matches deliberately, so the workflow template works as-is.

Zero dependencies — `node:crypto` + global `fetch`. Needs Node 18+; the workflows pin Node 24.

`test/verify.mjs` stays in this repo; it exercises the provisioner against a mock Salesforce and needs no org or secrets. Re-run it after changing the script.

## One-time setup

**1. Generate a keypair** (keep `server.key` secret; upload `server.crt`):

```bash
openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 \
  -keyout server.key -out server.crt -subj "/CN=ci-scratch-provisioning"
```

**2. Create the External Client App** in the Dev Hub — Setup → **External Client Apps** → New.
- Enable OAuth. Scopes: **api**, **refresh_token/offline_access**, **web**.
- Callback URL: any valid value (JWT never redirects) — `http://localhost:1717/OauthRedirect` is fine.
- Enable **JWT Bearer Flow** and upload `server.crt`. On an External Client App this lives under **Flow Enablement → Enable JWT Bearer Flow → Certificate Upload**, *not* in OAuth Settings — there is no "Use digital signatures" checkbox like a classic Connected App has.

**3. Pre-authorize the integration user** — this is the step people miss, and it surfaces as a generic `invalid_grant`:
- In the ECA's OAuth policies set **Permitted Users → Admin approved users are pre-authorized**.
- Assign the app to that user's profile or a permission set.
- The user needs the **Create and Manage Scratch Orgs** permission (and Dev Hub enabled on the org).

**4. Add repo secrets** — `SF_CLIENT_ID`, `SF_USERNAME`, `SF_JWT_KEY`, plus the optional `SF_LOGIN_URL` variable for sandbox Dev Hubs.

**→ Full reference (repo vs environment secrets, installation keys, fork safety, troubleshooting): [`secrets-and-variables.md`](secrets-and-variables.md)**

## Installing packages after provisioning

A bare scratch often isn't usable yet — most notably it needs the **ECA package installed** so later `sf project retrieve start` / `sf project deploy start` calls can authenticate against it. Packages are installed into the new org, **in order**, before the script exits.

Create `config/scratch-packages.json` (start from [`examples/scratch-packages.json`](../examples/scratch-packages.json)):

```json
{
  "packages": [
    { "id": "04tXXXXXXXXXXXXXXX", "name": "Your ECA package" },
    { "id": "04tYYYYYYYYYYYYYYY", "name": "Protected pkg", "installationKeyEnv": "PKG_KEY", "optional": true }
  ]
}
```

| Field | Default | Notes |
|---|---|---|
| `id` | — | Subscriber package **version** id (`04t…`). A bare string works too: `["04t…"]`. |
| `name` | the id | Label for logs only. |
| `installationKeyEnv` | — | Reads the installation key from that env var, so keys are never committed. `installationKey` also works for non-secret cases. |
| `securityType` | `None` | Restricted picklist: `Full` (all users) \| `None` (**admins only** — the default) \| `Custom` (specific profiles) \| `Push`. Anything else is rejected with `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`. |
| `nameConflictResolution` | `Block` | Restricted picklist: `Block` \| `RenameMetadata` \| `RenameAllForTest`. |
| `optional` | `false` | `true` downgrades a failure to a warning. |

> **There is no `AdminsOnly`.** `securityType` is a restricted picklist — `AdminsOnly` looks like the natural spelling for admins-only but is rejected with `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`. The value you want is **`None`**. Because installs here are required by default the script fails loudly, but in a best-effort install path this error is easy to miss entirely.

**Order matters** — installs run sequentially, so list dependencies before dependents.

**Required by default.** A failed install stops the pipeline. That's deliberate and differs from a user-facing provisioning flow: a silently-skipped ECA doesn't look like a missing package later, it looks like a baffling retrieve/deploy auth error several steps down the run. Failing here reports the real reason. Use `"optional": true` where you genuinely can tolerate it.

**Resolution precedence** (first match wins):

1. `SCRATCH_INSTALL_PACKAGES` — comma-separated `04t` ids, all treated as required. Handy for a one-off `workflow_dispatch`.
2. `config/scratch-packages.json` — override the path with `SCRATCH_PACKAGES_PATH`.
3. `installPackages: ["04t…"]` inside the scratch definition.

Set `SCRATCH_SKIP_PACKAGES=true` to bypass entirely. Tune long installs with `PKG_POLL_INTERVAL_MS` (default 10 s) and `PKG_POLL_TIMEOUT_MS` (default 12 min).

> The scratch's `org_id` is emitted **before** installs run, so a failed install still lets
> the teardown step delete the org rather than leaking it against the Dev Hub's active-org
> limit.

## Verify locally before trusting CI

```bash
export SF_CLIENT_ID=... SF_USERNAME=... SF_JWT_KEY="$(cat server.key)"
node scripts/ci/provision-scratch.mjs provision
```

If you want to smoke-test the signup flow *before* standing up the ECA + certificate, you can hand it an already-authenticated Dev Hub session instead of a JWT:

```bash
export SF_INSTANCE_URL=https://your-devhub.my.salesforce.com
export SF_ACCESS_TOKEN=<a valid Dev Hub access token>
node scripts/ci/provision-scratch.mjs provision
```

`SF_ACCESS_TOKEN` + `SF_INSTANCE_URL` short-circuit the JWT mint. Use it for local testing only — access tokens are short-lived, and not depending on a human's session is the whole point of the JWT path in CI.

It prints the instance URL / username / org id. Clean up with:

```bash
node scripts/ci/provision-scratch.mjs delete --org-id <org id from above>
```

## Known limits — read before shipping

- **`settings` / `objectSettings` are not applied.** They aren't `ScratchOrgInfo` fields, so no client can send them at signup (the CLI applies them afterwards via a metadata deploy). The script warns when your definition contains them. If your tests depend on org settings, add a post-signup metadata deploy step.
- **This is a workaround, not a supported contract.** `PlatformCLI` is Salesforce's own published client id, so you're doing what the CLI does — but *decoupling signup from the session* isn't a documented API. If Proxy Signup changes, this breaks. Keep the support-case path (re-enable Connected App creation on that Dev Hub) as the sanctioned fallback, and watch #3515 for a real fix.
- **Cert rotation** becomes a runbook item — `days 3650` above is deliberately long; shorten it if your security policy requires.
- **Scratch org limits.** Dev Hub daily-signup and active-org caps will throttle a busy PR pipeline. Check `sf limits api display`/the Dev Hub's limits before promising an org per PR.
- **Access-token lifetime.** The scratch access token follows the org's session policy (commonly ~2h). Fine for a normal CI run; long jobs may need a re-mint.
