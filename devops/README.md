# devops — deploy do Brazil TMS numa VM Linux

Tudo que é preciso para colocar o TMS no ar numa VM, versionado junto com o código.

**Aviso de expectativa:** este é, de longe, o mais complicado dos sistemas da casa.
Os outros são um `server.js` que você sobe com Node puro. Aqui são **três camadas**
(banco/auth/storage em Docker, o Next.js buildado e um worker de fila), com
**migração de banco**, **build de 2 GB de heap** e **quatro arquivos `.env` que
precisam concordar entre si**. O `ctl.sh` esconde essa complexidade no dia a dia,
mas na primeira instalação vale ler este arquivo até o fim.

| | |
|---|---|
| Runtime | **Node 22** (obrigatório) + **pnpm 10.23.0** + **Docker Compose v2** |
| Porta do sistema | **3000** (`WEB_PORT`) |
| Auto-início | **cron do usuário** — sem `sudo`, sem `systemd` |
| Dados | volumes Docker (`<projeto>_db-data`, `<projeto>_storage-data`) |
| Segredos | `~/komunick/data/brazil-tms/secrets.env` — **fora do repositório** |
| Logs | `~/komunick/logs/brazil-tms-{web,worker}.log` + `docker compose logs` |

---

## 1. O que sobe onde

```
   navegador
      |
      |  :3000  (Next.js — UI e BFF na mesma app)
      v
  +--------------------------------------------------+
  |  HOST (processos soltos, tocados pelo ctl.sh)     |
  |    web    = next start        (apps/web)          |
  |    worker = tsx index.ts      (workers/)          |
  +--------------------------------------------------+
      |                    |
      | :5432 Postgres     | :8000 gateway (auth + storage)
      v                    v
  +--------------------------------------------------+
  |  DOCKER — projeto compose brazil-tms-supabase     |
  |    db       postgres:16-alpine                    |
  |    auth     supabase/gotrue:v2.151.0  (PINADO)    |
  |    storage  supabase/storage-api:v1.11.13         |
  |    gateway  caddy:2.8-alpine  -> /auth/v1, /storage/v1 |
  |    mailpit  captura e-mail de convite/recuperação  |
  +--------------------------------------------------+
```

Detalhes que explicam decisões do `ctl.sh`:

- **O worker roda no host, não no container.** O `docker-compose.yml` até tem um
  serviço `worker`, mas ele fica de fora (`INFRA_SERVICES` no `config.env`): numa VM
  de 3,8 GB isso economiza RAM e deixa reiniciar/ver log do worker sem rebuildar imagem.
- **O GoTrue está pinado na v2.151.0.** Versões posteriores abortam o lote de migração
  num Postgres novo. Não "atualize por atualizar".
- **PostgREST não existe aqui.** O gateway só publica `/auth/v1` e `/storage/v1`; todo
  acesso a dado passa pelo BFF do Next com conexão direta ao Postgres (Drizzle).
- **O navegador fala com o gateway em um único ponto**: a tela de definir senha
  (convite e "esqueci a senha") troca o código por sessão direto no GoTrue. É por isso
  que `PUBLIC_HOST` existe — veja a seção 7.

### Portas

| Porta | Quem | Precisa estar acessível para |
|---|---|---|
| `3000` `WEB_PORT` | Next.js | usuários |
| `8000` `GATEWAY_PORT` | Caddy → GoTrue + Storage | **navegador** (tela de definir senha) e o próprio host |
| `5432` `DB_PORT` | Postgres | só o host (migração, seed, worker, BFF) |
| `8025` `MAILPIT_PORT` | Mailpit (UI) | operador, quando for pegar link de convite |
| 9999 / 5000 | GoTrue / Storage | internas da rede do compose, não publicadas |

---

## 2. Pré-requisitos da VM

| Item | Como conferir | Se faltar |
|---|---|---|
| Docker + Compose v2 | `docker compose version` | `sudo bash devops/docker-install.sh` (**único passo com root**) |
| Node **22** | `node -v` | `nvm install 22` — a v20 **não** funciona (o `@supabase/realtime-js` quebra todo `createClient` com "no native WebSocket") |
| pnpm 10.23.0 | `pnpm -v` | `corepack enable && corepack prepare pnpm@10.23.0 --activate` |
| git, curl, openssl | `bash devops/ctl.sh doctor` | pacotes do sistema |
| RAM | ~2 GB livres para o build | sem isso o build morre por OOM (veja seção 10) |
| Disco | ~6 GB livres | imagens Docker + store do pnpm + `.next` |

`bash devops/ctl.sh doctor` confere tudo isso de uma vez, inclusive se as portas
estão livres. Rode antes de instalar.

---

## 3. Instalar numa VM nova

