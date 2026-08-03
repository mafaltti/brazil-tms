#!/usr/bin/env bash
# Brazil TMS — controle do deploy numa VM Linux: instalar, subir, parar, atualizar, diagnosticar.
#
#   ./devops/ctl.sh {install|ensure|start|stop|restart|status|logs|update}
#
# Aqui não é um servidorzinho Node como os outros sistemas Komunick: sobem TRÊS camadas,
# nesta ordem, e a de baixo tem que estar saudável antes da de cima:
#   1. stack Supabase em Docker  — postgres + gotrue (auth) + storage + caddy (gateway) + mailpit
#   2. Next.js (apps/web)        — no host, buildado, via pnpm (é a UI e o BFF)
#   3. worker pg-boss (workers/) — no host, via tsx (import, SLA, documentos, faturamento)
#
# O que este script NÃO faz: instalar Docker (precisa de root — veja devops/docker-install.sh)
# e adivinhar o endereço público da VM (PUBLIC_HOST no config.env). Detalhes, armadilhas e
# procedimento completo: devops/README.md.
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/.." && pwd)"
# shellcheck source=config.env
. "$AQUI/config.env"

# ---------------------------------------------------------------------------
# Configuração efetiva (ambiente > config.env > padrão calculado).
# ---------------------------------------------------------------------------
ID="$SERVICO"; [ "$AMBIENTE" != "prod" ] && ID="$SERVICO-$AMBIENTE"
STATE="${STATE_DIR:-$KOMUNICK_BASE/data/$ID}"
LOGS="${LOG_DIR:-$KOMUNICK_BASE/logs}"
if [ -z "$COMPOSE_PROJECT" ]; then
  if [ "$AMBIENTE" = "prod" ]; then COMPOSE_PROJECT="brazil-tms-supabase"
  else COMPOSE_PROJECT="brazil-tms-$AMBIENTE-supabase"; fi
fi

COMPOSE="$REPO/infra/supabase/docker-compose.yml"
INFRA_ENV="$REPO/infra/supabase/.env"
# Overlay de portas: fica FORA do repositório de propósito, para o clone nunca ficar sujo.
OVERRIDE="$STATE/compose.override.yml"
COFRE="$STATE/secrets.env"
PID_WEB="$STATE/web.pid"
PID_WORKER="$STATE/worker.pid"
TRAVA="$STATE/ensure.lock"
LOG_WEB="$LOGS/$ID-web.log"
LOG_WORKER="$LOGS/$ID-worker.log"
LOG_OPS="$LOGS/devops.log"
MARCA="# devops:$ID"

msg()   { printf '%s\n' "$*"; }
erro()  { printf 'ERRO: %s\n' "$*" >&2; }
aviso() { printf 'aviso: %s\n' "$*" >&2; }
titulo(){ printf '\n== %s ==\n' "$*"; }
ops()   { mkdir -p "$LOGS" 2>/dev/null; printf '%s %s %s\n' "$(date '+%F %T')" "$ID" "$*" >>"$LOG_OPS" 2>/dev/null; }

# ---------------------------------------------------------------------------
# Runtime: Node 22 + pnpm.
# ---------------------------------------------------------------------------
NODE=""; NODEDIR=""; PNPM=""

achar_node() {
  [ -n "$NODE" ] && return 0
  local n=""
  if [ -n "$NODE_BIN" ]; then
    [ -x "$NODE_BIN" ] || { erro "NODE_BIN aponta para algo que não é executável: $NODE_BIN"; return 1; }
    n="$NODE_BIN"
  else
    # O cron roda com PATH mínimo, então procurar no nvm vem antes de confiar no PATH.
    n=$(ls -d "$HOME"/.nvm/versions/node/v22*/bin/node 2>/dev/null | sort -V | tail -1)
    [ -z "$n" ] && n=$(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -1)
    [ -z "$n" ] && n=$(command -v node 2>/dev/null)
  fi
  [ -n "$n" ] || { erro "Node não encontrado. Instale a v22 (nvm install 22) ou preencha NODE_BIN no devops/config.env."; return 1; }
  NODE="$n"; NODEDIR="$(dirname "$n")"
  case "$("$NODE" -v 2>/dev/null)" in
    v22.*) : ;;
    v20.*) erro "Node $("$NODE" -v) não serve: na v20 o @supabase/realtime-js quebra todo createClient (\"no native WebSocket\"). Use a v22." ; return 1 ;;
    *)     aviso "rodando com Node $("$NODE" -v); o stack só foi validado na v22 — se aparecer erro estranho, comece por aqui." ;;
  esac
  return 0
}

