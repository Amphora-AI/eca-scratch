#!/usr/bin/env node
/**
 * Headless scratch-org provisioning for CI — JWT service credential, no sfdx auth URL.
 *
 * WHY THIS EXISTS
 * ---------------
 * The usual CI recipe (JWT bearer + a classic Connected App) is blocked on orgs where
 * Salesforce has disabled Connected App creation (Spring '26 deprecation). The natural
 * successor — an External Client App (ECA) — authenticates fine, but then
 * `sf org create scratch` fails with C-1016:
 *
 *   "We encountered a problem while attempting to configure and approve the Connected
 *    App for your org."
 *
 * That's Salesforce's "Proxy Signup" step trying to replicate the *session's* app into
 * the new scratch. It has no ECA equivalent, so it dies.
 *
 * The fix: stop letting signup derive its app from the session. We insert the
 * `ScratchOrgInfo` record directly and pin
 *
 *   ConnectedAppConsumerKey = 'PlatformCLI'
 *
 * — Salesforce's own built-in CLI app, which already exists in every org. Signup only
 * ever *references* it, never *creates* anything, so C-1016 can't fire. The `sf` CLI
 * gives you no way to express this: it always derives signup from the session.
 *
 * Net result: a proper JWT service credential for the Dev Hub AND working scratch
 * creation — normally mutually exclusive.
 *
 * USAGE
 *   node provision-scratch.mjs provision
 *   node provision-scratch.mjs delete --org-id 00D...
 *
 * REQUIRED ENV
 *   SF_CLIENT_ID   ECA consumer key (the `iss` claim)
 *   SF_USERNAME    Integration user the ECA is pre-authorized for (`sub` claim)
 *   SF_JWT_KEY     PEM private key (contents, not a path) matching the cert on the ECA
 *
 * OPTIONAL ENV
 *   SF_LOGIN_URL          default https://login.salesforce.com (sandbox: https://test.salesforce.com)
 *   SCRATCH_DEF_PATH      default config/project-scratch-def.json
 *   SCRATCH_DURATION_DAYS default 1
 *   SF_API_VERSION        default v67.0
 *   POLL_INTERVAL_MS      default 5000
 *   POLL_TIMEOUT_MS       default 480000 (8 min)
 *
 * POST-SIGNUP PACKAGE INSTALLS
 *   Packages are installed into the new scratch, in order, before the script exits — this
 *   is where an ECA package goes so later `sf project retrieve/deploy start` calls work.
 *   Sources, highest precedence first:
 *     1. SCRATCH_INSTALL_PACKAGES  comma-separated 04t ids (all treated as required)
 *     2. config/scratch-packages.json  (override path with SCRATCH_PACKAGES_PATH)
 *     3. `installPackages` array in the scratch definition
 *   Set SCRATCH_SKIP_PACKAGES=true to bypass entirely.
 *
 *   PKG_POLL_INTERVAL_MS  default 10000
 *   PKG_POLL_TIMEOUT_MS   default 720000 (12 min)
 *
 * Zero dependencies — node:crypto + global fetch. Needs Node 18+; CI runs Node 24.
 */

import { createSign } from 'node:crypto';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const API = process.env.SF_API_VERSION || 'v67.0';
const LOGIN_URL = (process.env.SF_LOGIN_URL || 'https://login.salesforce.com').replace(/\/+$/, '');
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5_000;
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS) || 8 * 60 * 1000;
const PKG_POLL_INTERVAL_MS = Number(process.env.PKG_POLL_INTERVAL_MS) || 10_000;
const PKG_POLL_TIMEOUT_MS = Number(process.env.PKG_POLL_TIMEOUT_MS) || 12 * 60 * 1000;

/** Salesforce's built-in CLI Connected App. Present in every org — never created. */
const PLATFORM_CLI = 'PlatformCLI';
/** The loopback the PlatformCLI app registers; must match at code exchange. */
const PLATFORM_CLI_CALLBACK = 'http://localhost:1717/OauthRedirect';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (input) => Buffer.from(input).toString('base64url');

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) die(`Missing required env var ${name}`);
  return v;
}

