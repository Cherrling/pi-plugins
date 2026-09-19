#!/usr/bin/env python3
"""Linux-only M0 6/7/8/9 executable policy spike, NOT production mailbox-core.

Uses real temporary files, flock, O_APPEND, rename, child processes and SIGKILL.
Transport is a local output file, not a Codex hook. IDs are opaque fixture IDs;
SAMP hashing, timestamp watermark semantics and Node bindings are not tested.
"""
import contextlib
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile


def encode(message):
    return (json.dumps(message, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def message(index):
    return {'id': f'm-{index:02d}', 'ts': 1730000000 + index,
            'from': 'boss', 'to': 'worker', 'body': f'message {index} 中文'}


def seed(root, count):
    root.mkdir(parents=True)
    (root / 'log-boss.jsonl').write_bytes(b''.join(encode(message(i)) for i in range(count)))


def scan(root):
    messages, bad = [], []
    for log in sorted(root.glob('log-*.jsonl')):
        for index, line in enumerate(log.read_bytes().splitlines(), 1):
            try:
                messages.append(json.loads(line))
            except (ValueError, UnicodeDecodeError):
                bad.append({'file': log.name, 'line': index})
    return messages, bad


def fingerprint(root):
    stats = [p.stat() for p in root.glob('log-*.jsonl')]
    return [max((s.st_mtime_ns for s in stats), default=0), len(stats), sum(s.st_size for s in stats)]


@contextlib.contextmanager
def reader_lock(root):
    # Lock a stable separate inode, never the state file replaced by rename.
    with (root / 'worker.lock').open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def read_state(root):
    p = root / 'worker.state.json'
    return json.loads(p.read_text()) if p.exists() else {'seen': [], 'backlog': False, 'cache': None}


def commit(root, state):
    fd, name = tempfile.mkstemp(prefix='state-', suffix='.tmp', dir=root)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(state, f)
        os.replace(name, root / 'worker.state.json')
    finally:
        Path(name).unlink(missing_ok=True)


def key(m):
    return m['from'] + ':' + m['id']


def check(root, checkpoint=lambda _: None, allow=True):
    with reader_lock(root):
        state = read_state(root)
        checkpoint('after_read')
        current = fingerprint(root)
        if current == state['cache'] and not state['backlog']:
            return []
        seen = set(state['seen'])
        messages, _ = scan(root)
        pending = [m for m in messages if m['to'] == 'worker' and key(m) not in seen]
        selected = pending[:2] if allow else []
        # This file represents bytes emitted, NOT acknowledgement by a host.
        with (root / 'emitted.jsonl').open('ab') as output:
            for m in selected:
                output.write(encode(m))
        checkpoint('after_emit')
        seen.update(key(m) for m in selected)
        state = {'seen': sorted(seen), 'backlog': len(pending) > len(selected), 'cache': current}
        commit(root, state)
        checkpoint('after_commit')
        return [m['id'] for m in selected]


def replay_locked(root, target):
    state = read_state(root)
    state['seen'] = [] if target == 'all' else [k for k in state['seen'] if k != 'boss:' + target]
    state['backlog'] = True
    commit(root, state)


def replay(root, target):
    with reader_lock(root):
        replay_locked(root, target)


def worker(root, stage):
    if stage == 'append-short':
        for i in range(25):
            candidate_append(root, encode(message(os.getpid() * 1000 + i)),
                             lambda fd, data: os.write(fd, data[:7]))
        return
    if stage == 'replay':
        with (root / 'worker.lock').open('a+b') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print('blocked', flush=True)
            else:
                raise AssertionError('expected check to own the reader lock')
            fcntl.flock(lock, fcntl.LOCK_EX)
            replay_locked(root, 'm-00')
        return

    resumed = False

    def resume(_sig, _frame):
        nonlocal resumed
        resumed = True

    signal.signal(signal.SIGUSR1, resume)

    def pause(at):
        if at == stage:
            print(at, flush=True)
            while not resumed:
                signal.pause()

    check(root, checkpoint=pause)


def start_worker(root, stage):
    return subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'worker', str(root), stage],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def wait_marker(child, expected):
    with selectors.DefaultSelector() as sel:
        sel.register(child.stdout, selectors.EVENT_READ)
        if not sel.select(5):
            raise AssertionError(f'timeout waiting for {expected}')
        assert child.stdout.readline().strip() == expected


def reap(child):
    if child.poll() is None:
        child.kill()
    child.communicate(timeout=5)


def drain(root):
    delivered = []
    for _ in range(20):
        batch = check(root)
        delivered.extend(batch)
        if not batch:
            return delivered
    raise AssertionError('did not drain in 20 checks')


def digest(root):
    return hashlib.sha256((root / 'log-boss.jsonl').read_bytes()).hexdigest()


def append_fd(root):
    return os.open(root / 'log-boss.jsonl', os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600)


def write_all(fd, payload, write_fn=os.write):
    offset = 0
    while offset < len(payload):
        written = write_fn(fd, payload[offset:])
        if written <= 0:
            raise OSError('write made no progress')
        offset += written


def candidate_append(root, payload, write_fn=os.write):
    # Proposed correction for 9, beyond v6.2: serialize the WHOLE write loop and
    # isolate any incomplete tail before another record. No truncation or delete.
    with (root / 'boss.writer.lock').open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        fd = append_fd(root)
        try:
            size = os.fstat(fd).st_size
            if size and os.pread(fd, 1, size - 1) != b'\n':
                write_all(fd, b'\n')
            write_all(fd, payload, write_fn)
        finally:
            os.close(fd)


def main():
    root = Path(tempfile.mkdtemp(prefix='mailbox-m0-v62-'))
    outcomes = []

    backlog = root / 'backlog'
    seed(backlog, 10)
    original = digest(backlog)
    assert check(backlog, allow=False) == []
    assert read_state(backlog)['backlog'] is True
    batches = [check(backlog) for _ in range(5)]
    assert [i for batch in batches for i in batch] == [message(i)['id'] for i in range(10)]
    assert not read_state(backlog)['backlog']
    assert check(backlog) == [] and digest(backlog) == original
    outcomes.append({'case': '6_backlog', 'result': 'pass_in_spike', 'batches': batches,
                     'limitWithoutConsumptionPreserved': True, 'logUnchanged': True})

    crashes = []
    for stage in ['after_emit', 'after_commit']:
        case = root / stage
        seed(case, 2)
        original = digest(case)
        child = start_worker(case, stage)
        try:
            wait_marker(child, stage)
            child.kill()
            child.wait(timeout=5)
            assert child.returncode == -signal.SIGKILL
            observed = check(case)
            if stage == 'after_emit':
                assert observed == ['m-00', 'm-01']
            else:
                assert observed == []
            replay(case, 'all')
            assert check(case) == ['m-00', 'm-01']
            assert digest(case) == original
            crashes.append({'killAt': stage, 'nextCheck': observed, 'replayRecovered': True,
                            'lockReleasedByProcessDeath': True, 'logUnchanged': True})
        finally:
            reap(child)
    outcomes.append({'case': '7_commit_crash', 'result': 'pass_in_spike', 'observations': crashes})

    replay_case = root / 'replay'
    seed(replay_case, 4)
    assert drain(replay_case) == ['m-00', 'm-01', 'm-02', 'm-03']
    original_fp = fingerprint(replay_case)
    original = digest(replay_case)
    replay(replay_case, 'm-00')
    assert read_state(replay_case)['backlog'] is True
    assert check(replay_case) == ['m-00']
    assert check(replay_case) == []
    replay(replay_case, 'all')
    assert drain(replay_case) == ['m-00', 'm-01', 'm-02', 'm-03']
    assert fingerprint(replay_case) == original_fp and digest(replay_case) == original
    outcomes.append({'case': '8_replay_without_new_writes', 'result': 'pass_in_spike',
                     'selectedReplay': ['m-00'], 'allReplayCount': 4, 'fingerprintUnchanged': True})

    check_child = start_worker(replay_case, 'after_read')
    replay_child = None
    try:
        wait_marker(check_child, 'after_read')
        replay_child = start_worker(replay_case, 'replay')
        wait_marker(replay_child, 'blocked')
        check_child.send_signal(signal.SIGUSR1)
        assert check_child.wait(timeout=5) == 0
        assert replay_child.wait(timeout=5) == 0
        assert check(replay_case) == ['m-00']
        outcomes.append({'case': '8_concurrent_check_replay', 'result': 'pass_in_spike',
                         'replayWaitedForLock': True, 'replayIntentPreserved': True})
    finally:
        reap(check_child)
        if replay_child is not None:
            reap(replay_child)

    a, b = encode(message(0)), encode(message(1))
    interleave = root / 'shortwrite-interleave'
    interleave.mkdir()
    first, second = append_fd(interleave), append_fd(interleave)
    try:
        cut = 12
        # Deterministic syscall schedule, no luck-dependent race or simulated disk.
        assert os.write(first, a[:cut]) == cut
        assert os.write(second, b) == len(b)
        write_all(first, a[cut:])
    finally:
        os.close(first)
        os.close(second)
    valid, bad = scan(interleave)
    assert len(valid) == 0 and len(bad) == 2
    outcomes.append({'case': '9_v62_loop_interleaving', 'result': 'design_failure_reproduced',
                     'schedule': ['A prefix', 'B complete record', 'A remainder'],
                     'validRecords': len(valid), 'badLines': len(bad)})

    tail = root / 'failed-tail'
    tail.mkdir()
    fd = append_fd(tail)
    try:
        os.write(fd, a[:12])  # Failed A leaves these bytes; closing cannot undo them.
    finally:
        os.close(fd)
    fd = append_fd(tail)
    try:
        write_all(fd, b)
    finally:
        os.close(fd)
    valid, bad = scan(tail)
    assert len(valid) == 0 and len(bad) == 1
    outcomes.append({'case': '9_v62_next_append_no_isolation', 'result': 'design_failure_reproduced',
                     'validRecords': len(valid), 'badLines': len(bad)})

    candidate = root / 'candidate-repair'
    candidate.mkdir()
    calls = 0

    def short_then_fail(fd, data):
        nonlocal calls
        calls += 1
        if calls == 1:
            return os.write(fd, data[:12])
        raise OSError(errno.ENOSPC, 'injected disk full')

    try:
        candidate_append(candidate, a, short_then_fail)
    except OSError as exc:
        assert exc.errno == errno.ENOSPC
    else:
        raise AssertionError('failed message reported as sent')
    assert (candidate / 'log-boss.jsonl').read_bytes() == a[:12]
    candidate_append(candidate, b)
    # Exercise a successful many-short-writes loop under the alias writer lock.
    candidate_append(candidate, a, lambda fd, data: os.write(fd, data[:7]))
    valid, bad = scan(candidate)
    assert [m['id'] for m in valid] == ['m-01', 'm-00'] and len(bad) == 1
    outcomes.append({'case': '9_candidate_writer_lock_and_tail_separator', 'result': 'pass_in_spike',
                     'failedSendRaisedError': True, 'partialBytesPreserved': True,
                     'laterRecordsReadable': [m['id'] for m in valid], 'badLinesReported': len(bad)})

    parallel = root / 'candidate-parallel'
    parallel.mkdir()
    writers = []
    try:
        for _ in range(4):
            writers.append(start_worker(parallel, 'append-short'))
        for child in writers:
            assert child.wait(timeout=10) == 0
        valid, bad = scan(parallel)
        assert len(valid) == len({key(m) for m in valid}) == 100 and not bad
        outcomes.append({'case': '9_candidate_parallel_short_writes', 'result': 'pass_in_spike',
                         'writers': 4, 'records': len(valid), 'chunkBytes': 7, 'badLines': len(bad)})
    finally:
        for child in writers:
            reap(child)

    report = {'design': 'v6.2', 'status': 'not_passed', 'root': str(root),
              'python': sys.version.split()[0], 'platform': sys.platform, 'outcomes': outcomes,
              'limitations': ['Policy spike in Python, not production Node mailbox-core.',
                  'Opaque fixture IDs and a full seen set: SAMP ID/cursor compatibility is not tested.',
                  'No Codex hook, task side effect, alias ownership or power-loss durability tested.',
                  'Candidate writer locking is a proposed correction beyond v6.2, not an implemented production fix.',
                  'Replay clears transport seen state; application-side idempotency is a separate requirement.']}
    (root / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'worker':
        worker(Path(sys.argv[2]), sys.argv[3])
    elif len(sys.argv) == 1:
        main()
    else:
        raise SystemExit('usage: probe-v62.py')
