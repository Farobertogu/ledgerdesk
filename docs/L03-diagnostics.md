# L03 bounded diagnostic capture

## Scope of this record

This document records the earlier bounded observer and its identified September 14 executions.
The current L03 acceptance oracle is the [exclusive retained kernel reference](L03-exclusive-reference.md),
merged in PR #32 and qualified on its final PR and actual main. It no longer treats Docker's
OOM flag as the acceptance oracle. The descriptions and results below remain scoped to the
earlier observer; its historical failures and unknown cause are not rewritten by that repair.

At this observer checkpoint, L03 required the original first inspection to report `OOMKilled=true` and exit 137. The memory probe, allocation pattern, ten-second watchdog, output cap, cgroup limits, swap policy and privileges were unchanged. Later metadata and Docker events never replaced that assertion. This instrumentation was not a causal fix for the observed remote failure.

## Captured observations

Only the memory probe invokes `ci/intake_l03_observer.mjs`. Before launch it binds the full container and image IDs, projects effective limits, hashes image configuration, retains layer identities, and hashes the actual probe and entrypoint bytes copied from that stopped container. It compares probe bytes with the retained source. No code executes in the target cgroup to identify these files. The executable binary hash is not collected.

An external Docker event client is started before the workload, with both container type and exact container ID filters and a bounded `since` time. Event nanoseconds remain decimal strings. The public projection contains only selected lifecycle actions, the target ID, time, exit code and signal: no arbitrary attributes, environment, bodies, container logs or general host logs. The first inspection is saved in its original position. One additional inspection follows a fixed 250 ms delay; there is no polling until a desired result appears.

On an observed start, one external inspection obtains the target PID. On Linux only, a separately bounded unprivileged host process attempts at most four leaf samples of `memory.events`, `memory.events.local` and `memory.peak`, spaced 50 ms apart. The `/proc` membership and resolved cgroup path must contain the full target container ID and remain under the resolved cgroup root. No mount, privilege, reset, ancestor traversal or host setting is added. Windows, a remote daemon, a removed cgroup, denied access or an unbound namespace yields an explicit unavailable observation, not zero counters. Ancestor counters, host pressure and the originating kernel kill decision remain unobserved. The dated observation below confirms this path only in its identified runner, not in every Linux or remote-daemon configuration.

`memory.events` is hierarchical; `.local` is local. Even a leaf `oom_kill` increment counts victims of any kind of OOM killer, so it does not alone prove enforcement by that leaf's limit. Docker events and state must be read alongside counter scope and timing. [Kernel cgroup documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html).

## Primary result and observation completeness

The observer preserves the primary return value or thrown error. Its own failures have phase/error codes and cannot turn a failing L03 green. Failure to write the observation adds an evidence-export failure to the existing runner mechanism without replacing the primary assertion. A failed or absent first inspection stays absent; a later inspection cannot recreate it.

The expected probe digest is acquired inside a separate protected diagnostic attempt. The runner passes a deferred read bound to this run's retained `source/tests/intake/t01/probe.mjs`, not the current checkout. A read failure records only its safe error code under `expected-probe`, leaves `expectedProbe` unavailable and `probeMatchesSource` null, and still executes the primary work. A missing actual probe also makes the comparison unknown; two absent identities never compare equal. The manual calibration's already-provided digest remains supported. This correction preserves primary execution when optional identity acquisition fails; it does not explain the remote OOM observation.

`eventsComplete` describes the bounded client capture: intentional client stop, confirmed close, valid retained UTF-8 with no unfinished line, no malformed/wrong-target input, and observed start/die delimiters. It is not a guarantee that Docker/kernel emitted every relevant event. A missing, truncated, timed-out or invalid capture reports OOM/kill as unknown. Even a complete capture with no OOM event means no such event was observed, not proof that the kernel did not kill for memory. The record's digest detects alteration of that record; it is not authenticity evidence.

The event client kills only its own process when stopped or bounded. It never sends a stop/kill to the workload. The workload runner retains its original stop behavior on its own primary timeout/output limit.

