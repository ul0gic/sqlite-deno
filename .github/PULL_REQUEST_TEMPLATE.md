<!-- New here? A draft PR with a clear question is a great way to start — see CONTRIBUTING.md. -->

## What and why

<!-- What does this change, and why is it needed? The diff shows the "what" — explain the "why". -->

## Checklist

- [ ] `deno task check` is green (fmt, lint, type-check, type-aware Biome, full test suite) — zero
      failures, zero warnings, zero suppressions.
- [ ] New behavior has tests. A durability or concurrency change comes with a harness proof **and**
      its negative control; a bug fix comes with a regression test.
- [ ] The permission model stays intact — no change needs a grant beyond
      `--allow-read`/`--allow-write` on the target database, and no code path acquires a permission
      the caller did not pass in.
- [ ] The change is focused — one logical change per PR.
