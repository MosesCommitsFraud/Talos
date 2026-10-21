FROM alpine:3.22
RUN apk add --no-cache openssh-client
# -N: forward only, no remote command. A dead connection makes ssh exit after
# ~45 s, and Docker's restart policy reconnects.
ENTRYPOINT ["ssh", "-N", \
    "-i", "/ssh/id_ed25519", \
    "-o", "UserKnownHostsFile=/ssh/known_hosts", \
    "-o", "StrictHostKeyChecking=yes", \
    "-o", "ExitOnForwardFailure=yes", \
    "-o", "ServerAliveInterval=15", \
    "-o", "ServerAliveCountMax=3"]
