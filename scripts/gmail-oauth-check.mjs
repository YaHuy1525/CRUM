// Temporary probe: validate the Gmail OAuth credentials against Google's endpoints.
// Checks: 1) client id shape  2) Gmail API enabled on the project  3) Google accepts the client id+secret pair.
import fs from 'node:fs';

const env = Object.fromEntries(
  fs
    .readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const clientId = env.GMAIL_OAUTH_CLIENT_ID ?? '';
const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET ?? '';
const projectId = clientId.split('-')[0];

// 1. Client ID shape: <project>-<token>.apps.googleusercontent.com
const shapeOk = /^\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId);
console.log(`1. client id shape: ${shapeOk ? 'OK' : 'MALFORMED'} (${clientId.replace(/(?<=.{20}).*/s, '...')})`);

// 2. Is the Gmail API enabled? Unauthenticated call: 401 = enabled (needs auth), 403 accessNotConfigured = API off.
const api = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile');
if (api.status === 401) {
  console.log('2. Gmail API enabled on project: OK (Google asks for auth, which is correct)');
} else {
  const body = await api.text();
  console.log(`2. Gmail API enabled on project: NOT OK -> HTTP ${api.status}: ${body.slice(0, 200)}`);
}

// 3. Token endpoint probe: fake auth code. invalid_grant = Google recognizes the client pair.
//    invalid_client = id/secret wrong or mismatched.
const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: 'probe-invalid-code',
    grant_type: 'authorization_code',
    redirect_uri: 'http://localhost:4111/gmail/callback',
  }),
});
const json = await res.json();
if (json.error === 'invalid_grant') {
  console.log('3. OAuth client id + secret accepted by Google: OK (only the fake code was rejected, as intended)');
} else {
  console.log(`3. OAuth client id + secret: NOT OK -> ${json.error}: ${json.error_description ?? ''}`);
}
