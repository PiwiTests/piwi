docker pull phenx/piwitests-server:latest
mkdir -p .data && sudo chown -R 1001:1001 .data # the container runs as non-root UID 1001
# Reachable from this machine only: with authentication off, anyone who reaches the port is an administrator.
# Publish it on every interface (-p 3000:3000) only once authentication is on.
docker run -p 127.0.0.1:3000:3000 -v $(pwd)/.data:/app/.data phenx/piwitests-server:latest