```bash
# 1. Docker (uma vez por VM, com root)
sudo bash devops/docker-install.sh     # ou pule, se a VM já tiver Docker

# 2. Node 22 (uma vez por VM)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh && nvm install 22 && corepack enable && corepack prepare pnpm@10.23.0 --activate

# 3. Clonar
mkdir -p ~/komunick/repos && cd ~/komunick/repos
git clone --branch dev https://github.com/mafaltti/brazil-tms.git
cd brazil-tms

# 4. Ajustar o endereço público ANTES de instalar (veja a seção 7)
#    Sem isso, convite e "esqueci a senha" só funcionam de dentro da VM.
echo 'PUBLIC_HOST="192.168.1.253"' >> devops/config.env   # IP ou DNS pelo qual os usuários entram

# 5. Instalar
bash devops/ctl.sh doctor
bash devops/ctl.sh install
```

O `install` faz, nesta ordem, abortando no primeiro erro:

1. `pnpm install --frozen-lockfile`
2. gera os 4 `.env` e sorteia os segredos (`gen-env.sh`)
3. `docker compose up -d` da infra e **espera o auth ficar saudável**
4. `drizzle-kit migrate`
5. seeds essenciais (catálogos, buckets de storage e o primeiro admin)
6. `pnpm build` do Next
7. sobe worker e web
8. instala o cron (`@reboot` + a cada 2 min)

No fim ele imprime o endereço, o e-mail do admin e a **senha temporária** (trocada
obrigatoriamente no primeiro login). Para ver de novo: `bash devops/ctl.sh creds`.

Massa de demonstração (cliente DEMO-SHOPEE, viagens e tarifas de exemplo) é
**opcional e não deve ir para uma instalação de verdade**:

```bash
bash devops/ctl.sh seed demo
```

Se a VM tiver firewall: `sudo ufw allow 3000/tcp && sudo ufw allow 8000/tcp`.

---

## 4. Os quatro `.env` e o cofre de segredos

Nenhum segredo mora no repositório. O `gen-env.sh` sorteia uma vez, guarda em
`~/komunick/data/brazil-tms/secrets.env` (modo 600, **fora do clone**) e, a partir
daí, sempre reescreve os `.env` com os **mesmos** valores.

| Arquivo gerado | Quem lê |
|---|---|
| `infra/supabase/.env` | `docker compose` (senha do Postgres, JWT, chaves, portas, URLs) |
| `apps/web/.env.local` | Next.js — UI **e** BFF |
| `packages/db/.env` | `drizzle-kit migrate` e os seeds (`dotenv`, CWD = `packages/db`) |
| `workers/.env` | o worker do host (`dotenv`, CWD = `workers`) |

Os quatro estão cobertos pelo `.gitignore` do repositório (`.env` e `.env.*`) e são
gravados com modo 600. **Nunca** os edite à mão: rode `bash devops/ctl.sh env`.

O que o cofre guarda: senha do Postgres, `JWT_SECRET`, a `ANON_KEY` e a
`SERVICE_ROLE_KEY` (dois JWT HS256 assinados com esse segredo, no formato canônico
do Supabase) e a senha temporária do admin.

> **Regra de ouro:** os segredos e o volume do Postgres formam um par. Regenerar os
> `.env` é seguro e idempotente. **Rotacionar** (`ctl.sh env --rotacionar`) só com
> banco vazio — contra um volume que já existe, o GoTrue e o app param de autenticar.
> Faça backup do `secrets.env` junto com o backup do banco.

---

## 5. Dia a dia

```bash
bash devops/ctl.sh status              # containers, processos, saúde, commit
bash devops/ctl.sh logs 80             # 80 linhas do log do Next
bash devops/ctl.sh logs worker 200     # log do worker
bash devops/ctl.sh logs infra          # docker compose logs
bash devops/ctl.sh restart
bash devops/ctl.sh stop app            # para só web+worker; banco continua no ar
bash devops/ctl.sh creds               # admin, senha temporária, senha do Postgres
bash devops/ctl.sh compose "ps"        # docker compose já com projeto e overlay certos
```

`status` é o primeiro comando a rodar quando alguém reclamar. Ele mostra as três
camadas separadas — dá para ver na hora se o problema é container, processo do host
ou build.

### Auto-início

Os **containers** voltam sozinhos depois de um reboot (`restart: unless-stopped`).
O **web e o worker do host não voltam** — é esse buraco que o cron tapa:

```
@reboot     bash <repo>/devops/ctl.sh ensure    # devops:brazil-tms
*/2 * * * * bash <repo>/devops/ctl.sh ensure    # devops:brazil-tms
```

`ensure` é barato: se web e worker estão vivos, ele sai sem nem falar com o Docker.
Se o deploy nem foi instalado ainda, ele sai calado (não polui o log do cron). Só
quando encontra algo caído é que sobe a infra, espera o auth e ressobe os processos —
com trava, para dois crons não se atropelarem.

