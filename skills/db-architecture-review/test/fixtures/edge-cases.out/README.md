# Edge cases

Every construct the sample schema lacks, so the port is exercised on real parser output.

8 tables · 68 columns · 9 foreign keys · 9 errors · 8 warnings · 8 notes

See [FINDINGS.md](FINDINGS.md) for the design review.

## Conventions

- The tenant column is org_id.

## Domains

| Domain | Tables | Findings |
|---|---|---|
| [Core](domains/core.md) | 2 | 3 |
| [Work](domains/work.md) | 7 | 21 |