achar_pnpm() {
  [ -n "$PNPM" ] && return 0
  achar_node || return 1
  if   [ -x "$NODEDIR/pnpm" ];        then PNPM="$NODEDIR/pnpm"
  elif command -v pnpm >/dev/null 2>&1; then PNPM="$(command -v pnpm)"
  else
    erro "pnpm não encontrado. Com o corepack do próprio Node:"
    erro "  \"$NODEDIR/corepack\" enable && \"$NODEDIR/corepack\" prepare pnpm@10.23.0 --activate"
    return 1
  fi
  return 0
}

# Roda pnpm com o Node certo no PATH e a partir de um diretório do repositório.
rodar_pnpm() { # $1=diretório  $2...=argumentos do pnpm
  achar_pnpm || return 1
  local dir="$1"; shift
  ( cd "$dir" && PATH="$NODEDIR:$PATH" "$PNPM" "$@" )
}

# ---------------------------------------------------------------------------
# Docker. Na mint-vm o usuário está no grupo docker sem ter relogado, então há
# o caminho alternativo `sg docker -c "..."`. Detecta uma vez e reusa.
# ---------------------------------------------------------------------------
DOCKER_MODO=""

detectar_docker() {
  [ -n "$DOCKER_MODO" ] && { [ "$DOCKER_MODO" != "ausente" ]; return; }
  if ! command -v docker >/dev/null 2>&1; then
    DOCKER_MODO="ausente"
    erro "docker não está instalado nesta VM. Precisa de root uma única vez: sudo bash devops/docker-install.sh"
    return 1
  fi
  if docker version >/dev/null 2>&1; then DOCKER_MODO="direto"; return 0; fi
  if sg docker -c "docker version" >/dev/null 2>&1; then DOCKER_MODO="sg"; return 0; fi
  DOCKER_MODO="ausente"
  erro "docker existe mas não responde para o usuário $(id -un). Ou o serviço está parado, ou falta estar no grupo docker:"
  erro "  sudo usermod -aG docker $(id -un)   (e abrir uma sessão nova)"
  return 1
}

# Argumentos fixos do compose: projeto próprio, .env explícito e o overlay de portas.
# --project-directory preso em infra/supabase porque o compose resolve ./initdb e
# ../caddy relativo a ele — o overlay morar fora do repositório não pode mudar isso.
compose_args() {
  printf -- "-p '%s' --project-directory '%s' --env-file '%s' -f '%s' -f '%s'" \
    "$COMPOSE_PROJECT" "$REPO/infra/supabase" "$INFRA_ENV" "$COMPOSE" "$OVERRIDE"
}

dc() { # $* = subcomando do docker compose, como UMA string
  detectar_docker || return 1
  [ -f "$OVERRIDE" ] || escrever_override
  local linha="docker compose $(compose_args) $*"
  if [ "$DOCKER_MODO" = "sg" ]; then sg docker -c "$linha"; else eval "$linha"; fi
}

# O overlay troca as portas publicadas sem tocar no docker-compose.yml versionado.
# `!override` SUBSTITUI a lista de portas do arquivo base (o compose, por padrão,
# SOMA as listas — e aí o stack tentaria abrir 8000/8025 além das suas). Exige
# Compose >= 2.24; a VM está bem acima disso.
escrever_override() {
  mkdir -p "$STATE" 2>/dev/null
  cat > "$OVERRIDE" <<FIM
# Gerado por devops/ctl.sh ($ID) — não edite, é reescrito a cada start.
# Mora fora do repositório para o clone nunca ficar sujo.
services:
  gateway:
    ports: !override
      - "$GATEWAY_PORT:8000"
  mailpit:
    ports: !override
      - "$MAILPIT_PORT:8025"
FIM
}

