// M0 instrumentation only. Never touches the real mailbox.
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error('absolute probe directory required');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const ancestors = [];
let pid = process.pid;
for (let i = 0; pid > 0 && i < 32; i++) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    ancestors.push({ pid, ppid: Number(fields[1]), startTicks: fields[19],
      exe: fs.readlinkSync(`/proc/${pid}/exe`) });
    pid = Number(fields[1]);
  } catch { break; }
}
fs.appendFileSync(path.join(root, 'hooks.jsonl'), JSON.stringify({ input, ancestors }) + '\n');
const event = input.hook_event_name;
const output = event === 'SessionStart' || event === 'PostToolUse'
  ? { hookSpecificOutput: { hookEventName: event, additionalContext: 'Mailbox M0 instrumentation.' } }
  : {};
process.stdout.write(JSON.stringify(output));
