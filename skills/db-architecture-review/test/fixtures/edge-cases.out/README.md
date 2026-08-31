# Edge cases

Every construct the sample schema lacks, so the port is exercised on real parser output.

10 tables · 76 columns · 10 foreign keys · 9 errors · 8 warnings · 11 notes

See [FINDINGS.md](FINDINGS.md) for the design review.

## Conventions

- The tenant column is org_id.

## Domains

| Domain | Tables | Findings |
|---|---|---|
| [Core](domains/core.md) | 4 | 4 |
| [Work](domains/work.md) | 7 | 23 |

## Diagram

```mermaid
erDiagram
  org {
    bigserial id PK
    text name
    varchar_10 kind
    real fee
    numeric_14_2 weight
    text tags
    jsonb settings
    timestamp_3 created_at
    integer score
    double_precision ratio
    boolean active
    char_2 note
    smallint seq_no
    mood feeling
  }
  widget {
    uuid id PK
    bigint org_id FK
    integer c01
    integer c02
    integer c03
    integer c04
    integer c05
    integer c06
    integer c07
    integer c08
    integer c09
    integer c10
    integer c11
    integer c12
    integer c13
    integer c14
    integer c15
    integer c16
    integer c17
    integer c18
    integer c19
    integer c20
    integer c21
    integer c22
    integer c23
    integer c24
    integer c25
    integer c26
    integer c27
    text extra
  }
  attachment {
    uuid id PK
    bigint org_id FK
    uuid widget_id FK
    uuid ticket_id FK
  }
  ticket {
    uuid id PK
    bigint org_id FK
    text email
    varchar_12 state
    smallint priority
    text label
    text assignee
    text alt_email
    timestamptz deleted_at
  }
  profile {
    uuid id PK
    bigint org_id FK UK
    text bio
  }
  region {
    bigint org_id PK FK
    char_3 code PK
    uuid lead_id FK
  }
  site {
    uuid id PK
    bigint org_id FK
    char_3 region FK
  }
  scratch {
    serial id PK
    text body
  }
  job_state {
    uuid id PK
    bigint org_id FK
    text status
    text state
    integer uses
    integer max_uses
  }
  app_config {
    integer id PK
    text site_name
  }
  org ||--o{ widget : "org_id"
  org ||--o{ attachment : "org_id"
  widget |o--o{ attachment : "widget_id"
  ticket |o--o{ attachment : "ticket_id"
  org ||--o{ ticket : "org_id"
  org ||--|| profile : "org_id"
  org ||--o{ region : "org_id"
  site |o--o{ region : "lead_id"
  region ||--o{ site : "org_id, region"
  org ||--o{ job_state : "org_id"
```