---

## 6. Atualizar (deploy de uma versão nova)

```bash
bash devops/ctl.sh update
```

`update` **é o comando de deploy** e faz, abortando no primeiro erro:

`stop app` → `git pull --ff-only origin <branch>` → `pnpm install --frozen-lockfile`
→ sobe a infra e espera o auth → `drizzle-kit migrate` → `pnpm build` → sobe web e worker.

Duas coisas importantes e honestas:

- **O sistema fica fora do ar durante o update** (o build leva minutos nesta VM). Não é
  deploy sem downtime, e fingir o contrário seria pior.
- **Se qualquer etapa falhar, ele não sobe nada.** É de propósito: subir com dependência
  desatualizada, migração pendente ou build antigo é pior do que ficar parado. A
  mensagem de erro diz o que fazer; depois de resolver, `bash devops/ctl.sh start`.

### Migração e seed avulsos

```bash
bash devops/ctl.sh migrate             # drizzle-kit migrate (idempotente)
bash devops/ctl.sh seed essencial      # catálogos + buckets + primeiro admin (idempotente)
```

Os seeds essenciais são: `reason-codes`, `document-types`, `trip-domain`
(opções de cancelamento), `buckets` (cria os buckets privados `imports`, `documents`,
`billing-exports`) e `001-admin`. Todos são idempotentes — rodar de novo não duplica.

> Não existe um script `db:seed:all` neste repositório (a ferramenta antiga que mora
> na VM em `~/devops/brazil-tms-dev-ctl.sh` chama esse nome e falharia). O `ctl.sh`
> roda a lista, um a um, na ordem de dependência.

---

## 7. Acesso pela rede — a armadilha do `PUBLIC_HOST`

Quase tudo passa pelo BFF (servidor), então funciona com qualquer URL. **Uma tela
não**: `/auth/set-password`, usada por convite de usuário e por "esqueci minha senha",
troca o código por sessão **direto do navegador** com o gateway do Supabase.

Ou seja: `NEXT_PUBLIC_SUPABASE_URL` precisa ser um endereço que **a máquina do
usuário** alcança. Com `PUBLIC_HOST=localhost` (padrão), o link do convite abre no
computador do usuário e a página tenta falar com `localhost:8000` — a máquina *dele* —
e falha.

```bash
# no config.env, antes de instalar (ou antes de um novo build)
PUBLIC_HOST="192.168.1.253"     # IP ou DNS pelo qual os usuários acessam a VM
```

Isso ajusta de uma vez `SITE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `API_EXTERNAL_URL` e a
lista de redirects permitidos do GoTrue.

> **Mudou porta ou `PUBLIC_HOST`? Tem que buildar de novo.** As variáveis
> `NEXT_PUBLIC_*` são embutidas no bundle do navegador em tempo de build:
> `bash devops/ctl.sh env && bash devops/ctl.sh build && bash devops/ctl.sh restart`.

---

## 8. Um segundo ambiente (dev) na mesma VM

Basta trocar o rótulo do ambiente e usar as portas +100 — o `ctl.sh` isola o resto
sozinho (projeto Docker próprio, volumes próprios, pasta de estado, logs e marca de
cron próprios):

```bash
AMBIENTE=dev WEB_PORT=3100 GATEWAY_PORT=8100 DB_PORT=5433 MAILPIT_PORT=8125 \
  bash devops/ctl.sh install
```

O jeito prático é ter **dois clones** (um por ambiente) e escrever esses valores no
`config.env` de cada um. Duas garantias que valem entender:

- **Portas publicadas**: o `docker-compose.yml` versionado fixa `8000:8000` e
  `8025:8025`. O `ctl.sh` gera um overlay com `ports: !override` (que **substitui** a
  lista do arquivo base — sem o `!override` o Compose **soma** as listas e o segundo
  stack tentaria abrir as portas do primeiro). Esse overlay é escrito **fora do
  repositório**, em `$STATE_DIR/compose.override.yml`, justamente para o clone nunca
  ficar sujo no `git status`.
- **Processos do host**: web e worker dos dois ambientes têm a *mesma* assinatura
  (`next-server`, `tsx index.ts`). Por isso o `ctl.sh` **nunca** usa `pkill -f
  next-server`: cada processo sobe com `setsid` (vira líder de sessão), grava o PID
  num arquivo dentro do `STATE_DIR` do ambiente, e o `stop` mata o **grupo** só depois
  de confirmar, pelo `/proc/<pid>/cwd`, que aquele processo está enraizado **neste**
  clone. Um ambiente não consegue derrubar o outro.

---

## 9. Backup

Duas coisas precisam ser salvas **juntas** (e casadas entre si):

```bash
# 1. o banco
bash devops/ctl.sh compose "exec -T db pg_dump -U postgres postgres" > ~/backup-tms-$(date +%F).sql

