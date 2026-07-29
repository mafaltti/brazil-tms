# Feature 001 — Self-test guide (Platform, Access & App Shell)

How to stand up the validated local stack and test what's implemented. Host: Windows + PowerShell.
Prereqs: Docker Desktop running, Node 20+/pnpm, `pnpm install` already done.

> Your local `.env` files already exist (gitignored): `infra/supabase/.env`, `apps/web/.env.local`,
> `packages/db/.env`. If on a fresh machine, copy each `.env.example` and fill in (demo JWT keys are
> fine for local — see `infra/supabase/.env.example`).

## 1. Bring it up

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d        # Postgres + GoTrue + gateway + Mailpit
# Wait until GoTrue is healthy (it migrates on first boot):
curl http://localhost:8000/auth/v1/health                        # -> {"name":"GoTrue",...} HTTP 200

pnpm --filter @brazil-tms/db db:migrate                          # create public.users / audit_logs / app_role
pnpm --filter @brazil-tms/db db:seed:e2e                         # seed the 4 test accounts below
pnpm --filter @brazil-tms/web dev                                # app on http://localhost:3000
```

- Mailpit (catches invite/recovery emails): **http://localhost:8025**
- If host port 5432 is taken, `SUPABASE_DB_PORT=5433` is already set in `infra/supabase/.env`.

## 2. Test accounts (from `db:seed:e2e`)

| Email | Password | Role | State |
|---|---|---|---|
| admin@braziltransports.com.br | `ChangeMe!Admin123` | Admin | active (ready) |
| finance@braziltransports.com.br | `ChangeMe!Finance123` | Finance | active (non-admin) |
| temppw@braziltransports.com.br | `ChangeMe!Temp123` | Dispatcher | must change password |
| disabled@braziltransports.com.br | `ChangeMe!Disabled123` | Dispatcher | disabled |

> To instead experience the real first-Admin bootstrap (forced change on first login), run
> `pnpm --filter @brazil-tms/db db:seed` — it creates only `admin@…` with `must_change_password=true`.

## 3. Automated tests

```powershell
pnpm lint ; pnpm typecheck ; pnpm build ; pnpm test    # unit/static gate (159 unit tests)

# End-to-end (needs the stack up + a CLEAN DB with the e2e accounts). Reset first on re-runs:
docker exec brazil-tms-supabase-db-1 psql -U postgres -d postgres -c "TRUNCATE public.audit_logs, public.users CASCADE;"
pnpm --filter @brazil-tms/db db:seed:e2e
pnpm --filter @brazil-tms/web exec playwright test --workers=1   # 27 specs; serial avoids races on the shared admin
# (with the app already running) prefix:  $env:PLAYWRIGHT_BASE_URL="http://localhost:3000"
```

## 4. Manual walkthrough (maps to the spec's Success Criteria)

Open http://localhost:3000. The whole UI is in **pt-BR**.

1. **Auth guard (SC-001).** While logged out, visit `/admin/users` → bounced to `/login`.
2. **Login (US1).** Sign in as **finance@** → lands on the shell home. Wrong password → "E-mail ou
   senha inválidos." (no session). **disabled@** → "Sua conta está desativada." (SC-007).
3. **Forced password change (FR-013a).** Sign in as **temppw@** → redirected to `/auth/set-password`
   → set a new password → lands on the shell.
4. **Forgot password (US1).** `/forgot-password` → submit any email → neutral message (no disclosure).
   A real recovery email shows up in **Mailpit** (:8025).
5. **Role-aware nav (US2 / SC-002).** As **finance** the sidebar has no "Usuários e Perfis" /
   "Auditoria". As **admin** both appear.
6. **Server-side enforcement (SC-003).** As **finance**, browse directly to `/admin/users` → bounced
   home. (API check: `GET /api/admin/users` without admin → 403, no data.)
7. **Users & Roles (US3).** As **admin** → *Administração → Usuários e Perfis*:
   - **Novo usuário** → *Definir senha temporária*: user is created active and must change password on
     first login. *Enviar convite por e-mail*: user is created **pending**; the invite email appears in
     Mailpit — open the link to set a password (becomes active on first sign-in).
   - Change a user's **role** (note: new users default to the read-only *Visualizador Executivo*).
   - **Desativar / Ativar** a user. Re-create with an existing email → "Já existe um usuário…".
   - Try to **disable or down-role the only admin** → "Não é possível desativar ou rebaixar o último
     administrador ativo." (last-admin guard, FR-016).
8. **Audit (US4 / SC-005).** As **admin** → *Auditoria*: every create / role change / status change you
   just did appears with who/what/when/before/after. There's no way to edit or delete entries.
9. **Disable mid-session (SC-007).** Sign in as a user in a 2nd browser; as admin disable them; their
   next action bounces to `/login`.

## 5. Tear down

```powershell
docker compose -f infra/supabase/docker-compose.yml down -v   # stop + wipe the DB volume
# stop the dev server with Ctrl+C in its terminal
```
