#!/usr/bin/env bash
# Brazil TMS — gera os 4 arquivos .env do deploy a partir de um cofre local de segredos.
#
#   ./devops/gen-env.sh                 gera (ou regenera) os .env reusando os segredos
#   ./devops/gen-env.sh --rotacionar    sorteia segredos NOVOS (só com banco vazio!)
#
# Nada de segredo mora no repositório: o cofre fica em $STATE_DIR/secrets.env (modo 600),
# fora do clone. Os .env gerados também são 600 e já estão no .gitignore do repositório
# (`.env` e `.env.*`) — confira com `git status` se mexer neles.
#
# O que é sorteado uma única vez e reusado para sempre:
#   POSTGRES_PASSWORD  — senha do Postgres (o initdb cria supabase_auth_admin com ela)
#   JWT_SECRET         — assina os tokens do GoTrue
#   ANON_KEY           — JWT HS256 role=anon      (publicável, vai para o navegador)
#   SERVICE_ROLE_KEY   — JWT HS256 role=service_role (SÓ servidor/worker)
#   ADMIN_PW           — senha temporária do primeiro admin (troca no 1º login)
#
# Regenerar os .env é seguro e idempotente. ROTACIONAR não é: as chaves precisam
# combinar com o volume do Postgres que já existe. Rotacione só em banco novo.
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/.." && pwd)"
# shellcheck source=config.env
. "$AQUI/config.env"

# Mesmo cálculo do ctl.sh (o ctl exporta STATE_DIR antes de chamar; standalone cai aqui).
ID="$SERVICO"; [ "$AMBIENTE" != "prod" ] && ID="$SERVICO-$AMBIENTE"
STATE="${STATE_DIR:-$KOMUNICK_BASE/data/$ID}"
COFRE="$STATE/secrets.env"

msg() { printf '%s\n' "$*"; }
erro() { printf 'ERRO: %s\n' "$*" >&2; }

command -v openssl >/dev/null 2>&1 || { erro "openssl não encontrado — é ele que sorteia os segredos e assina os JWTs."; exit 1; }

# base64url sem padding (formato dos JWT). Sem -w0 de propósito: nem todo base64 tem.
b64url() { base64 | tr -d '\n' | tr '+/' '-_' | tr -d '='; }

# Assina um JWT HS256 no formato canônico do Supabase.
mint() { # $1=segredo  $2=role
  local hdr pay seg sig
  hdr=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
  pay=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$2" "$IAT" "$EXP" | b64url)
  seg="$hdr.$pay"
  sig=$(printf '%s' "$seg" | openssl dgst -sha256 -hmac "$1" -binary | b64url)
  printf '%s.%s' "$seg" "$sig"
}

mkdir -p "$STATE" || { erro "não consegui criar $STATE"; exit 1; }
chmod 700 "$STATE" 2>/dev/null

if [ "${1:-}" = "--rotacionar" ] && [ -f "$COFRE" ]; then
  msg "!! ROTACIONANDO os segredos. Isto só funciona com o volume do Postgres VAZIO."
  msg "!! Com um banco já existente, o GoTrue e o app param de autenticar."
  mv "$COFRE" "$COFRE.antigo-$(date +%Y%m%d-%H%M%S)"
fi

if [ -f "$COFRE" ]; then
  # shellcheck source=/dev/null
  . "$COFRE"
  msg "Segredos reaproveitados de $COFRE"
else
  IAT=$(date +%s)
  EXP=$((IAT + 315360000)) # 10 anos
  PGPW=$(openssl rand -hex 18)       # 36 hex: seguro em URL e em SQL (sem @ : ' )
  JWT_SECRET=$(openssl rand -hex 24) # 48 hex (GoTrue exige >= 32)
  ADMIN_PW="Tms-$(openssl rand -hex 6)"
  ANON_KEY=$(mint "$JWT_SECRET" "anon")
  SERVICE_KEY=$(mint "$JWT_SECRET" "service_role")
  umask 077
  cat > "$COFRE" <<COFREFIM
# Cofre do deploy $ID — gerado por devops/gen-env.sh em $(date '+%F %T').
# NUNCA versione nem copie para o repositório. Faça backup junto com o volume do Postgres:
# as chaves e a senha do banco precisam continuar combinando com os dados.
PGPW="$PGPW"
JWT_SECRET="$JWT_SECRET"
ADMIN_PW="$ADMIN_PW"
ANON_KEY="$ANON_KEY"
SERVICE_KEY="$SERVICE_KEY"
COFREFIM
  chmod 600 "$COFRE"
  msg "Segredos NOVOS sorteados e guardados em $COFRE"
fi

for v in PGPW JWT_SECRET ADMIN_PW ANON_KEY SERVICE_KEY; do
  [ -n "${!v:-}" ] || { erro "cofre $COFRE incompleto (falta $v). Apague-o e rode de novo, ou restaure o backup."; exit 1; }
done

# URLs internas (o host falando com os containers) x URL pública (o navegador).
GW_LOCAL="http://127.0.0.1:$GATEWAY_PORT"
DB_URL="postgres://postgres:$PGPW@127.0.0.1:$DB_PORT/postgres"