# ---------------------------------------------------------------------------
# Processos do host (Next e worker).
# ---------------------------------------------------------------------------
# Vivo = PID do arquivo existe E o processo está enraizado NESTE clone. A checagem
# por cwd é o que impede este script de matar o web/worker de outro deploy (prod x
# dev compartilham a mesma assinatura de processo: `next-server`, `tsx index.ts`).
vivo() { # $1=pidfile
  local pid
  [ -f "$1" ] || return 1
  pid=$(cat "$1" 2>/dev/null); [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  case "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" in "$REPO"|"$REPO"/*) return 0 ;; *) return 1 ;; esac
}

matar_grupo() { # $1=pidfile — mata o grupo inteiro (pnpm + o node filho)
  local pid
  [ -f "$1" ] || return 0
  pid=$(cat "$1" 2>/dev/null)
  if [ -n "$pid" ]; then
    case "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" in
      "$REPO"|"$REPO"/*)
        kill -TERM -- "-$pid" 2>/dev/null
        for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
        kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null ;;
    esac
  fi
  rm -f "$1"
}

# Sobe um processo destacado da sessão SSH, com o PID final gravado no pidfile.
# O `setsid` faz dele líder de sessão (pid == pgid), que é o que torna o
# `kill -- -PID` acima seguro e completo.
subir_proc() { # $1=pidfile $2=diretório $3=log $4...=comando
  local pidfile="$1" dir="$2" log="$3"; shift 3
  mkdir -p "$STATE" "$LOGS" 2>/dev/null
  achar_pnpm || return 1
  (
    cd "$dir" || exit 1
    export PATH="$NODEDIR:$PATH"
    exec setsid bash -c 'echo $$ >"$1"; shift; exec "$@"' _ "$pidfile" "$@" \
      >>"$log" 2>&1 </dev/null
  ) >/dev/null 2>&1 </dev/null &
  disown 2>/dev/null || true
}

porta_ocupada() { # $1=porta
  if command -v ss >/dev/null 2>&1; then ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  else netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; fi
}

http_code() {
  command -v curl >/dev/null 2>&1 || { printf 'sem curl'; return 0; }
  curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-5}" "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Pré-condições.
# ---------------------------------------------------------------------------
envs_ok() {
  [ -f "$INFRA_ENV" ] && [ -f "$REPO/apps/web/.env.local" ] &&
  [ -f "$REPO/packages/db/.env" ] && [ -f "$REPO/workers/.env" ]
}
build_ok() { [ -d "$REPO/apps/web/.next" ]; }
deps_ok()  { [ -d "$REPO/node_modules" ]; }

exigir_instalado() {
  local falta=0
  deps_ok  || { erro "dependências não instaladas (não há node_modules). Rode: bash devops/ctl.sh install"; falta=1; }
  envs_ok  || { erro "faltam arquivos .env. Rode: bash devops/ctl.sh env"; falta=1; }
  build_ok || { erro "o Next não foi buildado (não há apps/web/.next). Rode: bash devops/ctl.sh build"; falta=1; }
  [ "$falta" = 0 ]
}

# ---------------------------------------------------------------------------
# Camada 1 — infraestrutura em Docker.
# ---------------------------------------------------------------------------
infra_up() {
  [ -f "$INFRA_ENV" ] || { erro "sem $INFRA_ENV — rode 'bash devops/ctl.sh env' antes."; return 1; }
  escrever_override
  dc "up -d $INFRA_SERVICES" || { erro "docker compose up falhou (veja a mensagem acima)."; return 1; }
}

esperar_auth() { # espera o GoTrue responder pelo gateway
  local i code
  command -v curl >/dev/null 2>&1 || {
    aviso "sem curl: não dá para checar a saúde do auth. Esperando 20s às cegas — instale curl."
    sleep 20; return 0; }
  for i in $(seq 1 40); do
    code=$(http_code "http://127.0.0.1:$GATEWAY_PORT/auth/v1/health" 3)
    [ "$code" = "200" ] && { msg "  auth saudável em :$GATEWAY_PORT"; return 0; }
    sleep 2
  done
  erro "o auth (GoTrue) não ficou saudável em 80s. Veja: bash devops/ctl.sh logs infra"
  return 1
}

# ---------------------------------------------------------------------------
# Camadas 2 e 3 — processos do host.
# ---------------------------------------------------------------------------
subir_worker() {
  if vivo "$PID_WORKER"; then msg "  worker já estava no ar (PID $(cat "$PID_WORKER"))."; return 0; fi
  subir_proc "$PID_WORKER" "$REPO/workers" "$LOG_WORKER" pnpm exec tsx index.ts || return 1
  sleep 2
  if vivo "$PID_WORKER"; then msg "  worker subiu (PID $(cat "$PID_WORKER"))."
  else erro "worker não subiu. Últimas linhas:"; tail -20 "$LOG_WORKER" >&2; return 1; fi
}

subir_web() {
  if vivo "$PID_WEB"; then msg "  web já estava no ar (PID $(cat "$PID_WEB"))."; return 0; fi
  if porta_ocupada "$WEB_PORT"; then erro "a porta $WEB_PORT já está ocupada por outro processo."; return 1; fi
  subir_proc "$PID_WEB" "$REPO/apps/web" "$LOG_WEB" pnpm exec next start -p "$WEB_PORT" -H "$WEB_HOST" || return 1
  local i
  for i in $(seq 1 30); do porta_ocupada "$WEB_PORT" && break; sleep 1; done
  if porta_ocupada "$WEB_PORT"; then msg "  web subiu na porta $WEB_PORT."
  else erro "web não subiu. Últimas linhas:"; tail -20 "$LOG_WEB" >&2; return 1; fi
}

# ---------------------------------------------------------------------------
# Subcomandos.
# ---------------------------------------------------------------------------
cmd_start() {
  exigir_instalado || return 1
  titulo "infraestrutura (docker)"
  infra_up || return 1
  esperar_auth || return 1
  titulo "processos do host"
  subir_worker || return 1
  subir_web || return 1
  ops "start"
  msg ""
  msg "No ar: $SITE_URL"
}

# Idempotente e silencioso quando está tudo no ar — é isto que o cron chama.
cmd_ensure() {
  envs_ok && build_ok && deps_ok || return 0   # ainda não instalado: não faz barulho no cron
  vivo "$PID_WEB" && vivo "$PID_WORKER" && return 0
  # Só a partir daqui vale acordar o Docker. Trava para dois crons não se atropelarem.
  mkdir -p "$STATE" 2>/dev/null
  find "$TRAVA" -maxdepth 0 -mmin +10 -exec rmdir {} \; 2>/dev/null
  mkdir "$TRAVA" 2>/dev/null || return 0
  trap 'rmdir "$TRAVA" 2>/dev/null' EXIT
  infra_up >/dev/null 2>&1
  esperar_auth >/dev/null 2>&1 || { ops "ensure: auth não subiu"; return 1; }
  vivo "$PID_WORKER" || { subir_worker >/dev/null 2>&1; ops "ensure: worker ressubido"; }
  vivo "$PID_WEB"    || { subir_web    >/dev/null 2>&1; ops "ensure: web ressubido"; }
}

cmd_stop() { # $1 vazio = tudo; "app" = só os processos do host
  titulo "processos do host"
  vivo "$PID_WEB"    && msg "  parando web..."    ; matar_grupo "$PID_WEB"
  vivo "$PID_WORKER" && msg "  parando worker..." ; matar_grupo "$PID_WORKER"
  # Rede de segurança escopada na porta: nunca toca no web de outro deploy.
  command -v fuser >/dev/null 2>&1 && fuser -k -TERM "$WEB_PORT/tcp" >/dev/null 2>&1
  msg "  host parado."
  if [ "${1:-}" = "app" ]; then
    msg "  containers mantidos no ar (você pediu 'stop app')."
    ops "stop app"; return 0
  fi
  titulo "containers"
  dc "stop" || return 1
  ops "stop"
}

cmd_restart() { cmd_stop; sleep 2; cmd_start; }

cmd_status() {
  msg "$NOME_LONGO ($ID)"
  msg "  repositório : $REPO"
  msg "  branch      : $(git -C "$REPO" branch --show-current 2>/dev/null || echo '(sem git)')  $(git -C "$REPO" log --oneline -1 2>/dev/null)"
  msg "  ambiente    : $AMBIENTE   projeto compose: $COMPOSE_PROJECT"
  msg "  estado      : $STATE"
  msg "  logs        : $LOG_WEB"
  msg "                $LOG_WORKER"
  msg "  dependências: $(deps_ok  && echo 'instaladas' || echo 'FALTAM (rode install)')"
  msg "  .env        : $(envs_ok  && echo 'os 4 presentes' || echo 'FALTAM (rode env)')"
  msg "  build Next  : $(build_ok && echo 'presente' || echo 'FALTA (rode build)')"
  titulo "containers"
  dc "ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'" 2>/dev/null || msg "  (não consegui falar com o docker)"
  titulo "processos do host"
  if vivo "$PID_WEB"; then msg "  web    : NO AR (PID $(cat "$PID_WEB"), porta $WEB_PORT)"
  else msg "  web    : PARADO$(porta_ocupada "$WEB_PORT" && echo "  (atenção: a porta $WEB_PORT está ocupada por outro processo)")"; fi
  if vivo "$PID_WORKER"; then msg "  worker : NO AR (PID $(cat "$PID_WORKER"))"
  else msg "  worker : PARADO"; fi
  titulo "saúde"
  msg "  auth   : $(http_code "http://127.0.0.1:$GATEWAY_PORT/auth/v1/health") esperado 200   (http://127.0.0.1:$GATEWAY_PORT)"
  msg "  login  : $(http_code "http://127.0.0.1:$WEB_PORT/login") esperado 200   ($SITE_URL/login)"
  msg "  mailpit: $(http_code "http://127.0.0.1:$MAILPIT_PORT/") esperado 200"
}

cmd_logs() { # [web|worker|infra] [n]
  local alvo="web" n=40
  case "${1:-}" in
    web|worker|infra) alvo="$1"; shift ;;
    ''|*[!0-9]*) : ;;
  esac
  case "${1:-}" in ''|*[!0-9]*) : ;; *) n="$1" ;; esac
  case "$alvo" in
    infra) dc "logs --tail $n" ;;
    worker) [ -f "$LOG_WORKER" ] && tail -n "$n" "$LOG_WORKER" || msg "(sem log ainda em $LOG_WORKER)" ;;
    *)      [ -f "$LOG_WEB" ]    && tail -n "$n" "$LOG_WEB"    || msg "(sem log ainda em $LOG_WEB)" ;;
  esac
}

cmd_env() { bash "$AQUI/gen-env.sh" "$@"; }

cmd_build() {
  achar_pnpm || return 1
  envs_ok || { erro "gere os .env antes do build: as NEXT_PUBLIC_* entram no bundle. Rode 'bash devops/ctl.sh env'."; return 1; }
  titulo "build do Next (teto de heap: ${BUILD_MAX_MB}MB)"
  ( cd "$REPO" && PATH="$NODEDIR:$PATH" NODE_OPTIONS="--max-old-space-size=$BUILD_MAX_MB" "$PNPM" build )
}

cmd_migrate() {
  envs_ok || { erro "faltam .env — rode 'bash devops/ctl.sh env'."; return 1; }
  titulo "migrações (drizzle-kit migrate)"
  rodar_pnpm "$REPO" --filter @brazil-tms/db db:migrate
}

# Os seeds são idempotentes. "essencial" é o mínimo para o sistema ser usável;
# "demo" é a massa de demonstração (cliente DEMO-SHOPEE e amigos) e NÃO deve ir
# para uma instalação de verdade.
cmd_seed() {
  envs_ok || { erro "faltam .env — rode 'bash devops/ctl.sh env'."; return 1; }
  local modo="${1:-essencial}" lista s
  case "$modo" in
    essencial) lista="db:seed:reason-codes db:seed:document-types db:seed:trip-domain db:seed:buckets db:seed" ;;
    demo)      lista="db:seed:master-data db:seed:sla-rules db:seed:rates db:seed:import db:seed:trip-domain" ;;
    *) erro "uso: ctl.sh seed [essencial|demo]"; return 1 ;;
  esac
  for s in $lista; do
    titulo "seed $s"
    rodar_pnpm "$REPO" --filter @brazil-tms/db "$s" || { erro "o seed $s falhou."; return 1; }
  done
}

cmd_creds() {
  [ -f "$COFRE" ] || { erro "não há cofre em $COFRE — este deploy ainda não rodou 'ctl.sh env'."; return 1; }
  # shellcheck source=/dev/null
  . "$COFRE"
  msg "Endereço          : $SITE_URL"
  msg "Admin             : $ADMIN_EMAIL"
  msg "Senha temporária  : ${ADMIN_PW:-?}   (só vale até a primeira troca)"
  msg "Senha do Postgres : ${PGPW:-?}   (psql -h 127.0.0.1 -p $DB_PORT -U postgres)"
  msg "Mailpit           : http://$PUBLIC_HOST:$MAILPIT_PORT"
  msg "Cofre             : $COFRE"
}

compose_versao() {
  if [ "$DOCKER_MODO" = "sg" ]; then sg docker -c "docker compose version" 2>/dev/null | head -1
  else docker compose version 2>/dev/null | head -1; fi
}

cmd_doctor() {
  local ok=0 c p
  msg "Checando o que este deploy precisa:"
  if achar_node; then printf '  %-8s: %s (%s)\n' node "$NODE" "$("$NODE" -v)"; else ok=1; fi
  if achar_pnpm; then printf '  %-8s: %s (%s)\n' pnpm "$PNPM" "$(PATH="$NODEDIR:$PATH" "$PNPM" -v 2>/dev/null)"; else ok=1; fi
  if detectar_docker; then printf '  %-8s: modo %s — %s\n' docker "$DOCKER_MODO" "$(compose_versao)"; else ok=1; fi
  for c in git curl openssl; do
    if command -v "$c" >/dev/null 2>&1; then printf '  %-8s: %s\n' "$c" "$(command -v "$c")"
    else erro "$c não encontrado"; ok=1; fi
  done
  printf '  %-8s: %s  (o build do Next quer ~2 GB)\n' memória "$(free -m 2>/dev/null | awk '/^Mem:/{print $2" MB total, "$7" MB disponíveis"}')"
  printf '  %-8s: %s  (imagens Docker + store do pnpm passam de 5 GB)\n' disco "$(df -h "$REPO" 2>/dev/null | tail -1 | awk '{print $4" livres em "$6}')"
  printf '  %-8s: ' portas
  for p in "$WEB_PORT" "$GATEWAY_PORT" "$DB_PORT" "$MAILPIT_PORT"; do
    porta_ocupada "$p" && printf '%s=OCUPADA ' "$p" || printf '%s=livre ' "$p"
  done; printf '\n'
  if [ "$ok" = 0 ]; then msg "Tudo pronto."; else erro "resolva os itens acima antes de instalar."; fi
  return "$ok"
}

cmd_install() {
  msg "Instalando $NOME_LONGO ($ID) a partir de $REPO"
  cmd_doctor || return 1
  local p
  for p in "$WEB_PORT" "$GATEWAY_PORT" "$DB_PORT" "$MAILPIT_PORT"; do
    porta_ocupada "$p" && {
      erro "a porta $p já está ocupada."
      erro "Se este deploy JÁ está instalado, o comando é 'status' ou 'update', não 'install'."
      erro "Se é outro sistema usando a porta, mude as portas em devops/config.env."
      return 1; }
  done
  mkdir -p "$STATE" "$LOGS" || return 1
  chmod 700 "$STATE" 2>/dev/null

  titulo "dependências (pnpm install)"
  rodar_pnpm "$REPO" install --frozen-lockfile || { erro "pnpm install falhou."; return 1; }

  titulo "arquivos .env"
  if envs_ok; then msg "  já existem — mantidos (para refazer: bash devops/ctl.sh env)."
  else cmd_env || return 1; fi

  titulo "infraestrutura (docker)"
  infra_up || return 1
  esperar_auth || return 1

  cmd_migrate || return 1
  cmd_seed essencial || return 1
  cmd_build || { erro "o build falhou. Se foi morto por falta de memória, veja a seção de diagnóstico do README."; return 1; }

  titulo "subindo"
  subir_worker || return 1
  subir_web || return 1
  cmd_install_cron
  ops "install"

  msg ""
  msg "Pronto."
  cmd_creds
  msg ""
  msg "Se a VM tiver firewall: sudo ufw allow $WEB_PORT/tcp && sudo ufw allow $GATEWAY_PORT/tcp"
  msg "Massa de demonstração (opcional, NÃO use em instalação de verdade): bash devops/ctl.sh seed demo"
}

cmd_update() {
  exigir_instalado || return 1
  local branch="${GIT_BRANCH:-$(git -C "$REPO" branch --show-current 2>/dev/null)}"
  [ -n "$branch" ] || { erro "não descobri o branch (o clone tem git?). Defina GIT_BRANCH no config.env."; return 1; }
  msg "Atualizando $ID para o topo de origin/$branch. O site fica fora do ar durante o processo."
  cmd_stop app

  titulo "git pull --ff-only origin $branch"
  git -C "$REPO" pull --ff-only origin "$branch" || {
    erro "o pull falhou. Alteração local no clone, ou o branch divergiu/levou force-push. Resolva à mão e rode de novo."
    erro "Nada foi reiniciado — o sistema continua parado. Suba de volta com: bash devops/ctl.sh start"
    return 1; }

  titulo "dependências"
  rodar_pnpm "$REPO" install --frozen-lockfile || { erro "pnpm install falhou; não vou subir com dependência errada."; return 1; }

  titulo "infraestrutura (para a migração alcançar o banco)"
  infra_up || return 1
  esperar_auth || return 1

  cmd_migrate || { erro "a migração falhou; não vou subir com o banco fora de sincronia."; return 1; }
  cmd_build || { erro "o build falhou; não vou subir a versão antiga por engano."; return 1; }

  titulo "subindo"
  subir_worker || return 1
  subir_web || return 1
  ops "update para $(git -C "$REPO" log --oneline -1 2>/dev/null)"
  msg ""
  msg "Atualizado: $(git -C "$REPO" log --oneline -1 2>/dev/null)"
}

# Cron do usuário (sem sudo, sem systemd): sobe no boot e ressobe se cair.
# Os containers já voltam sozinhos (restart: unless-stopped); quem NÃO volta é o
# par web+worker do host — é exatamente esse buraco que o cron tapa.
cmd_install_cron() {
  command -v crontab >/dev/null 2>&1 || { erro "crontab não existe nesta VM; pule esta etapa."; return 1; }
  if crontab -l 2>/dev/null | grep -q "brazil-tms.*-ctl.sh"; then
    aviso "o crontab já tem uma linha chamando um brazil-tms*-ctl.sh de fora do repositório (~/devops)."
    aviso "Dois donos do mesmo processo dá briga. Remova a linha antiga antes, ou pule o cron."
  fi
  # Chamado com `bash` explícito: não depende do bit de execução ter sobrevivido ao clone.
  local atual novo
  atual=$(crontab -l 2>/dev/null | grep -v "$MARCA")
  novo=$(printf '%s\n@reboot bash %s/devops/ctl.sh ensure >/dev/null 2>&1 %s\n*/2 * * * * bash %s/devops/ctl.sh ensure >/dev/null 2>&1 %s\n' \
    "$atual" "$REPO" "$MARCA" "$REPO" "$MARCA")
  printf '%s\n' "$novo" | grep -v '^$' | crontab - && msg "  cron instalado (@reboot + a cada 2 min)."
}

cmd_uninstall_cron() {
  crontab -l 2>/dev/null | grep -v "$MARCA" | crontab - && msg "cron removido."
}

case "${1:-}" in
  install)        cmd_install ;;
  ensure)         cmd_ensure ;;
  start)          cmd_start ;;
  stop)           shift; cmd_stop "${1:-}" ;;
  restart)        cmd_restart ;;
  status)         cmd_status ;;
  logs)           shift; cmd_logs "$@" ;;
  update)         cmd_update ;;
  install-cron)   cmd_install_cron ;;
  uninstall-cron) cmd_uninstall_cron ;;
  env)            shift; cmd_env "$@" ;;
  build)          cmd_build ;;
  migrate)        cmd_migrate ;;
  seed)           shift; cmd_seed "${1:-essencial}" ;;
  creds)          cmd_creds ;;
  doctor)         cmd_doctor ;;
  compose)        shift; dc "$*" ;;
  *)
    cat <<AJUDA
