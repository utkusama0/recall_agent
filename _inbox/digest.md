# RECALL Inbox — running capture buffer
# One block per study session. Paste output of the /capture command here, then push.
# The nightly-generate routine processes unprocessed blocks (those not starting with <!--PROCESSED).
# DO NOT delete processed blocks — they are your audit trail.

## Mutex Locks · 2026-06-15 · deck:CS::OSTEP::ch28-locks · src:OSTEP-ch28

[def:1] A mutex lock is a synchronization primitive that grants exclusive access to a critical section.
[mech:2] Test-and-set atomically writes 1 and returns the old value, enabling spin-lock implementation.
[why:3] Spin locks waste CPU cycles while waiting; OS-based sleep locks avoid this at the cost of a syscall.
[dist:4] Spin locks are preferred when the critical section is shorter than the cost of a context switch.
[edge:3] A spin lock on a uniprocessor without preemption will deadlock because the lock-holder never runs.
[invar:2] The lock invariant: exactly one thread holds the lock at any time while it is acquired.
[fail:4] Test-and-set without memory barriers allows the compiler to reorder critical-section accesses.
