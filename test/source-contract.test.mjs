import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = {
  attachments: new URL('../lib/attachments.js', import.meta.url),
  route: new URL('../app/api/renewal-emails/route.js', import.meta.url),
  config: new URL('../next.config.js', import.meta.url),
  messages: new URL('../lib/messages.js', import.meta.url),
  offers: new URL('../lib/offers.js', import.meta.url),
  audit: new URL('../lib/audit.js', import.meta.url),
  replies: new URL('../lib/replyProcessor.js', import.meta.url),
  callback: new URL('../lib/callback.js', import.meta.url),
  replyRoute: new URL('../app/api/renewal-emails/[messageId]/replies/route.js', import.meta.url),
};

test('browser POST route exposes CORS preflight and the PAS namespace header', async () => {
  const [route, config] = await Promise.all([readFile(files.route, 'utf8'), readFile(files.config, 'utf8')]);
  assert.match(route, /export async function OPTIONS/);
  assert.match(config, /Access-Control-Allow-Origin/);
  assert.match(config, /X-PAS-Integration-Namespace/);
  assert.match(config, /GET,POST,OPTIONS/);
  assert.match(route, /customerRef/);
  assert.match(route, /arEmailKey\("outbound-request"/);
});

test('email service storage never uses generic report-MockAPI keys', async () => {
  const sources = await Promise.all([files.messages, files.offers, files.audit, files.replies, files.callback, files.replyRoute, files.attachments].map((url) => readFile(url, 'utf8')));
  const combined = sources.join('\n');
  assert.match(combined, /arEmailKey/);
  for (const forbidden of [
    /const MESSAGES_INDEX = ["']messages:index["']/,
    /const AUDIT_KEY = ["']audit:log["']/,
    /`message:\$\{/,
    /`offer:\$\{/,
    /`reply:\$\{/,
    /`outbound-request:/,
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }
});


test('all generated operational identifiers use the Auto-Renewal email namespace', async () => {
  const [route, replyRoute, replies] = await Promise.all([
    readFile(files.route, 'utf8'),
    readFile(files.replyRoute, 'utf8'),
    readFile(files.replies, 'utf8'),
  ]);
  assert.match(route, /newId\("AR-EMAIL-MSG"\)/);
  assert.match(route, /newId\("AR-EMAIL-THREAD"\)/);
  assert.match(replyRoute, /newId\("AR-EMAIL-REPLY"\)/);
  assert.match(replies, /newId\("AR-EMAIL-EVENT"\)/);
  assert.doesNotMatch(`${route}
${replyRoute}
${replies}`, /newId\("(?:MSG|THREAD|REPLY|EVENT)"\)/);
});

test('Postman outbound requests match the PAS v0.2 browser contract', async () => {
  const collectionUrl = new URL('../postman/Mock-Renewal-Email-API.postman_collection.json', import.meta.url);
  const collection = JSON.parse(await readFile(collectionUrl, 'utf8'));
  const requests = [];
  const walk = (items = []) => items.forEach((item) => {
    if (Array.isArray(item.item)) walk(item.item);
    else requests.push(item);
  });
  walk(collection.item);
  const outbound = requests.filter((item) => {
    const request = item.request || {};
    const rawUrl = typeof request.url === 'string' ? request.url : request.url?.raw || '';
    return request.method === 'POST' && request.body?.mode === 'raw' && rawUrl.replace(/\/$/, '').endsWith('/api/renewal-emails');
  });
  assert.ok(outbound.length >= 4);
  outbound.forEach((item) => {
    const request = item.request;
    const body = JSON.parse(request.body.raw);
    assert.equal(body.messageType, 'AUTO_RENEWAL_OFFER');
    assert.equal(body.integrationNamespace, 'AR_EMAIL');
    assert.ok(body.customerRef);
    assert.equal(body.subject, undefined);
    assert.equal(body.body, undefined);
    assert.ok(request.header.some((header) => header.key === 'X-PAS-Integration-Namespace' && header.value === 'AR_EMAIL'));
  });
});


test('Postman includes multipart Forms delivery with an actual PDF fixture', async () => {
  const collectionUrl = new URL('../postman/Mock-Renewal-Email-API.postman_collection.json', import.meta.url);
  const collection = JSON.parse(await readFile(collectionUrl, 'utf8'));
  const multipart = collection.item.find((item) => item.request?.body?.mode === 'formdata');
  assert.ok(multipart, 'multipart request is missing');
  const metadata = multipart.request.body.formdata.find((row) => row.key === 'metadata');
  const attachment = multipart.request.body.formdata.find((row) => row.key === 'attachments');
  assert.ok(metadata?.value.includes('formsPackageSnapshotId'));
  assert.equal(attachment?.type, 'file');
  assert.match(String(attachment?.src), /renewal-forms-sample\.pdf$/);
});

test('Forms delivery cannot collapse email-sent/evidence-failed into delivered', async () => {
  const route = await readFile(files.route, 'utf8');
  assert.match(route, /EMAIL_SENT_FORMS_FAILED/);
  assert.match(route, /FORMS_DELIVERY_EVIDENCE_FAILED/);
  assert.match(route, /formsEvidencePersisted/);
  assert.match(route, /formsStatus === "DELIVERED"/);
});

test('privacy exclusions include raw HazardHub integration payloads', async () => {
  const privacy = await readFile(new URL('../lib/privacy.js', import.meta.url), 'utf8');
  assert.match(privacy, /"hazardHubRawResponse"/);
});

test('Resend webhook uses direct signed REST flow without an SDK dependency', async () => {
  const [webhook, pkg, lock] = await Promise.all([
    readFile(new URL('../app/api/webhooks/resend/route.js', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(webhook, /from ["']resend["']/);
  assert.match(webhook, /verifySvixSignature/);
  assert.match(webhook, /\/emails\/receiving\//);
  assert.equal(JSON.parse(pkg).dependencies.resend, undefined);
  assert.equal(JSON.parse(lock).packages['node_modules/resend'], undefined);
});