/** Mask a secret in GitHub Actions logs (no-op elsewhere). */
function mask(value) {
  if (value && process.env.GITHUB_ACTIONS) console.log(`::add-mask::${value}`);
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function exportEnv(key, value) {
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
}

/** Best-effort human message out of a Salesforce error body. */
function sfError(body) {
  if (!body) return 'unknown error';
  try {
    const p = JSON.parse(body);
    if (Array.isArray(p) && p[0]?.message) return `${p[0].message}${p[0].errorCode ? ` [${p[0].errorCode}]` : ''}`;
    if (p?.message) return String(p.message);
    if (p?.error_description) return String(p.error_description);
    if (p?.error) return String(p.error);
  } catch { /* not JSON */ }
  return body.slice(0, 400);
}

/**
 * Mint a Dev Hub access token via the JWT bearer flow.
 *
 * No refresh token is involved and nothing long-lived is stored: the assertion is
 * signed fresh each run from the private key. That's the whole point of avoiding a
 * stored sfdx auth URL — this credential is not bound to a human's session.
 */
async function getDevHubToken() {
  // Escape hatch: use an already-authenticated Dev Hub session instead of minting a JWT.
  // Handy for smoke-testing locally before standing up the ECA + certificate, e.g.
  //   export SF_INSTANCE_URL=$(sf org display -o <hub> --json | jq -r .result.instanceUrl)
  //   export SF_ACCESS_TOKEN=$(sf org display -o <hub> --json | jq -r .result.accessToken)
  // CI should use the JWT path below — an access token is short-lived and the whole point
  // of JWT is not depending on a human's session.
  const presetToken = process.env.SF_ACCESS_TOKEN;
  const presetInstance = process.env.SF_INSTANCE_URL;
  if (presetToken && presetInstance) {
    mask(presetToken);
    console.log('  (using SF_ACCESS_TOKEN / SF_INSTANCE_URL — skipping the JWT mint)');
    return { accessToken: presetToken, instanceUrl: presetInstance.replace(/\/+$/, '') };
  }

  const clientId = requireEnv('SF_CLIENT_ID');
  const username = requireEnv('SF_USERNAME');
  const privateKey = requireEnv('SF_JWT_KEY').replace(/\\n/g, '\n');

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: clientId,
    sub: username,
    aud: LOGIN_URL,
    exp: Math.floor(Date.now() / 1000) + 180,
  }));
  const signingInput = `${header}.${claims}`;

  let signature;
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  } catch (err) {
    die(`Could not sign the JWT with SF_JWT_KEY — is it a valid PEM private key? (${err.message})`);
  }
  const assertion = `${signingInput}.${b64url(signature)}`;

  const res = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    // The two overwhelmingly common causes, called out so CI logs are actionable.
    const hint = text.includes('invalid_grant')
      ? '\n  → invalid_grant usually means: the integration user is not pre-authorized on the ECA '
        + '(set "Admin approved users are pre-authorized" + assign the profile/permset), '
        + 'or SF_LOGIN_URL is wrong (use https://test.salesforce.com for sandboxes), '
        + 'or the cert on the ECA does not match SF_JWT_KEY.'
      : '';
    die(`Dev Hub JWT auth failed (${res.status}): ${sfError(text)}${hint}`);
  }
  const json = JSON.parse(text);
  mask(json.access_token);
  return { accessToken: json.access_token, instanceUrl: json.instance_url.replace(/\/+$/, '') };
}

/**
 * Map a scratch-definition file onto creatable ScratchOrgInfo fields.
 *
 * NOTE: `settings` and `objectSettings` are NOT ScratchOrgInfo fields — they cannot be
 * sent at signup by any client (the CLI applies them afterwards via a metadata deploy).
 * We warn loudly rather than silently dropping them.
 */
function buildPayload(def, durationDays) {
  const features = Array.isArray(def.features) ? def.features.join(';') : def.features;

  const payload = {
    ConnectedAppConsumerKey: PLATFORM_CLI, // ← the pin that sidesteps C-1016
    // Required whenever ConnectedAppConsumerKey is set — Salesforce rejects the insert
    // with REQUIRED_FIELD_MISSING [ConnectedAppCallbackUrl] otherwise. Must match the
    // redirect_uri used at the AuthCode exchange below.
    ConnectedAppCallbackUrl: PLATFORM_CLI_CALLBACK,
    Edition: def.edition || 'Developer',
    DurationDays: durationDays,
  };

  if (def.orgName) payload.OrgName = def.orgName;
  if (features) payload.Features = features;
  if (def.adminEmail) payload.AdminEmail = def.adminEmail;
  if (def.country) payload.Country = def.country;
  if (def.language) payload.Language = def.language;
  if (def.description) payload.Description = def.description;
  if (def.release) payload.Release = def.release;
  if (def.sourceOrg) payload.SourceOrg = def.sourceOrg;
  if (def.namespace) payload.NamespacePrefix = def.namespace;
  if (typeof def.hasSampleData === 'boolean') payload.HasSampleData = def.hasSampleData;

  if (def.settings || def.objectSettings) {
    console.warn(
      '⚠ scratch definition contains `settings`/`objectSettings`. These are not signup '
      + 'fields and are NOT applied by this script. Apply them post-signup with a metadata '
      + 'deploy (or `sf project deploy start`) if your tests depend on them.',
    );
  }
  return payload;
}

