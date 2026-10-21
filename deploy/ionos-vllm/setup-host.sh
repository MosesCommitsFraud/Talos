#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu (26.04) GPU VM: NVIDIA driver, Docker,
# NVIDIA Container Toolkit. Safe to re-run; finished steps are skipped.
#
#   sudo ./setup-host.sh
#
# If it installs the driver it asks for a reboot — run it again afterwards.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# Driver already loaded (e.g. from the IONOS image) but no nvidia-smi: install
# only the userspace tools, in exactly the loaded version — a different one
# fails with "Driver/library version mismatch".
if [ -r /proc/driver/nvidia/version ] && ! command -v nvidia-smi >/dev/null 2>&1; then
  major=$(grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' /proc/driver/nvidia/version | head -1 | cut -d. -f1)
  flavor=""
  dpkg -l | grep -qE '^ii\s+\S*nvidia\S*-server' && flavor="-server"
  apt-get update
  apt-get install -y "nvidia-utils-$major$flavor"
fi

if ! nvidia-smi >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ubuntu-drivers-common
  # Server driver with open kernel modules (required for H100/H200).
  pkg=$(ubuntu-drivers list --gpgpu 2>/dev/null | grep -oE 'nvidia-driver-[0-9]+-server-open' | sort -V | tail -1)
  if [ -n "$pkg" ]; then
    apt-get install -y "$pkg"
  else
    ubuntu-drivers install --gpgpu
  fi
  echo "Driver installed. Reboot (sudo reboot) and run this script again."
  exit 0
fi
nvidia-smi -L

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
# The calling user runs ./run.sh without sudo (takes effect on next login).
[ -n "${SUDO_USER:-}" ] && usermod -aG docker "$SUDO_USER"

if ! command -v nvidia-ctk >/dev/null 2>&1; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update
  apt-get install -y nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker
  systemctl restart docker
fi

docker run --rm --gpus all ubuntu nvidia-smi -L
echo "Host ready. Next: cp .env.example .env, fill it in, ./run.sh download, ./run.sh qwen3.8-27b"
