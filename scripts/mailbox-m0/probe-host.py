#!/usr/bin/env python3
"""Probe real Codex lifecycle without credentials, inference, or real mailboxes.

Uses a private CODEX_HOME for its intended purpose: isolate the test child.
Results and child logs stay in a fresh /tmp/mailbox-m0-* directory.
"""
import json
import os
from pathlib import Path
import queue
import shlex
import subprocess
import tempfile
import threading
import time


def main():
    root = Path(tempfile.mkdtemp(prefix='mailbox-m0-host-'))
    codex_home = root / 'codex-home'
    codex_home.mkdir()
    hook = Path(__file__).with_name('probe-hook.mjs').resolve()
    command = shlex.join(['node', str(hook), str(root)])
    events = ['SessionStart', 'SessionEnd', 'PostToolUse', 'Stop']
    (codex_home / 'hooks.json').write_text(json.dumps({'hooks': {
        event: [{'hooks': [{'type': 'command', 'command': command}]}]
        for event in events
    }}))
    # Startup hooks run on the first turn in this version. Point inference at an
    # unavailable loopback endpoint: no credentials, external service or model use.
    (codex_home / 'config.toml').write_text(
        'model_provider = "m0_offline"\n'
        '[model_providers.m0_offline]\nname = "M0 offline"\n'
        'base_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\n'
        'request_max_retries = 0\nstream_max_retries = 0\n'
    )
    report = {'root': str(root), 'version': subprocess.check_output(
        ['codex', '--version'], text=True).strip(), 'responses': []}
    messages = queue.Queue()
    with (root / 'stderr.log').open('w') as errors:
        child = subprocess.Popen(
            ['codex', 'app-server'],
            cwd=root, env={**os.environ, 'CODEX_HOME': str(codex_home)},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
            text=True, start_new_session=True,
        )
        report['hostPid'] = child.pid

        def read():
            for line in child.stdout:
                messages.put(json.loads(line))
            messages.put(None)

        threading.Thread(target=read, daemon=True).start()
        sequence = 0

        def request(method, params):
            nonlocal sequence
            sequence += 1
            child.stdin.write(json.dumps({'id': sequence, 'method': method, 'params': params}) + '\n')
            child.stdin.flush()
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                msg = messages.get(timeout=max(0.01, deadline - time.monotonic()))
                if msg is None:
                    raise RuntimeError('app-server exited')
                report['responses'].append(msg)
                if msg.get('id') == sequence:
                    if 'error' in msg:
                        raise RuntimeError(json.dumps(msg['error']))
                    return msg['result']
            raise TimeoutError(method)

        try:
            request('initialize', {'clientInfo': {'name': 'mailbox_m0', 'version': '0.1.0'},
                                   'capabilities': {'experimentalApi': True}})
            child.stdin.write('{"method":"initialized"}\n')
            child.stdin.flush()
            ids = []
            for source in ['startup', 'clear']:
                result = request('thread/start', {'cwd': str(root), 'approvalPolicy': 'never',
                    'sandbox': 'read-only', 'sessionStartSource': source,
                    # Trust only our generated instrumentation in this isolated child.
                    'config': {'bypass_hook_trust': True}})
                ids.append(result['thread']['id'])
            report['threadIds'] = ids
            report['hookDefinitions'] = request('hooks/list', {'cwds': [str(root)]})
            time.sleep(1)
            report['hookCountBeforeFirstTurn'] = len((root / 'hooks.jsonl').read_text().splitlines()) \
                if (root / 'hooks.jsonl').exists() else 0
            for thread_id in ids:
                request('turn/start', {'threadId': thread_id,
                    'input': [{'type': 'text', 'text': 'M0 offline lifecycle probe.'}]})
            report['firstThreadAfterSecondStart'] = request('thread/read', {'threadId': ids[0]})
            report['loadedThreads'] = request('thread/loaded/list', {})
            # Bounded observation only, not proof that idle delivery never happens.
            time.sleep(3)
            report['hooks'] = [json.loads(line) for line in (root / 'hooks.jsonl').read_text().splitlines()] \
                if (root / 'hooks.jsonl').exists() else []
            starts = [h for h in report['hooks'] if h['input']['hook_event_name'] == 'SessionStart']
            assert {h['input']['session_id'] for h in starts} == set(ids), 'missing startup hook evidence'
            assert set(ids).issubset(report['loadedThreads']['data']), 'threads were not both loaded'
            assert all(any(a['pid'] == child.pid for a in h['ancestors']) for h in starts), \
                'hooks do not share the tested host'
        except Exception as exc:
            report['error'] = str(exc)
        finally:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    (root / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({'report': str(root / 'report.json'),
                      'error': report.get('error'), 'hostPid': report['hostPid'],
                      'threads': report.get('threadIds'),
                      'loadedThreads': report.get('loadedThreads'),
                      'hooks': report.get('hooks')}, indent=2))
    if report.get('error'):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