async function sfFetch(instanceUrl, accessToken, path, init = {}) {
  const res = await fetch(`${instanceUrl}/services/data/${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  return { res, text: await res.text() };
}

/* ------------------------------------------------------------------ *
 * Post-signup package installs
 * ------------------------------------------------------------------ */

/** Normalize one entry from any supported source into a common shape. */
function normalizePackage(entry) {
  const raw = typeof entry === 'string' ? { id: entry } : { ...entry };
  const id = String(raw.id || raw.versionId || raw.SubscriberPackageVersionKey || '').trim();
  if (!id) return null;

  // Installation keys are secrets — prefer indirection through an env var so they are
  // never committed to the repo.
  let installationKey = raw.installationKey;
  if (!installationKey && raw.installationKeyEnv) {
    installationKey = process.env[raw.installationKeyEnv];
    if (!installationKey) {
      console.warn(`⚠ ${raw.installationKeyEnv} is not set — attempting ${id} without an installation key`);
    }
  }
  if (installationKey) mask(installationKey);

  const SECURITY_TYPES = ['Full', 'None', 'Custom', 'Push'];
  const CONFLICT_MODES = ['RenameAllForTest', 'RenameMetadata', 'Block'];
  if (raw.securityType && !SECURITY_TYPES.includes(raw.securityType)) {
    die(`Invalid securityType "${raw.securityType}" for ${id}. Allowed: ${SECURITY_TYPES.join(' | ')} `
      + '(use "None" for admins-only).');
  }
  if (raw.nameConflictResolution && !CONFLICT_MODES.includes(raw.nameConflictResolution)) {
    die(`Invalid nameConflictResolution "${raw.nameConflictResolution}" for ${id}. `
      + `Allowed: ${CONFLICT_MODES.join(' | ')}`);
  }

  return {
    id,
    name: raw.name || id,
    installationKey: installationKey || undefined,
    // Salesforce restricted picklists — invalid values are rejected outright with
    // INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST. SecurityType: Full (all users) | None
    // (admins only) | Custom (specific profiles) | Push. There is no "AdminsOnly".
    securityType: raw.securityType || 'None',
    nameConflictResolution: raw.nameConflictResolution || 'Block',
    optional: raw.optional === true,
  };
}

/**
 * Resolve the ordered package list. Precedence: env var → config file → scratch definition.
 * Order within a source is preserved — list dependencies before dependents.
 */
function resolvePackages(def) {
  if (String(process.env.SCRATCH_SKIP_PACKAGES || '').toLowerCase() === 'true') {
    console.log('→ SCRATCH_SKIP_PACKAGES=true — skipping package installs');
    return [];
  }

  const envList = (process.env.SCRATCH_INSTALL_PACKAGES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (envList.length) return envList.map(normalizePackage).filter(Boolean);

  const cfgPath = process.env.SCRATCH_PACKAGES_PATH || 'config/scratch-packages.json';
  if (existsSync(cfgPath)) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    } catch (err) {
      die(`Could not parse ${cfgPath}: ${err.message}`);
    }
    const list = Array.isArray(cfg) ? cfg : (cfg.packages || []);
    return list.map(normalizePackage).filter(Boolean);
  }

  const fromDef = Array.isArray(def?.installPackages) ? def.installPackages : [];
  return fromDef.map(normalizePackage).filter(Boolean);
}

/** Best-effort message out of a PackageInstallRequest.Errors payload (shape varies). */
function packageErrors(errors) {
  if (!errors) return 'unknown error';
  if (typeof errors === 'string') return errors;
  const list = Array.isArray(errors)
    ? errors
    : (Array.isArray(errors.errors) ? errors.errors : []);
  const first = list.find((e) => e?.message);
  if (first?.message) return first.message;
  return JSON.stringify(errors).slice(0, 300);
}

/** Create + poll a single Tooling PackageInstallRequest. Throws on any failure. */
async function installOnePackage(instanceUrl, accessToken, pkg) {
  const base = `${instanceUrl}/services/data/${API}/tooling/sobjects/PackageInstallRequest`;
  const payload = {
    SubscriberPackageVersionKey: pkg.id,
    SecurityType: pkg.securityType,
    NameConflictResolution: pkg.nameConflictResolution,
  };
  if (pkg.installationKey) payload.Password = pkg.installationKey;

  const res = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`install request rejected (${res.status}): ${sfError(text)}`);
  const requestId = JSON.parse(text)?.id;
  if (!requestId) throw new Error('install request returned no id');

  const startedAt = Date.now();
  for (;;) {
    const poll = await fetch(`${base}/${requestId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const pollText = await poll.text();
    if (!poll.ok) throw new Error(`install status query failed (${poll.status}): ${sfError(pollText)}`);
    const rec = JSON.parse(pollText);
    if (rec.Status === 'SUCCESS') return;
    if (rec.Status === 'ERROR') throw new Error(`install ended in ERROR: ${packageErrors(rec.Errors)}`);
    if (Date.now() - startedAt > PKG_POLL_TIMEOUT_MS) {
      throw new Error(`install timed out after ${Math.round(PKG_POLL_TIMEOUT_MS / 1000)}s `
        + `(last status: ${rec.Status})`);
    }
    await sleep(PKG_POLL_INTERVAL_MS);
  }
}

/**
 * Install every resolved package, in order.
 *
 * CI FAILS HARD by default — deliberately different from a user-facing provisioning flow.
 * A silently-skipped package (the ECA especially) doesn't look like a missing package
 * later; it looks like a baffling retrieve/deploy auth error three steps down the
 * pipeline. Better to stop here with the real reason. Mark an entry `"optional": true`
 * to downgrade it to a warning.
 *
 * Sequential on purpose: package dependencies must land before their dependents.
 */
async function installPackages(instanceUrl, accessToken, packages) {
  if (!packages.length) return;
  console.log(`→ Installing ${packages.length} package(s) into the scratch…`);
  for (const pkg of packages) {
    const label = pkg.name === pkg.id ? pkg.id : `${pkg.name} (${pkg.id})`;
    try {
      await installOnePackage(instanceUrl, accessToken, pkg);
      console.log(`  ✓ ${label}`);
    } catch (err) {
      if (pkg.optional) {
        console.warn(`  ⚠ optional package ${label} failed: ${err.message}`);
      } else {
        die(`Package install failed for ${label}: ${err.message}\n`
          + '  → if the pipeline should tolerate this, mark it "optional": true');
      }
    }
  }
}

async function provision() {
  const defPath = process.env.SCRATCH_DEF_PATH || 'config/project-scratch-def.json';
  const durationDays = Number(process.env.SCRATCH_DURATION_DAYS) || 1;

  let def;
  try {
    def = JSON.parse(readFileSync(defPath, 'utf8'));
  } catch (err) {
    die(`Could not read scratch definition at ${defPath}: ${err.message}`);
  }

  console.log('→ Authenticating Dev Hub (JWT bearer)…');
  const { accessToken, instanceUrl } = await getDevHubToken();
  console.log(`  ✓ Dev Hub: ${instanceUrl}`);

  const payload = buildPayload(def, durationDays);
  console.log(`→ Inserting ScratchOrgInfo (ConnectedAppConsumerKey=${PLATFORM_CLI}, ${durationDays}d)…`);
  const { res: insRes, text: insText } = await sfFetch(instanceUrl, accessToken, '/sobjects/ScratchOrgInfo', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!insRes.ok) die(`ScratchOrgInfo insert failed (${insRes.status}): ${sfError(insText)}`);
  const infoId = JSON.parse(insText)?.id;
  if (!infoId) die('ScratchOrgInfo insert returned no id');
  console.log(`  ✓ ScratchOrgInfo ${infoId}`);

  console.log('→ Waiting for signup to complete…');
  const soql = 'SELECT Status, ErrorCode, AuthCode, LoginUrl, SignupUsername, ScratchOrg '
    + `FROM ScratchOrgInfo WHERE Id = '${infoId}'`;
  const startedAt = Date.now();
  let record;
  for (;;) {
    const { res, text } = await sfFetch(instanceUrl, accessToken, `/query?q=${encodeURIComponent(soql)}`);
    if (!res.ok) die(`ScratchOrgInfo poll failed (${res.status}): ${sfError(text)}`);
    record = JSON.parse(text)?.records?.[0];
    if (!record) die(`ScratchOrgInfo ${infoId} disappeared`);
    if (record.Status === 'Active') break;
    if (record.Status === 'Error') {
      die(`Scratch signup failed: ${record.ErrorCode || 'unknown error'}`);
    }
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      die(`Timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s (last status: ${record.Status})`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.log(`  ✓ Active — ${record.SignupUsername}`);

  // Exchange the signup AuthCode for the scratch's own tokens, against PlatformCLI
  // (a public client — no secret). redirect_uri must match what signup registered.
  console.log('→ Exchanging AuthCode for scratch tokens…');
  if (!record.AuthCode || !record.LoginUrl) die('Scratch became Active but returned no AuthCode/LoginUrl');
  const tokenUrl = `${record.LoginUrl.replace(/\/+$/, '')}/services/oauth2/token`;
  const tokRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: record.AuthCode,
      client_id: PLATFORM_CLI,
      redirect_uri: PLATFORM_CLI_CALLBACK,
    }),
  });
  const tokText = await tokRes.text();
  if (!tokRes.ok) die(`Scratch token exchange failed (${tokRes.status}): ${sfError(tokText)}`);
  const tokens = JSON.parse(tokText);
  if (!tokens.access_token || !tokens.instance_url) die('Token exchange returned no access_token/instance_url');
  mask(tokens.access_token);
  mask(tokens.refresh_token);

  const scratchInstance = tokens.instance_url.replace(/\/+$/, '');
  console.log(`  ✓ Scratch ready: ${scratchInstance}`);

  // Downstream steps authenticate with the access token — no sfdx auth URL anywhere.
  //
  // These are written BEFORE package installs on purpose: the org now exists and counts
  // against the Dev Hub's active-org limit, so `org_id` must be available to the teardown
  // step even if an install fails below. Writing them afterwards would leak the scratch on
  // every failed install.
  exportEnv('SFDX_ACCESS_TOKEN', tokens.access_token);
  setOutput('instance_url', scratchInstance);
  setOutput('username', record.SignupUsername);
  setOutput('org_id', record.ScratchOrg);
  setOutput('scratch_org_info_id', infoId);

  // Post-signup installs (e.g. the ECA package that later `sf project retrieve/deploy
  // start` calls depend on).
  await installPackages(scratchInstance, tokens.access_token, resolvePackages(def));

  if (!process.env.GITHUB_OUTPUT) {
    console.log('\n--- not in GitHub Actions; values below ---');
    console.log(`instance_url = ${scratchInstance}`);
    console.log(`username     = ${record.SignupUsername}`);
    console.log(`org_id       = ${record.ScratchOrg}`);
  }
}