$NOME_LONGO — controle do deploy na VM ($ID)

  ./devops/ctl.sh install         instala do zero: deps, .env, docker, migração, seed, build, cron
  ./devops/ctl.sh start|stop|restart
  ./devops/ctl.sh stop app        para só o web+worker e deixa os containers no ar
  ./devops/ctl.sh status          containers, processos do host, saúde e commit
  ./devops/ctl.sh logs [web|worker|infra] [n]     padrão: web, 40 linhas
  ./devops/ctl.sh update          pull + install + migração + build + reinício
  ./devops/ctl.sh ensure          sobe o que estiver caído (é o que o cron chama)
  ./devops/ctl.sh install-cron | uninstall-cron

  extras deste sistema (o deploy tem mais peças que os outros):
  ./devops/ctl.sh doctor          confere docker, node 22, pnpm, memória, disco e portas
  ./devops/ctl.sh env             (re)gera os 4 .env a partir do cofre de segredos
  ./devops/ctl.sh build           build do Next (precisa dos .env prontos)
  ./devops/ctl.sh migrate         drizzle-kit migrate
  ./devops/ctl.sh seed [essencial|demo]
  ./devops/ctl.sh creds           mostra admin, senha temporária e senha do Postgres
  ./devops/ctl.sh compose "ps"    docker compose deste deploy (projeto e overlay certos)

Ajuste os valores em devops/config.env. Procedimento completo em devops/README.md.
AJUDA
    exit 1 ;;
esac
