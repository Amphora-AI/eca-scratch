# eca-scratch

Create Salesforce scratch orgs from CI when your Dev Hub is authenticated with an **External Client App** — working around error **C-1016** ([forcedotcom/cli#3515](https://github.com/forcedotcom/cli/issues/3515)).

Uses **ECA + JWT bearer**: a real service credential, with **no classic Connected App**, **no `sf org login web`**, and **no stored sfdx auth URL**.

This exists because of [forcedotcom/cli#3515](https://github.com/forcedotcom/cli/issues/3515): once a Dev Hub is authenticated with an ECA via JWT, `sf org login jwt` succeeds but `sf org create scratch` **always** fails with **C-1016**. Salesforce's own guidance is to file a support case per Dev Hub to re-enable classic Connected App creation — which doesn't scale (one commenter filed for 60 production orgs). The issue has been open since March 2026 with no fix.

The workaround: insert the `ScratchOrgInfo` record yourself and pin `ConnectedAppConsumerKey = 'PlatformCLI'` — Salesforce's built-in CLI app, which already exists in every org, so signup only *references* it and never tries to *create* anything.

The reason this works is structural. `sf org create scratch` supplies the signup app **implicitly, from the session** — so an ECA session hands Proxy Signup something it has no way to replicate. The API, by contrast, **requires** you to name the app explicitly (omit it and the insert fails with `REQUIRED_FIELD_MISSING`), so it can never inherit the ECA. The CLI exposes no flag to override this, which is why signup is done over REST.

**→ Full setup, secrets, and known limits: [`docs/scratch-org-ci.md`](docs/scratch-org-ci.md)**

| Path | What it is |
|---|---|
| [`scripts/ci/provision-scratch.mjs`](scripts/ci/provision-scratch.mjs) | The provisioner. Zero dependencies (needs Node 18+; CI runs 24). `provision` and `delete` modes. |
| [`examples/workflows/`](examples/workflows/) | **Baseline workflows** — PR validation, developer self-service org, nightly credential check. |
| [`examples/scratch-packages.json`](examples/scratch-packages.json) | Template for the post-provision package list (see below). |
| [`docs/scratch-org-ci.md`](docs/scratch-org-ci.md) | ECA/JWT setup, package framework, troubleshooting, limits. |
| [`docs/secrets-and-variables.md`](docs/secrets-and-variables.md) | **Which secrets/variables to set**, repo vs environment, fork safety. |
| [`test/verify.mjs`](test/verify.mjs) | Verification harness (see below). |

## Post-provision package installs

A bare scratch usually isn't usable yet — it typically needs the **ECA package installed** so later `sf project retrieve start` / `deploy start` calls can authenticate against it. List packages in `config/scratch-packages.json` and they're installed **in order**, immediately after provisioning, before the script exits:

```json
{ "packages": [ { "id": "04tXXXXXXXXXXXXXXX", "name": "Your ECA package" } ] }
```

Supports installation keys via env indirection (`installationKeyEnv`), `securityType` / `nameConflictResolution` overrides, and `"optional": true`. **Required by default** — a failed install stops the pipeline rather than surfacing later as a confusing auth error. Also resolvable from `SCRATCH_INSTALL_PACKAGES` (comma-separated ids) or an `installPackages` array in the scratch definition. Full reference in [`docs/scratch-org-ci.md`](docs/scratch-org-ci.md#installing-packages-after-provisioning).

## Adding it to a project

```bash
mkdir -p scripts/ci .github/workflows
curl -sL https://raw.githubusercontent.com/Amphora-AI/eca-scratch/main/scripts/ci/provision-scratch.mjs \
  -o scripts/ci/provision-scratch.mjs
curl -sL https://raw.githubusercontent.com/Amphora-AI/eca-scratch/main/examples/workflows/01-pr-validation.yml \
  -o .github/workflows/pr-validation.yml
```

Then follow [`docs/scratch-org-ci.md`](docs/scratch-org-ci.md) for the one-time ECA setup, and [`docs/secrets-and-variables.md`](docs/secrets-and-variables.md) for the three repo secrets (`SF_CLIENT_ID`, `SF_USERNAME`, `SF_JWT_KEY`) plus the optional `SF_LOGIN_URL` variable.

More starting points — developer self-service orgs and a nightly credential check — are in [`examples/workflows/`](examples/workflows/).

The paths line up deliberately: `scripts/ci/provision-scratch.mjs` here is where it goes in the target repo too, so the workflow template needs no edits.

## Verification

`test/verify.mjs` runs the provisioner end-to-end against a mock Salesforce that **cryptographically verifies the JWT assertion with the public key** and asserts the `PlatformCLI` pin is actually sent. It covers signing, the signup insert, the wait loop, the AuthCode exchange, teardown, and failure handling — everything except the live Salesforce handshake.

```bash
node test/verify.mjs
```

Runs on every push/PR here via [`.github/workflows/eca-scratch-test.yml`](.github/workflows/eca-scratch-test.yml). No secrets and no org required.

> The mock proves the logic; only a real run proves your ECA is configured correctly. Do one
> local run against the actual Dev Hub before trusting a real pipeline — the command is in
> the docs.

### What has and hasn't been proven

Stated plainly so you can judge the risk yourself.

**Verified end to end against a real Dev Hub, using JWT bearer on a real External Client App.** This is the exact scenario in the issue title — same org, same user, same Dev Hub, same JWT-bound ECA session. The only variable is *how the signup Connected App is supplied*:

| | Path | Signup app | Result |
|---|---|---|---|
| **Control** | `sf org create scratch` | implicit, from the session | ❌ **C-1016** — *"We encountered a problem while attempting to configure and approve the Connected App for your org."* |
| **Treatment** | `provision-scratch.mjs` | explicit: `PlatformCLI` | ✅ **`Status = Active`** — real scratch org, tokens issued |

The treatment run was this script, not a hand-rolled REST call: JWT auth → pinned `ScratchOrgInfo` insert → poll to `Active` → `AuthCode` exchanged for the scratch's own `access_token`/`refresh_token` → outputs emitted. Its `delete` mode was then used to tear the org down. All against production Salesforce.

### Why the pin works

The `ScratchOrgInfo` API **always requires** both `ConnectedAppConsumerKey` and `ConnectedAppCallbackUrl` — omit them and the insert fails with `REQUIRED_FIELD_MISSING`. There is no "unpinned" variant. That's exactly why this path is immune: `sf org create scratch` supplies the signup app *implicitly, from the session*, so an ECA session hands Proxy Signup something it cannot replicate. Driving the API forces you to name the app explicitly, so it can never inherit the ECA.

**Still not covered by a live run:** the GitHub Actions workflow end to end — the script it calls is verified against a real org, but the wiring around it isn't. It's covered by the mock's 108 checks.

## Platform gotchas

Three things that cost us real time. Every one was found by running against a live org — the mock accepted all three quite happily, which is the point.

### The JWT certificate isn't in OAuth Settings

On an External Client App the certificate upload lives under **Flow Enablement → Enable JWT Bearer Flow → Certificate Upload**, further down the page. There's no "Use digital signatures" checkbox like a classic Connected App has, and no certificate field is exposed on any `ExtlClntApp*` Tooling object — so it can look like ECAs don't support JWT at all when they do.

### `ConnectedAppConsumerKey` requires `ConnectedAppCallbackUrl`

Send one without the other and signup is rejected before it starts:

```
Required fields are missing: [ConnectedAppCallbackUrl]   [REQUIRED_FIELD_MISSING]
```

They're a pair. The callback also has to match the `redirect_uri` you later use to exchange the `AuthCode`.

### There is no `SecurityType: "AdminsOnly"`

`PackageInstallRequest.SecurityType` is a **restricted picklist** accepting only `Full` (all users), `None` (**admins only**), `Custom` (specific profiles) and `Push`. `AdminsOnly` reads like the obvious spelling for admins-only, and doesn't exist:

```
Security Type: bad value for restricted picklist field: AdminsOnly
[INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST]
```

The broader trap is worth more than the literal value. If your install path is best-effort — warn and continue, which is defensible since an install can take minutes — this failure is **invisible**. Ours shipped that way and silently installed nothing at all until a live run caught it. So: validate the value up front, and make your mock reject what the API rejects, or a fully green test suite will keep telling you a dead feature works.

`NameConflictResolution` is restricted too: `Block`, `RenameMetadata`, `RenameAllForTest`.

## Status

The pin is a **workaround, not a supported contract**. `PlatformCLI` is Salesforce's own published client id, so we're doing what the CLI does — but decoupling signup from the session isn't a documented API. Watch #3515; if Salesforce ships ECA support for scratch creation, this should be retired in favour of the stock command.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it.

## Contributing

**Issues are open; pull requests aren't being accepted right now** — see [CONTRIBUTING.md](CONTRIBUTING.md). Forking is enabled and encouraged (MIT, no attribution required).

The single most useful thing you can file: **did this work against your Dev Hub?** It's verified end to end against exactly one real org, so a second data point either strengthens the workaround or exposes an assumption in ours. Please say so even if it just worked.
