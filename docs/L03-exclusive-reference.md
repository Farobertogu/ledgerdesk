# L03 exclusive kernel reference

Status: implemented test correction; the localized failure-path delta is pending
focused technical review. Physical Linux execution is not yet released.
No result below resolves the historical intermittent failure. The completed
profile comparison remains `no_discrimination`; it does not select another driver.

## Property and reference

The native fixture still retains 16 MiB buffers with a 128 MiB Node heap and an
actual 512 MiB cgroup memory limit, without swap. Exit 137 alone is insufficient.
The new acceptance function requires, together:

- The exact parser image and probe/gate file identities.
- A fresh case-owned systemd slice under `system.slice`, containing just the
  expected Docker scope and its gated Node process before release.
- The child's effective memory, swap, CPU and PID limits, and Docker's image,
  parent, restart policy and identity.
- A parent reference with unchanged inode and invocation, retained through the
  final read/export after the process exits. Initial event counters are zero.
- Hierarchical `max > 0`, `oom > 0`, exactly one `oom_kill`, no group OOM, no
  local event in the parent, and no foreign or still-running process at the end.
- Exit 137 from the container and attached client, no watchdog or external
  intervention in the positive case, and confirmed case-owned cleanup.

Docker's `OOMKilled` remains recorded but is not the acceptance oracle. Missing,
malformed, reset, replaced or ambiguous reference evidence fails the check.

The [kernel interface](https://docs.kernel.org/admin-guide/cgroup-v2.html) describes
hierarchical memory event counters and the `memory_localevents` exception, which
this profile rejects. `max`/`oom` evidence and victim evidence have different
meanings; `oom_kill` includes any OOM killer. The claimed observation is limit
pressure in the exclusive case plus an OOM-killed process belonging to it. These
counters do **not** encode `CONSTRAINT_MEMCG`, rule out every coincident global
OOM, or establish the cause of an earlier failure. No such inference is made.

The [kernel implementation](https://github.com/torvalds/linux/blob/v6.17/include/linux/memcontrol.h)
increments ancestor event counters when the event occurs; final reading does not
need the removed child's files. [systemd slice lifetime](https://github.com/systemd/systemd/blob/v255/src/core/slice.c)
and its [empty-cgroup handling](https://github.com/systemd/systemd/blob/v257/src/core/cgroup.c)
support retaining an active slice until explicit stop. The running system must
still satisfy the reference checks; source inspection is not a physical result.

## Localized fixture changes

`l03_gate.mjs` starts one Node process and waits for one exact stdin release. The
controller checks and exports the real membership before allowing the unchanged
probe to run in that process. The ten-second wall deadline includes gate time;
it is not extended. There is no keeper process in the measured subtree.

The container gains `--interactive` and a unique per-case
[`--cgroup-parent`](https://docs.docker.com/reference/cli/dockerd/#default-cgroup-parent).
Its original numeric limits, read-only filesystem, dropped capabilities,
no-new-privileges and disabled network remain. The driver and daemon configuration
are not changed. A transient systemd slice is created through the manager API and
stopped only after the matching container is removed and its inventory is empty.
It is not a persistent unit installation or a new diagnostic service.

The concrete adapter is deliberately qualified for the existing GitHub-hosted
Linux/systemd/cgroup-v2 runner with the local daemon and host cgroup namespace.
It refuses Docker Desktop/Windows, rootless, another namespace, another driver,
remote sockets and `memory_localevents`, rather than changing controls to make
the check run. This narrows where this physical test can be reproduced; it does
not change the parser's operational contract or authorize host changes elsewhere.

## Directed controls and execution

L03 invokes one native-memory case, one external KILL of its own gated CPU case,
and one CPU watchdog case, consecutively. Every case owns a different slice and
container. There are no workload retries, skips or alternate-profile fallbacks.
The controls require zero memory events and reject the same OOM acceptance
function, even though their exit status is 137. One failed case stops this finite
sequence; cleanup and evidence retain the failure.

`node --test --test-concurrency=1 tests/intake/t01/l03_reference.mjs` exercises
literal independent observations, the actual orchestration with directed ports,
and bounded synthetic attached clients. It does **not** allocate native memory
or execute Docker. `test_summary.mjs` includes these checks in the existing
contract-verification path. The ordinary physical entry remains
`npm run test:intake:limits`; its source snapshot now includes both reference
modules and the gate. The existing artifact upload retains the per-case records.

The old comparison's unit tests now consume `l03_compared_runner.txt`, the exact
53,645-byte runner with SHA256
`4acd0e63a24939cc93da594273b51b5696679ed1392bfe41cdb4e72865d7ae63`.
This preserves its reviewed historical input rather than silently retargeting
it at a different test. Its closed workflow opportunity and original source pin
are unchanged. Running those synthetic tests does not repeat the A/B experiment.

## Failure-path delta: B01–B03

The ordinary command executor still refuses new work after an evidence failure
or the group deadline. Reference postmortem reads and local cleanup instead share
a separately registered 20-second command allowance. Each command's timeout is
capped by its remaining allowance; expiration requests SIGKILL and cannot count
as command success. Closing the owned attached client has its existing separate
one-second bound. Terminal command records may use the existing 4 MiB reserve,
without increasing the 2 GiB total or the ordinary evidence ceiling. Failed
writes remain recorded; the recovery lane does not clear them or make the run
successful. These are execution/admission bounds, not a guarantee against every
unresponsive host or filesystem failure.

Before the first resource-changing command, the runner retains the exact nonce,
slice name, container name and reconciliation callback. Observed IDs, slice
inode/invocation and local cleanup results complete that reservation. Final
cleanup retries unresolved reservations through a new bounded allowance, also
limited by its existing 60-second outer deadline. It does not search unrelated
labels or widen ownership. A lost removal reply remains unconfirmed until a new
identity-scoped inventory establishes absence. A foreign container is retained;
an occupied or unverified slice is not stopped. Historical failures and local
cleanup failure remain visible even when final reconciliation succeeds.

The attached process's observed result and container outcome are accumulated
before exporting the command record. On failure after process termination,
bounded postmortem inspection reads the still-owned reference before disposal,
retaining every available terminal fact. A failed export does not prevent this
read, and another failed export does not postpone cleanup indefinitely. Failure
does not acquire an OOM verdict simply because some observations are available.

The first thrown error keeps its object identity. Later postmortem, cleanup and
final-export failures remain secondary observations. If the per-case terminal
file cannot be written, `referenceFailure(error)` exposes the assembled record
and secondary errors to the runner, whose failed case includes the record in
`results.json`. An export-only failure still fails the case. This is a supported
terminal route, not guaranteed durability when every output destination fails.

`l03_failure_paths.mjs` adapts the retained review discriminator: the actual
adapter and shared executor function bodies run against explicit synthetic
kernel, process and filesystem interfaces with the actual output collector.
The tests distinguish local cleanup from outer reconciliation, preserve foreign
owners, exercise a lost removal reply and check terminal outcome/counters after
an attached-command export failure. The final-error tests assert object identity
and the runner's terminal-case route. Source mutations remove only these new
failure-path protections; the previously reviewed oracle is unchanged.

## Evidence still required

The current correction has not produced a physical Linux result. Required before
claiming L03 solved: actual positive and both negative controls, retained kernel
reference after exit, correct effective bounds and process identity, and confirmed
container/slice cleanup on the authorized runner. The partial/failure paths of the
Linux adapter also need review; synthetic ports do not certify their physical
execution. A timeout, unavailable reference or unexplained cleanup outcome stays
failed, not accepted by Docker's flag or by a later green run.
