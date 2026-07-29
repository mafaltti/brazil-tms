# Data Model — 016 Freight Rate Lookup

Two tables, one migration (0009). No enum changes; no existing table touched.

## freight_rate_imports

One row per successful replace-all upload (rejected uploads leave no row; they are
visible only as the 409 the uploader saw).

| column | type | notes |
|---|---|---|
| id | uuid PK default random | |
| file_name | text NOT NULL | as uploaded |
| uploaded_by | uuid NOT NULL → users.id | |
| route_count | integer NOT NULL | distinct origin→destination groups |
| rate_count | integer NOT NULL | rows inserted into freight_rates |
| created_at | timestamptz NOT NULL default now() | |

Index: `freight_rate_imports_created_idx (created_at desc)`.

## freight_rates

The live table — always exactly the content of the latest successful import.

| column | type | notes |
|---|---|---|
| id | uuid PK default random | |
| import_id | uuid NOT NULL → freight_rate_imports.id | provenance |
| origin_uf | text NOT NULL | 2-letter UF, uppercased |
| origin_city | text NOT NULL | trimmed, as in sheet (uppercase in practice) |
| destination_uf | text NOT NULL | |
| destination_city | text NOT NULL | |
| km | integer | nullable — "—" in UI, sorted last |
| vehicle_type | text NOT NULL | free label from sheet, uppercased (R3) |
| valor_ida_cents | bigint (number) | nullable (R4) |
| valor_reversa_cents | bigint (number) | nullable |
| observacoes | text | nullable, per-row (never filled down) |
| created_at | timestamptz NOT NULL default now() | |

Indexes:
- `freight_rates_unique_idx` UNIQUE (origin_uf, origin_city, destination_uf,
  destination_city, vehicle_type) — duplicate file rows are rejected before insert,
  this is the backstop.
- `freight_rates_origin_idx` (origin_uf, origin_city)
- `freight_rates_destination_idx` (destination_uf, destination_city)

## Normalization invariants (enforced by shared normalizer, R6)

- Header row must equal `FREIGHT_SHEET_HEADER` (9 columns; trailing empty columns
  ignored).
- Fill-down applies ONLY to origin_uf/origin_city/destination_uf/destination_city/km
  within a route group; Observações and Tipo Veículo are per-row.
- First data row must start a group (blank origin ⇒ file rejected).
- Prices: pt-BR formatted string, plain number, or `-`/blank (null); otherwise
  row+column error.
- Duplicate (route, vehicle_type) in file ⇒ file rejected listing rows.
- UFs uppercased and must be 2 letters; cities trimmed; vehicle label uppercased.
