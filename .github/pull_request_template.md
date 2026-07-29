<!-- Feature PRs target `dev`, never `main` (gh pr create --base dev). AI must not merge to `main`. -->

## What & why

<!-- Short summary. Link the spec/feature (e.g. specs/001-platform-access-shell) and PRD/requirement IDs. -->

## Principles applied (Constitution I)

<!-- State which principle(s) this PR applies and make trade-offs explicit (duplication vs. abstraction).
     New abstractions MUST cite concrete duplication (≥3) or roadmap-backed near-term use. -->

## How to test

<!-- Required. Steps to verify, or why testing is not needed. -->

```powershell
pnpm install
docker compose -f infra/supabase/docker-compose.yml up -d
pnpm --filter @brazil-tms/db db:migrate
pnpm --filter @brazil-tms/db db:seed
pnpm --filter @brazil-tms/web dev
```

- [ ] Manual verification steps (see the feature's `quickstart.md`):
- [ ] Automated: `pnpm lint && pnpm typecheck && pnpm build && pnpm test` (+ `pnpm test:e2e` when a stack is available)

## Quality gates

- [ ] Lint + typecheck pass
- [ ] Build passes
- [ ] Tests pass (or N/A with reason)
- [ ] No new constitution violations (RLS deferral, BFF-only authz, no Realtime/Edge/Redis/microservices, service-role server-only)
- [ ] pt-BR UI; no hard-coded user-facing strings (SC-006)
