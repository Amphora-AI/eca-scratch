/**
 * Verification harness: runs provision-scratch.mjs end-to-end against a mock Salesforce
 * that cryptographically verifies the JWT assertion with the public key and asserts the
 * PlatformCLI pin is present. Proves everything except the live Salesforce handshake.
 */
import { createServer } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// MUST be async: the mock Salesforce server runs in THIS process, so a synchronous
// execFileSync would block the event loop and deadlock against the child's requests.
const run = promisify(execFile);

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const dir = mkdtempSync(join(tmpdir(), 'scratch-verify-'));
const defPath = join(dir, 'scratch-def.json');
writeFileSync(defPath, JSON.stringify({
  orgName: 'CI Test', edition: 'Developer', features: ['EnableSetPasswordInApi', 'Communities'],
  adminEmail: 'ci@example.com', settings: { lightningExperienceSettings: { enableS1DesktopEnabled: true } },
  // Two packages so ordering (dependency first) is observable.
  installPackages: ['04tAAA', '04tBBB'],
}));

const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${detail}`}`);
};

let pollCount = 0;
let deletedActiveScratchOrg = false;
let insertPayload = null;
let exchangeBody = null;
let installAttempts = [];
let pkgPolls = {};
let pkgBehavior = 'success'; // 'success' | 'error'

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };

    // --- OAuth token endpoint ---
    if (url.pathname === '/services/oauth2/token') {
      const p = new URLSearchParams(body);
      const grant = p.get('grant_type');

      if (grant === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        const assertion = p.get('assertion') || '';
        const [h, c, s] = assertion.split('.');
        check('JWT has 3 parts', !!(h && c && s));
        const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
        check('JWT iss = client id', claims.iss === 'test-consumer-key', JSON.stringify(claims));
        check('JWT sub = username', claims.sub === 'ci@example.com.devhub');
        check('JWT aud = login url', claims.aud === `http://localhost:${port}`, claims.aud);
        check('JWT exp in the future', claims.exp > Math.floor(Date.now() / 1000));
        const ok = createVerify('RSA-SHA256')
          .update(`${h}.${c}`)
          .verify(publicKey, Buffer.from(s, 'base64url'));
        check('JWT signature verifies against the public key', ok);
        return send(200, { access_token: 'DEVHUB_TOKEN', instance_url: `http://localhost:${port}` });
      }

      if (grant === 'authorization_code') {
        exchangeBody = p;
        check('AuthCode exchange uses PlatformCLI client_id', p.get('client_id') === 'PlatformCLI', p.get('client_id'));
        check('AuthCode exchange uses the loopback redirect_uri',
          p.get('redirect_uri') === 'http://localhost:1717/OauthRedirect', p.get('redirect_uri'));
        check('AuthCode forwarded', p.get('code') === 'AUTH_CODE_XYZ');
        return send(200, {
          access_token: 'SCRATCH_TOKEN', refresh_token: 'SCRATCH_REFRESH',
          instance_url: `http://localhost:${port}`,
        });
      }
      return send(400, { error: 'unsupported_grant_type' });
    }

    // --- ScratchOrgInfo insert ---
    if (url.pathname === '/services/data/v67.0/sobjects/ScratchOrgInfo' && req.method === 'POST') {
      insertPayload = JSON.parse(body);
      check('THE PIN: ConnectedAppConsumerKey === PlatformCLI',
        insertPayload.ConnectedAppConsumerKey === 'PlatformCLI', insertPayload.ConnectedAppConsumerKey);
      // Salesforce rejects the insert with REQUIRED_FIELD_MISSING [ConnectedAppCallbackUrl]
      // if the consumer key is set without it. Caught only by a live run — pinned here so
      // the mock can't pass a payload real Salesforce would reject.
      check('ConnectedAppCallbackUrl sent alongside the consumer key (REQUIRED)',
        insertPayload.ConnectedAppCallbackUrl === 'http://localhost:1717/OauthRedirect',
        String(insertPayload.ConnectedAppCallbackUrl));
      check('features array flattened to a ; string',
        insertPayload.Features === 'EnableSetPasswordInApi;Communities', insertPayload.Features);
      check('DurationDays passed through', insertPayload.DurationDays === 3, String(insertPayload.DurationDays));
      check('Edition mapped', insertPayload.Edition === 'Developer');
      check('AdminEmail mapped', insertPayload.AdminEmail === 'ci@example.com');
      check('settings NOT sent as a signup field', insertPayload.settings === undefined);
      return send(201, { id: '2SR000000000001' });
    }

    // --- Queries ---
    if (url.pathname === '/services/data/v67.0/query') {
      const q = url.searchParams.get('q') || '';
      if (q.includes('FROM ScratchOrgInfo')) {
        pollCount += 1;
        // First poll returns a transient state to exercise the wait loop.
        if (pollCount === 1) return send(200, { records: [{ Status: 'Creating' }] });
        return send(200, {
          records: [{
            Status: 'Active', ErrorCode: null, AuthCode: 'AUTH_CODE_XYZ',
            LoginUrl: `http://localhost:${port}`, SignupUsername: 'test-scratch@example.com',
            ScratchOrg: '00D000000000001',
          }],
        });
      }
      if (q.includes('FROM ActiveScratchOrg')) {
        check('delete looks up ActiveScratchOrg by 15-char id', q.includes("'00D000000000001'"), q);
        return send(200, { records: [{ Id: '2SS000000000001' }] });
      }
    }

    // --- Delete ---
    if (url.pathname === '/services/data/v67.0/sobjects/ActiveScratchOrg/2SS000000000001'
        && req.method === 'DELETE') {
      deletedActiveScratchOrg = true;
      return send(204, '');
    }

    // --- Tooling: PackageInstallRequest (create) ---
    if (url.pathname === '/services/data/v67.0/tooling/sobjects/PackageInstallRequest'
        && req.method === 'POST') {
      const p = JSON.parse(body);
      installAttempts.push(p);
      // Mirror the real restricted picklists — a bad value must fail here too, or the
      // mock will happily accept payloads production rejects (this exact gap shipped
      // `SecurityType: "AdminsOnly"`, which Salesforce refuses).
      if (!['Full', 'None', 'Custom', 'Push'].includes(p.SecurityType)) {
        return send(400, [{ message: `Security Type: bad value for restricted picklist field: ${p.SecurityType}`,
          errorCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST' }]);
      }
      if (!['RenameAllForTest', 'RenameMetadata', 'Block'].includes(p.NameConflictResolution)) {
        return send(400, [{ message: `bad value for restricted picklist field: ${p.NameConflictResolution}`,
          errorCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST' }]);
      }
      return send(201, { id: `0Hf${installAttempts.length}` });
    }

    // --- Tooling: PackageInstallRequest (poll) ---
    if (url.pathname.startsWith('/services/data/v67.0/tooling/sobjects/PackageInstallRequest/')) {
      const reqId = url.pathname.split('/').pop();
      pkgPolls[reqId] = (pkgPolls[reqId] || 0) + 1;
      if (pkgBehavior === 'error') {
        return send(200, { Status: 'ERROR', Errors: [{ message: 'dependency missing' }] });
      }
      // First poll IN_PROGRESS to exercise the wait loop, then SUCCESS.
      if (pkgPolls[reqId] === 1) return send(200, { Status: 'IN_PROGRESS' });
      return send(200, { Status: 'SUCCESS' });
    }

    send(404, { message: `unexpected ${req.method} ${url.pathname}` });
  });
});

let port;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
port = server.address().port;

const outFile = join(dir, 'gh-output');
const envFile = join(dir, 'gh-env');
writeFileSync(outFile, '');
writeFileSync(envFile, '');

const env = {
  ...process.env,
  SF_CLIENT_ID: 'test-consumer-key',
  SF_USERNAME: 'ci@example.com.devhub',
  SF_JWT_KEY: privateKey,
  SF_LOGIN_URL: `http://localhost:${port}`,
  SCRATCH_DEF_PATH: defPath,
  SCRATCH_DURATION_DAYS: '3',
  POLL_INTERVAL_MS: '10',
  GITHUB_OUTPUT: outFile,
  GITHUB_ENV: envFile,
};

const script = new URL('../scripts/ci/provision-scratch.mjs', import.meta.url).pathname;

console.log('\n=== provision ===');
let stdout = '';
try {
  const r = await run('node', [script, 'provision'], { env, encoding: 'utf8' });
  stdout = r.stdout + r.stderr;
  console.log(stdout.split('\n').filter((l) => l.startsWith('  ✓') || l.startsWith('→') || l.startsWith('⚠')).join('\n'));
} catch (err) {
  check('provision exited 0', false, String(err.stdout) + String(err.stderr));
}

check('warned about unsupported settings', /settings.*NOT applied|not applied/i.test(stdout));
check('polled more than once (wait loop works)', pollCount >= 2, `polls=${pollCount}`);

const outputs = readFileSync(outFile, 'utf8');
check('output: instance_url', outputs.includes(`instance_url=http://localhost:${port}`), outputs);
check('output: username', outputs.includes('username=test-scratch@example.com'));
check('output: org_id', outputs.includes('org_id=00D000000000001'));
const envOut = readFileSync(envFile, 'utf8');
check('exported SFDX_ACCESS_TOKEN for the CLI', envOut.includes('SFDX_ACCESS_TOKEN=SCRATCH_TOKEN'), envOut);

console.log('\n=== delete ===');
try {
  await run('node', [script, 'delete', '--org-id', '00D000000000001'], { env, encoding: 'utf8' });
} catch (err) {
  check('delete exited 0', false, String(err.stdout) + String(err.stderr));
}
check('ActiveScratchOrg record deleted', deletedActiveScratchOrg);

console.log('\n=== failure handling ===');
try {
  await run('node', [script, 'provision'], {
    env: { ...env, SF_CLIENT_ID: '' }, encoding: 'utf8',
  });
  check('missing env exits non-zero', false, 'exited 0');
} catch (err) {
  check('missing env exits non-zero with a clear message',
    /Missing required env var SF_CLIENT_ID/.test(err.stderr || ''), err.stderr);
}

console.log('\n=== package installs ===');
check('installed both packages from the scratch def', installAttempts.length === 2, JSON.stringify(installAttempts));
check('install order preserved (dependency first)',
  installAttempts[0]?.SubscriberPackageVersionKey === '04tAAA'
  && installAttempts[1]?.SubscriberPackageVersionKey === '04tBBB', JSON.stringify(installAttempts));
check('SecurityType defaults to None (admins-only; "AdminsOnly" is NOT a valid Salesforce value)',
  installAttempts[0]?.SecurityType === 'None', String(installAttempts[0]?.SecurityType));
check('NameConflictResolution defaults to Block', installAttempts[0]?.NameConflictResolution === 'Block');
check('polled install status through IN_PROGRESS',
  Object.values(pkgPolls).some((n) => n >= 2), JSON.stringify(pkgPolls));

// A required package that fails must stop the run — but the scratch already exists, so
// org_id MUST still have been written or the teardown step can't clean it up.
console.log('\n=== required package failure (must not leak the scratch) ===');
pkgBehavior = 'error';
installAttempts = []; pkgPolls = {};
const failOut = join(dir, 'gh-output-fail');
writeFileSync(failOut, '');
try {
  await run('node', [script, 'provision'], { env: { ...env, GITHUB_OUTPUT: failOut }, encoding: 'utf8' });
  check('required package failure exits non-zero', false, 'exited 0');
} catch (err) {
  const out = String(err.stdout) + String(err.stderr);
  check('required package failure exits non-zero', true);
  check('failure message names the failing package', /Package install failed for/.test(out), out.slice(-300));
}
check('org_id written BEFORE the failed install (teardown can still clean up)',
  readFileSync(failOut, 'utf8').includes('org_id=00D000000000001'), readFileSync(failOut, 'utf8'));

console.log('\n=== optional package failure ===');
const pkgCfg = join(dir, 'packages.json');
writeFileSync(pkgCfg, JSON.stringify({ packages: [{ id: '04tOPT', name: 'Optional Pkg', optional: true }] }));
installAttempts = []; pkgPolls = {};
try {
  const r = await run('node', [script, 'provision'],
    { env: { ...env, SCRATCH_PACKAGES_PATH: pkgCfg }, encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  check('optional package failure does not fail the run', true);
  check('optional failure is warned', /optional package .* failed/i.test(out), out.slice(-300));
} catch (err) {
  check('optional package failure does not fail the run', false, String(err.stdout) + String(err.stderr));
}
check('config file overrides scratch-def installPackages',
  installAttempts.length === 1 && installAttempts[0]?.SubscriberPackageVersionKey === '04tOPT',
  JSON.stringify(installAttempts));

console.log('\n=== resolution precedence + skip ===');
pkgBehavior = 'success';
installAttempts = []; pkgPolls = {};
await run('node', [script, 'provision'],
  { env: { ...env, SCRATCH_PACKAGES_PATH: pkgCfg, SCRATCH_INSTALL_PACKAGES: '04tENV' }, encoding: 'utf8' });
check('SCRATCH_INSTALL_PACKAGES wins over the config file',
  installAttempts.length === 1 && installAttempts[0]?.SubscriberPackageVersionKey === '04tENV',
  JSON.stringify(installAttempts));

installAttempts = []; pkgPolls = {};
await run('node', [script, 'provision'],
  { env: { ...env, SCRATCH_INSTALL_PACKAGES: '04tENV', SCRATCH_SKIP_PACKAGES: 'true' }, encoding: 'utf8' });
check('SCRATCH_SKIP_PACKAGES=true installs nothing', installAttempts.length === 0, JSON.stringify(installAttempts));

server.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${'='.repeat(50)}\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('FAILED:');
  failed.forEach((f) => console.log(`  ✗ ${f.name} — ${f.detail}`));
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
