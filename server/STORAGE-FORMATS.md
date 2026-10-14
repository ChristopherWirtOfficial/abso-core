# Storage format upgrades and rollback

Notes for operators who upgrade or roll back the open server's storage. Most deployments never need them.

Disk-first runtime format 4 is required before compressed projection-priority pages, chunked retry receipts chunked atom-text references or indexed atom-list references are written. Preparation upgrades a format-1, format-2 or format-3 namespace atomically. Older runtimes refuse that namespace before reading or writing; rolling back the executable does not make its derived data readable.

To return to an older runtime, keep writes disabled and rebuild its derived writer, projection and historical namespaces from the canonical log using a compatible implementation. Do not lower the format marker in place. Preserve retry receipts or explicitly resolve outstanding retries before changing their storage format. This is an activation boundary, not authorization to delete project data. The canonical log is unchanged by the format upgrade.


Runtime format 3 also fences chunked atom-text references. Runtimes that only understand format 2 must refuse these derived namespaces. Do not lower the marker to roll back; rebuild compatible derived state while preserving canonical history and retry receipts.

Format 4 additionally fences atom-list references. A format-3 executable must refuse a format-4 namespace; it cannot safely interpret the placeholder arrays.

Format 5 additionally fences indexed insertion runs and lines. Preparation accepts recognized formats 1 through 4 and upgrades atomically. Older executables must refuse format 5. Never lower the marker to roll back.