# 2. o cofre de segredos (as chaves precisam continuar combinando com o banco)
cp ~/komunick/data/brazil-tms/secrets.env ~/backup-tms-secrets-$(date +%F).env
```

Os arquivos enviados (documentos, planilhas de importação, exports de faturamento)
ficam no volume `<projeto>_storage-data`. Para levar tudo para outra VM, copie os dois
volumes Docker com o stack parado, ou restaure o dump e reenvie os arquivos.

O repositório e os `.env` **não** são backup: dá para reconstruí-los a qualquer
momento com `install`. O que não se reconstrói é o par banco + cofre.

---

## 10. Quando der errado

| Sintoma | Causa provável / o que fazer |
|---|---|
| `install`/`doctor` diz que docker não responde | serviço parado, ou o usuário não está no grupo `docker`. O `ctl.sh` tenta `docker` direto e, se falhar, `sg docker -c "..."` |
| erro "no native WebSocket" no seed, no worker ou no build | Node errado. Tem que ser a **v22** (`nvm use 22`, ou fixe `NODE_BIN` no `config.env`) |
| `auth não ficou saudável em 80s` | veja `bash devops/ctl.sh logs infra`. Em banco novo o GoTrue roda migrações e demora; se persistir, quase sempre é `JWT_SECRET`/senha do Postgres fora de sincronia com o volume (cofre trocado) |
| build morto sem mensagem (OOM) | não builde dois ambientes ao mesmo tempo; garanta swap; ajuste `BUILD_MAX_MB` |
| `port is already allocated` | outro stack usando as mesmas portas — `bash devops/ctl.sh doctor` mostra quais estão ocupadas |
| depois do reboot os containers estão de pé mas o site não abre | é o esperado: web/worker do host não voltam sozinhos. `bash devops/ctl.sh ensure` (o cron faz isso a cada 2 min) |
| convite/"esqueci a senha" abre a tela mas dá erro no navegador | `PUBLIC_HOST` está como `localhost`. Veja a seção 7 — exige `env` + `build` de novo |
| `update` reclamou do `git pull` | alteração local no clone ou branch divergente. Resolva à mão; nada foi reiniciado, suba com `start` |
| login responde 500 e o log fala de coluna/tabela | migração pendente: `bash devops/ctl.sh migrate` e reinicie |
| worker "no ar" mas a importação não anda | reinicie o worker (`stop app` + `start`): worker antigo em memória mascara mudança de código |
| status mostra web PARADO e a porta OCUPADA | sobrou um `next start` órfão. `bash devops/ctl.sh stop app` limpa (mata pelo grupo e, como rede, pela porta) |

Logs, em ordem de utilidade: `ctl.sh logs` (Next) → `ctl.sh logs worker` →
`ctl.sh logs infra` (containers) → `~/komunick/logs/devops.log` (histórico de
start/stop/update deste script).

---

## 11. O que este `devops/` **não** resolve

Sendo direto sobre os limites:

- **Não instala Docker sem root.** Se a VM não tem sudo utilizável, alguém com root
  precisa rodar `docker-install.sh` antes. Sem Docker não há como subir.
- **Não é deploy sem downtime**, não faz blue/green e não faz rollback automático de
  migração. Rollback = voltar o commit e restaurar o dump do banco, à mão.
- **Não gerencia TLS/domínio.** É HTTP na porta 3000. Colocar um proxy com HTTPS na
  frente muda `SITE_URL`, `PUBLIC_HOST` e exige rebuild.
- **Não versiona segredo nenhum.** O cofre é gerado na VM e fica lá; backup é
  responsabilidade do operador (seção 9).
- **O deploy que já está no ar na `mint-vm` continua sendo tocado pela ferramenta
  antiga**, que mora fora do repositório em `~/devops` (`brazil-tms-ctl.sh`,
  `brazil-tms-dev-ctl.sh`, `gen-env.py`, `gen-env-dev.py`, `brazil-tms-DEPLOYMENT.md`).
  Este `devops/` é a versão versionada e melhorada dessa ferramenta, mas **os dois não
  devem apontar para o mesmo clone**: seriam dois donos do mesmo processo e do mesmo
  projeto Docker. Para migrar aquele deploy para cá, o caminho é subir um clone novo
  com este `ctl.sh` (portas diferentes), restaurar o dump, conferir, e só então
  aposentar os scripts antigos. Enquanto isso não acontecer, o `~/devops` continua
  sendo a fonte da verdade **daquele** deploy — e o `install-cron` avisa se encontrar
  uma linha de cron chamando os scripts antigos.
