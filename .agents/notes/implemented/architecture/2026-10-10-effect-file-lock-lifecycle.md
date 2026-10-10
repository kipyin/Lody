# Native Effect file locks and fair ownership handoff

Status: implemented
Translation: current
PR: [#1377](https://github.com/LodyAI/Lody/pull/1377)

[中文](2026-10-10-effect-file-lock-lifecycle.zh.md)

## Abstract

Promise lock queues and timer retries obscured cancellation and swallowed cleanup failures. A FileLocks Layer now owns FIFO admission and failed-release generations; scoped operations publish complete metadata through exclusive hard links, with one compatibility runtime for unmigrated callers. Clock/Schedule preserve contention deadlines and stale-lock policy. The skill audit still identifies unbounded stalled filesystem cleanup and retry dropping lock-release errors alongside body failures. Linux tests verify implemented behavior; real Windows and unsupported filesystems remain unverified.

## Decision and evidence

The dependency and delivery owner remains the [migration roadmap](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md). This is the first unit after the merged process foundation (#1065, #1069, #1348), using the existing native `probePid` rather than executing its synchronous compatibility API.

The official `FileSystem` service and `NodeFileSystem.layer` supply I/O. `FileLockHost` fixes the pid and supplies a directory resolver evaluated for each operation; core tests may inject a fixed directory. Correction: the initial composition-time directory snapshot changed the old per-operation environment semantics and has been removed. Official sources checked against installed Effect and platform-node-shared 4.0.2 include `FileSystem.ts`, `NodeFileSystem.ts`, `Semaphore.ts`, `Deferred.ts` and `internal/effect.ts`.

Two tempting implementations failed inspection or experiments:

1. **Semaphore alone does not preserve strict admission order.** A retained behavioral test queues two callers, then has the holder immediately request the same lock again. On installed 4.0.2 it produced holder → newcomer → second → third. Ref atomically registers tickets and Deferred directly reserves the next owner's permission before a newcomer can register. Cancellation removes its own ticket without waiting on an earlier holder. The same test now requires holder → second → third → newcomer.
2. **Asynchronous `wx` plus metadata write exposes an empty file.** The old synchronous write did not yield in that window. Another process can classify the empty file as malformed and take over during an async write. A private scratch directory owns the fully written candidate; `FileSystem.link` exclusively publishes it at the unchanged `.lock` path. Failed preparation and interruption remove scratch. Metadata preparation stays interruptible under its candidate owner; only exclusive publication masks cancellation until its result and registered release can be joined. Behavioral tests cancel at both boundaries. No second spawn, collector or termination backend is introduced.

Each successful publication registers release before running the body. A release checks pid and token, reports `LockReleaseFailed` and retains the unresolved token in its owner. The next caller first retries that release. Failed scratch removal is retained too;
Layer finalization retries unresolved releases and surfaces an aggregate failure if
any remain. The acquisition timestamp is refreshed for each publication attempt,
so cross-process waiting does not shorten the existing stale-age window. Missing files are already gone; unreadable files fail rather than becoming stale. Malformed readable metadata and the 30-minute takeover policy remain unchanged. Reclamation rechecks observed content before removal. Correction: if the content changed and the file still exists, reclamation returns to scheduled backoff and the contention deadline; only confirmed absence or successful removal allows immediate retry. This preserves a cooperative file protocol, not a compare-and-unlink kernel primitive or an advisory-lock guarantee across expired-owner takeover.

## Preserved lock policy

Every operation resolves its directory using explicit `locksDir`, the current
`LODY_LOCKS_DIR`, then the current installation profile's `locks` directory
(including current `LODY_DATA_DIR`). The process-lifetime compatibility runtime
does not cache this resolution. Names replace characters outside
letters, digits, underscore and hyphen with underscore and append `.lock`.
Same-context acquisition of the same resolved path, including sanitized aliases
and child fibers, fails immediately; different names may nest.

The default 30-second `timeout` starts after local FIFO admission. It bounds only
contention on another file owner, not local queue waiting, body execution or
filesystem I/O. Retry delays start at 100 ms, grow by 1.5 and cap at two seconds;
a configured first delay is used unchanged even above the cap, with subsequent
delays capped. Negative or non-finite delays fail with `LockIoError` before
admission. Elapsed time is checked after a failed attempt, so a retry may overshoot
by its delay; this is not a strict I/O deadline.

A fresh pid belonging to this user keeps its lock. Missing or foreign-user pids,
malformed readable metadata and age over 30 minutes permit stale reclamation.
There is no heartbeat; expired live holders remain subject to the existing
takeover policy. Stale cleanup scans `.lock` files and `.lody-lock-*` scratch
directories without opening documents or starting work. Correction: normal
finalizers and the in-memory failed-release registry cannot collect crash
leftovers. Complete scratch metadata uses the same pid/age policy as locks, so
fresh live owners retain both published and waiting candidates. Missing or
incomplete metadata requires more than 30 minutes since the latest available
directory/owner mtime; unavailable mtimes retain the directory. Recheck owner
contents before recursive removal. This grace period protects active preparation
while allowing abandoned empty or partially written candidates to be collected.
Filesystem failures remain observable. Hard-link support is
required; unsupported filesystems fail visibly. This remains a cooperative
file protocol, not a kernel advisory lock or a crash transaction.

## Consumer boundary and deletion conditions

```text
FileLocks Layer instance (Ref registry + Deferred tickets)
  └─ admitted operation → owned candidate → exclusive publication
       └─ native body → verified release → FIFO handoff
fileLocksLegacy (one process-lifetime ManagedRuntime)
  ├─ withLock: worktree / cloudflared / Baguette Promise bodies
  └─ runPromise: catalog mutations at existing application entrypoints
```

Catalog mutations now compose `withFileLock` and expose FileLocks in their environment. Its Promise write queue and nested Effect execution are deleted. The short file read/modify/write body remains uninterruptible until its original filesystem Promises settle, preventing lease release while a write continues. This gives no crash recovery or cross-peer transaction guarantee. Catalog read caching still has its old Promise refresh logic and is not declared fully migrated.

The old Promise `withFileLock` export is replaced by the native Effect API. `cleanupStaleLocks` is native; no production caller needed a synchronous compatibility cleanup entry. The sole `fileLocksLegacy` object is deprecated and its name remains visible in imports and calls. Worktree and installation entrypoints retain their Promise workflows; their callbacks receive caller cancellation directly and are joined in the body before release. A callback ignoring its signal can delay cancellation. Finalizers do not wait on an unbounded Promise body. Remove the compatibility object and async-context bridge after these entrypoints use the daemon runtime; provide one FileLocks instance in that root so separate service instances do not accidentally charge local contention as cross-process waiting.

Native programs crossing fileLocksLegacy.runPromise use #1379's squashProcessFailure, preserving simultaneous body failure and every process recovery lease. Direct Cause.squash loses the lease and is caught by the resource-state test. This adds no lock kernel or execution facade. The lock protects program execution; transferred failed process resources are not reported released.

## Verification

The owning suite exercises strict FIFO with immediate reacquisition, queued and cross-process waiter cancellation, failed/interrupted bodies, stale and foreign pid reclamation, reentry through sanitized aliases and child fibers, metadata write failure, release failure retention/retry, and replacement-token protection. A real Node child uses readiness IPC to verify mutual exclusion in both directions; it starts and stops through the existing process service. CLI adapter tests retain profile paths and naming; duplicate stale/live-lock cases move into the native suite. Catalog, worktree and cloudflared consumption retain behavioral coverage.

Initial migration verification: all fourteen ablations were caught: admitting every ticket, retaining cancelled tickets, skipping release, swallowing release failure, removing the generation check, allowing reentry, overwriting publication, freezing publication age, dropping failed scratch ownership, rejecting confirmed scratch absence, making publication interruptible, masking metadata preparation, losing process recovery leases, and skipping Layer cleanup. Baseline and restored source pass 21 tests. Experiments use a throwaway copy; scripts and source-string tests do not ship. After integrating #1379, file-lock 21, process 40 and relevant CLI 38 tests pass. The integrated full pnpm check passes: CLI 3692 cases, shared 113 files / 1389 cases, Electron 214 cases and all guards. Type-aware lint has zero errors. The previously reproduced Roost signed-prefix timeout passes in this complete run. Git/PATH, temporary-package scope and lock-directory contamination are isolated only in validation child processes, without changing global Git configuration or removing coverage. The stack now uses #1379 as its base, with fixed Effect 4.0.2. Process/platform/public/import/i18n guards, format, format:check and docs check pass. Local Linux results do not establish real Windows, hard-link behavior on other filesystems, delegated cgroups, packaging or end-to-end ACP/Session/Turn cancellation. Windows descendant ownership after root exit remains unfinished.

The three review corrections add behavior tests to the same suite: environment defaults change within one compatibility runtime (also explicit override and profile fallback), continually replaced stale generations still time out and leave the replacement intact, confirmed disappearance retries without sleeping, and crash leftovers are collected without deleting live published/waiting candidates or fresh unidentified directories. Before the fixes, three of these regressions fail; after the fixes the full 25-case lock suite passes, including real cross-process mutual exclusion. Four temporary ablations are caught: freezing environment defaults, immediately retrying changed content, backing off after confirmed disappearance, and skipping crash-scratch cleanup. Restored source passes the full suite; scripts are not committed. The nine relevant CLI consumer suites pass 129 cases. These fixtures use real files and injected Clock/FileSystem boundaries, not source-string assertions or mock call counts.

Latest assembled-stack validation against main 2e9482723e869fca7bea52fd5f036a37c53787e1: `pnpm check` completes workspace types and type-aware lint with zero errors, then stops at the previously reproduced Roost signed-prefix 30-second timeout; CLI has 3748 passed and one skipped case. Supplemental Shared passes 112 files / 1407 cases and Electron passes 215 cases. The focused shared suites pass 127 cases and seven CLI consumer suites pass 99. Format, format:check, shared-source formatting, all five boundary guards, initial docs status and final docs check pass. Effect remains pinned to 4.0.2; main's locked Loro 0.22.0 is used. No coverage or global Git configuration is changed; only validation child processes isolate injected Git, PATH, lock and temporary-directory inputs. This verifies Linux, not real Windows/macOS, other filesystems, delegated cgroups, packaging or production.

## Remaining filesystem cleanup bound

The main-branch Effect skill audit confirms a remaining lifecycle limit: lock
release, candidate removal and Layer recovery currently await filesystem I/O
without an independent cleanup deadline. A temporary real-file experiment gates
the injected remove operation with Deferred; after ten minutes of TestClock
advancement, both the holder and its awaited interruption are still pending.
Opening the gate completes cleanup and leaves no files. The experiment does not
ship. The contention timeout does not bound these waits, and existing immediate
release-failure tests do not establish bounded shutdown when I/O never settles.

A follow-up should retain the original in-flight cleanup operation and its owner,
bound the caller's wait, and keep that lock generation unavailable until actual
completion is known. Merely making unlink interruptible and adding timeout is
unsafe: cancellation of a local waiter does not prove the underlying OS unlink
stopped; a late unlink could remove a replacement at the reused lock path. This
is a proposed cleanup improvement, not implemented by the main synchronization.

A second real-file experiment exposes a distinct failure-path gap: a failed body
plus PermissionDenied removing its lock leaves the lock retained, but the native
result contains only the body's failure. In pinned 4.0.2, the surrounding
Effect.retry selects the first error when all Cause reasons are Fail; stopping
the Schedule re-fails that error and loses the release failure. Retry should cover
only acquisition's single LockBusy, with the body and release outside it. The
Legacy projection should also preserve lock cleanup failures alongside the primary
error, as its current projection preserves only process recovery leases. The
full-Cause requirement fails in the temporary experiment; subsequent recovery
still succeeds when deletion becomes available. No product fix is claimed here.
