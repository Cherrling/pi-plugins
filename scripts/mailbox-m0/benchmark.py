#!/usr/bin/env python3
"""Empty-inbox process startup baseline, not a production check benchmark."""
import json
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

root = Path(tempfile.mkdtemp(prefix='mailbox-m0-bench-'))
inbox = root / 'empty'
inbox.mkdir()
script = root / 'check.mjs'
script.write_text('''import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!input.session_id) throw new Error('missing session_id');
fs.readdirSync(process.argv[2]).filter(f => f.endsWith('.json'));
process.stdout.write('{}');
''')


def measure(command):
    timings = []
    for i in range(55):
        start = time.perf_counter()
        result = subprocess.run(command, input='{"session_id":"test"}\n',
                                text=True, capture_output=True, timeout=5, check=True)
        elapsed = (time.perf_counter() - start) * 1000
        assert result.stdout == '{}', result
        if i >= 5:
            timings.append(elapsed)
    return {'samples': len(timings), 'medianMs': round(statistics.median(timings), 2),
            'p95Ms': round(sorted(timings)[47], 2)}


report = {
    'root': str(root),
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'nodeJsonAndEmptyPeek': measure(['node', str(script), str(inbox)]),
    'bashStartupAndGlobOnly': measure(['bash', '--noprofile', '--norc', '-c',
        'IFS= read -r input; files=("$1"/*.json); printf "{}"', 'm0', str(inbox)]),
    'limitations': ['Bash does not parse JSON; the two probes are not equivalent implementations.',
                   'No identity lookup, heartbeat, lock, fsync, rendering or nonempty-inbox cost measured.'],
}
(root / 'report.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
