// Diagnostic spike, not production mailbox code. All writes are in a fresh tmpdir.
// Node >= 22.13 is needed to load the existing TypeScript without npm dependencies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-m0-local-'));
const report = { root, node: process.version, platform: `${process.platform}/${process.arch}`, checks: [] };
const sourceFile = fileURLToPath(new URL('../../plugins/session-messaging/src/mailbox.ts', import.meta.url));
const source = fs.readFileSync(sourceFile, 'utf8');
const originalRoot = 'path.join(os.homedir(), ".pi", "agent", "mailbox")';
assert.equal(source.split(originalRoot).length, 2, 'review isolation if production root declaration changes');
const fixtureSource = source.replace(originalRoot, JSON.stringify(path.join(root, 'mailbox')));
const moduleFile = path.join(root, 'mailbox.mjs');
fs.writeFileSync(moduleFile, stripTypeScriptTypes(fixtureSource));
const core = await import(pathToFileURL(moduleFile).href);
assert.equal(core.MAILBOX_DIR, path.join(root, 'mailbox'));
core.ensureDirs();

function registration(id, name = id) {
  const reg = { id, name, pid: process.pid, cwd: root, sessionFile: '', startedAt: Date.now() };
  fs.mkdirSync(core.inboxDir(id), { recursive: true });
  fs.writeFileSync(core.regPath(id), JSON.stringify(reg));
  return reg;
}
function stash(id) {
  const inbox = core.inboxDir(id);
  fs.writeFileSync(path.join(inbox, 'unread.json'), JSON.stringify({ id: 'unread', text: 'pending' }));
  fs.writeFileSync(path.join(inbox, 'delivered.log'), JSON.stringify({ id: 'delivered', text: 'original' }) + '\n');
  fs.writeFileSync(path.join(inbox, 'overflow-example.txt'), 'full original');
}
function check(name, fn) {
  fn();
  report.checks.push({ name, result: 'reproduced' });
}

check('current unregister deletes unread messages, delivered.log and overflow', () => {
  registration('old-session');
  stash('old-session');
  core.unregister('old-session');
  assert.equal(fs.existsSync(core.inboxDir('old-session')), false);
});
check('current dead-session cleanup deletes the same archive', () => {
  registration('dead-session');
  stash('dead-session');
  core.updateRegistration('dead-session', { pid: 2147483647 });
  const stale = new Date(Date.now() - core.STALE_MS - 1000);
  fs.utimesSync(core.regPath('dead-session'), stale, stale);
  assert.equal(core.listSessions().some(reg => reg.id === 'dead-session'), false);
  assert.equal(fs.existsSync(core.inboxDir('dead-session')), false);
});
check('current resolver silently accepts duplicate exact names', () => {
  registration('one', 'worker');
  registration('two', 'worker');
  assert.ok(['one', 'two'].includes(core.resolveTarget('worker').id));
});

// Model the documented v3 Stop policy, without pretending this is a real hook.
// Define "2" as a total per-turn block budget; source text must make this explicit.
const queueDir = path.join(root, 'backlog');
fs.mkdirSync(queueDir);
const ids = Array.from({ length: 12 }, (_, i) => `m-${String(i).padStart(2, '0')}`);
for (const id of ids) fs.writeFileSync(path.join(queueDir, `${id}.json`), JSON.stringify({ id, text: id }));
let blocks = 0;
function pending() { return fs.readdirSync(queueDir).filter(file => file.endsWith('.json')).sort(); }
function event(mode, active = false) {
  if (mode === 'Stop' && !active) blocks = 0;
  if (mode === 'Stop' && blocks >= 2) return { delivered: 0, pending: pending().length };
  const files = pending().slice(0, 2);
  for (const file of files) {
    const message = JSON.parse(fs.readFileSync(path.join(queueDir, file), 'utf8'));
    // The model assumes stdout succeeded. This is not host acceptance.
    fs.appendFileSync(path.join(queueDir, 'delivered.log'), JSON.stringify(message) + '\n');
    fs.unlinkSync(path.join(queueDir, file));
  }
  if (mode === 'Stop' && files.length) blocks++;
  return { delivered: files.length, pending: pending().length };
}
report.backlogModel = [event('Stop'), event('Stop', true), event('Stop', true)];
assert.equal(report.backlogModel[2].pending, 8);
for (let i = 0; i < 4; i++) report.backlogModel.push(event('PostToolUse'));
const archivedIds = fs.readFileSync(path.join(queueDir, 'delivered.log'), 'utf8').trim().split('\n')
  .map(line => JSON.parse(line).id);
assert.deepEqual(archivedIds, ids);
assert.equal(pending().length, 0);

report.limitations = ['Backlog is a policy model, not a Codex end-to-end test.',
  'No host receipt ACK, crash durability, concurrent delivery, or model ACK compliance is established.'];
fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
