# SearxNG with Talos's settings baked in.
#
# The stock image ships JSON output DISABLED, and the `web_search` tool talks to
# it over the JSON API — so upstream searxng/searxng cannot be used as-is. That
# config used to arrive via a bind mount, which forced every deployment to keep
# a copy of settings.yml on disk. Baking it makes the service paste-able: pull
# and run, nothing on the host.
#
# settings.yml keeps the literal `ultrasecretkey` placeholder on purpose. The
# upstream entrypoint substitutes $SEARXNG_SECRET for exactly that string at
# startup, and its FORCE_OWNERSHIP step chowns /etc/searxng to the searxng user
# first, so the baked file is writable when the substitution runs. Set
# SEARXNG_SECRET in the compose environment; SearxNG refuses to start if the
# placeholder survives.
FROM searxng/searxng:latest

COPY settings.yml /etc/searxng/settings.yml
