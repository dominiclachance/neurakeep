# NeuraKeep end-to-end fixture

On 2026-10-24, the NeuraKeep test workspace chose an isolated SQLite vault for browser verification.

Decision: every browser run starts from a clean, deterministic memory source.

Failure to avoid: browser tests must not depend on a developer's existing `.umos` vault or another parallel test.
