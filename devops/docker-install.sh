#!/usr/bin/env bash
# Brazil TMS — instala Docker Engine + Compose v2 numa VM Ubuntu/Mint e coloca o
# usuário no grupo docker. É o ÚNICO script deste deploy que precisa de root:
#
#   sudo bash devops/docker-install.sh
#
# Depois disto, nada mais no deploy pede sudo. Se a VM não tiver sudo utilizável,
# peça a quem administra a máquina para rodar este script (ou instalar Docker de
# outro jeito) — sem Docker, o Brazil TMS não sobe: banco, auth e storage vivem lá.
#
# Já rodou uma vez? Não rode de novo. Confira com: docker compose version
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "ERRO: rode com sudo (este é o único passo que precisa de root)."; exit 1; }

# O Mint é derivado do Ubuntu e o repositório do Docker é indexado pelo codinome do
# UBUNTU (noble), não pelo do Mint (zena/xia). O /etc/os-release traz os dois.
. /etc/os-release
CODENAME="${UBUNTU_CODENAME:-noble}"
USUARIO="${SUDO_USER:-$(id -un)}"
echo ">> Instalando Docker para o codinome Ubuntu: $CODENAME (usuário alvo: $USUARIO)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker

# Deixa o usuário do deploy falar com o socket do Docker sem sudo.
groupadd -f docker
usermod -aG docker "$USUARIO"

echo ">> Instalado:"
docker --version
docker compose version
echo ">> PRONTO. '$USUARIO' entrou no grupo docker."
echo ">> O grupo só vale em sessão nova: saia e entre de novo, ou use 'sg docker -c \"...\"'."
echo ">> O devops/ctl.sh detecta os dois casos sozinho."