umask 077

# --- 1/4 infra/supabase/.env — lido pelo docker compose ---------------------
cat > "$REPO/infra/supabase/.env" <<FIM
# Gerado por devops/gen-env.sh ($ID) — NÃO EDITE À MÃO, NÃO VERSIONE.
POSTGRES_PASSWORD=$PGPW
POSTGRES_DB=postgres
SUPABASE_DB_PORT=$DB_PORT
SUPABASE_GATEWAY_PORT=$GATEWAY_PORT
SUPABASE_MAILPIT_PORT=$MAILPIT_PORT

# Endereços que o GoTrue coloca nos links de convite/recuperação: precisam ser
# alcançáveis pelo NAVEGADOR do usuário, não só de dentro da VM.
API_EXTERNAL_URL=$SUPABASE_PUBLIC_URL
SITE_URL=$SITE_URL
ADDITIONAL_REDIRECT_URLS=$SITE_URL/**

JWT_SECRET=$JWT_SECRET
ANON_KEY=$ANON_KEY
SERVICE_ROLE_KEY=$SERVICE_KEY

SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_USER=mailpit
SMTP_PASS=mailpit
SMTP_ADMIN_EMAIL=noreply@braziltransports.com.br
SMTP_SENDER_NAME=Brazil Transports TMS

SLA_SWEEP_CRON=*/5 * * * *
DOCUMENTS_BUCKET=documents
EXPORTS_BUCKET=billing-exports
DOCUMENT_MAX_BYTES=10485760
DOCUMENT_CHECKS_CRON=*/5 * * * *
FIM

# --- 2/4 apps/web/.env.local — Next.js (UI + BFF) ---------------------------
# NEXT_PUBLIC_* é embutido no bundle em tempo de BUILD: mudou aqui, tem que buildar.
{
cat <<FIM
# Gerado por devops/gen-env.sh ($ID) — NÃO EDITE À MÃO, NÃO VERSIONE.
# Precisa existir ANTES do build: as NEXT_PUBLIC_* entram no bundle do navegador.
NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_PUBLIC_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY
NEXT_PUBLIC_SITE_URL=$SITE_URL
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY
DATABASE_URL=$DB_URL

SEED_ADMIN_EMAIL=$ADMIN_EMAIL
SEED_ADMIN_PASSWORD=$ADMIN_PW

DOCUMENTS_BUCKET=documents
EXPORTS_BUCKET=billing-exports
DOCUMENT_MAX_BYTES=10485760
DOCUMENT_CHECKS_CRON=*/5 * * * *
FIM
if [ -n "$ANTHROPIC_API_KEY" ]; then
  printf '\n# Extração de documento por IA (opcional; sem a chave a rota responde 503).\nANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY"
else
  printf '\n# ANTHROPIC_API_KEY não definida: a extração por IA fica desligada (503), o resto funciona.\n'
fi
} > "$REPO/apps/web/.env.local"

# --- 3/4 packages/db/.env — drizzle-kit migrate + seeds ---------------------
cat > "$REPO/packages/db/.env" <<FIM
# Gerado por devops/gen-env.sh ($ID) — NÃO EDITE À MÃO, NÃO VERSIONE.
# Lido via dotenv com CWD=packages/db (drizzle.config.ts e os seeds).
DATABASE_URL=$DB_URL
NEXT_PUBLIC_SUPABASE_URL=$GW_LOCAL
SUPABASE_URL=$GW_LOCAL
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY
SEED_ADMIN_EMAIL=$ADMIN_EMAIL
SEED_ADMIN_PASSWORD=$ADMIN_PW
IMPORT_BUCKET=imports
DOCUMENTS_BUCKET=documents
EXPORTS_BUCKET=billing-exports
FIM

# --- 4/4 workers/.env — worker pg-boss no host ------------------------------
cat > "$REPO/workers/.env" <<FIM
# Gerado por devops/gen-env.sh ($ID) — NÃO EDITE À MÃO, NÃO VERSIONE.
# Lido via dotenv com CWD=workers.
DATABASE_URL=$DB_URL
SUPABASE_URL=$GW_LOCAL
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY
IMPORT_BUCKET=imports
DOCUMENTS_BUCKET=documents
EXPORTS_BUCKET=billing-exports
DOCUMENT_MAX_BYTES=10485760
SLA_SWEEP_CRON=*/5 * * * *
DOCUMENT_CHECKS_CRON=*/5 * * * *
FIM

chmod 600 "$REPO/infra/supabase/.env" "$REPO/apps/web/.env.local" \
          "$REPO/packages/db/.env" "$REPO/workers/.env" 2>/dev/null

msg "Escritos (modo 600):"
msg "  infra/supabase/.env"
msg "  apps/web/.env.local"
msg "  packages/db/.env"
msg "  workers/.env"
msg ""
msg "Endereço do sistema : $SITE_URL"
msg "Gateway Supabase    : $SUPABASE_PUBLIC_URL"
msg "Admin               : $ADMIN_EMAIL"
msg "Senha temporária    : $ADMIN_PW   (o sistema força a troca no primeiro login)"
msg "Cofre               : $COFRE"