## Maximum diagnostic cost

- At most six finite Docker metadata/copy/inspection commands, each bounded to 2 seconds plus 250 ms for client-close confirmation; each retains at most 256 KiB stdout and counts at most 8 KiB stderr before stopping. Raw streams are projected, not published.
- One event client, at most 15 seconds, 64 KiB stdout, 8 KiB stderr; one Linux leaf client, at most 1 second plus 250 ms close allowance and 16 KiB stdout. There is no ninth A/B comparison or automatic rerun.
- Four leaf samples at most, three files each, at most 4,096 bytes per file. The separate process contains even a stalled filesystem read.
- A conservative nominal upper bound on added serial observation waits is 16 seconds, excluding operating-system scheduling stalls and the original workload/inspection/file-write time. Workload and existing 20-minute group budgets are not enlarged. The event deadline can expire first, producing incomplete evidence instead of extending its lifetime.
- Observers add host-side overhead, not processes inside the memory cgroup. This changes observation conditions and must be considered in interpretation.

The full observation is written as `L03-observation.json` within the existing unique intake run directory and travels through its existing always-run artifact upload. Source snapshots include the helper. No workflow or product endpoint changes are required.

## Verification and reproduction

`node --test tests/intake/t01/test_summary.mjs` runs the existing test-summary checks and the new directed observer checks, through the existing C02 verification entry point. Tests cover exact target binding, nanosecond preservation, safe projection, copied-file identity, incomplete observations, unaltered primary failure/return, finite child cleanup, and the actual runner function's original inspection/save ordering. Controlled dependencies are distinguished from Docker execution.

The explicitly invoked `node tests/intake/t01/l03_calibration.mjs <existing-current-parser-image-id> --execute` creates exactly two owned containers: the original memory probe and an externally killed CPU control. The latter establishes that exit 137 can occur with a kill event and without observed OOM. Both use the original resource flags. Image/probe equality is required, not inferred from a retained tag. Calibrations are retained by unique run and are not an automatic CI campaign. A source/image mismatch or setup failure remains failed, with cleanup, rather than being credited as calibration success.

Each real remote observation must discriminate a target OOM event, a distinct kill event, changed later metadata, incomplete evidence, or a still-unknown cause. If leaf counters are unavailable or ambiguous, that limitation remains. A repair needs a demonstrated mechanism and a targeted regression; a later green job does not resolve the cause by itself.

## Observed remote qualification: 2026-09-14

[Run 34810451606](https://github.com/Farobertogu/ledgerdesk/actions/runs/34810451606), attempt 1, event pull_request, completed successfully for head `299f3dbe17919f0359f0db27a002a0df98261c51`. All eight jobs used test merge `1c8d2a8d29aadaa81f210e6a680900ac4f473951`, tree `b0c98bb1025edd6e6c81edf20917cc9a75d84542`. The source-identified limits run `2026-09-14T05-43-29-204Z-d1882efb` retained the original and later exit 137/OOMKilled=true inspections, a target OOM event and no target kill event in the complete bounded capture. C02 passed 32/32 and limits passed 9/9 with complete evidence and no reported resource residues.

The Linux target-leaf sampler obtained three samples and retained a fourth as unavailable (ENOENT). The third sample had memory.events.local max=19, oom=1, oom_kill=1 and memory.peak=536870912 bytes. These are scoped observations, not proof of the originating kernel kill decision or universal accessibility. The event client's SIGKILL with reason observer_stop records its own shutdown, not a target kill. Ancestor counters, host pressure and executable-binary identity remain unmeasured.

This run does not reproduce or explain the historical Azure result in [run 34795934228](https://github.com/Farobertogu/ledgerdesk/actions/runs/34795934228), where exit 137 had initial and later OOMKilled=false. That cause remains unknown. This successful run is not a successful full two-control Docker calibration of every final byte, a hosted cancellation experiment, or evidence for a subsequent documentary commit.