/**
 * Delete a scratch by removing its ActiveScratchOrg record in the Dev Hub.
 * Run this in an `if: always()` step — leaked scratches burn the Dev Hub's
 * active-org limit and will wedge the pipeline within a day or two.
 */
async function deleteScratch(orgId) {
  if (!orgId) die('delete requires --org-id <15-or-18-char scratch org id>');
  const short = orgId.slice(0, 15);

  console.log('→ Authenticating Dev Hub (JWT bearer)…');
  const { accessToken, instanceUrl } = await getDevHubToken();

  const soql = `SELECT Id FROM ActiveScratchOrg WHERE ScratchOrg = '${short}'`;
  const { res, text } = await sfFetch(instanceUrl, accessToken, `/query?q=${encodeURIComponent(soql)}`);
  if (!res.ok) die(`ActiveScratchOrg lookup failed (${res.status}): ${sfError(text)}`);
  const rec = JSON.parse(text)?.records?.[0];
  if (!rec) {
    console.log(`  ✓ No ActiveScratchOrg for ${short} — already gone`);
    return;
  }
  const { res: delRes, text: delText } = await sfFetch(
    instanceUrl, accessToken, `/sobjects/ActiveScratchOrg/${rec.Id}`, { method: 'DELETE' },
  );
  if (!delRes.ok && delRes.status !== 404) {
    die(`Scratch delete failed (${delRes.status}): ${sfError(delText)}`);
  }
  console.log(`  ✓ Deleted scratch ${short}`);
}

const [, , cmd, ...rest] = process.argv;
const argOf = (flag) => {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
};

try {
  if (cmd === 'provision') await provision();
  else if (cmd === 'delete') await deleteScratch(argOf('--org-id') || process.env.SCRATCH_ORG_ID);
  else die('Usage: provision-scratch.mjs <provision|delete [--org-id <id>]>');
} catch (err) {
  die(err?.stack || err?.message || String(err));
}
