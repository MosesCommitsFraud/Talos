# Caddy with Talos's Caddyfile baked in.
#
# Exists for the same reason as the SearxNG image: the Caddyfile was a bind
# mount, which meant an HTTPS deployment had to keep a file on disk. Baking it
# costs nothing in flexibility — the Caddyfile is driven entirely by
# {$TALOS_HTTPS_HOST}, so pointing it at a different host is still just an
# environment variable.
#
# Worth keeping rather than replacing with `caddy reverse-proxy` on the command
# line: the Caddyfile sets a global default_sni, without which Caddy rejects the
# no-SNI handshake browsers send when connecting to a bare IP address — which is
# how a LAN box usually gets reached.
FROM caddy:2

COPY Caddyfile /etc/caddy/Caddyfile
