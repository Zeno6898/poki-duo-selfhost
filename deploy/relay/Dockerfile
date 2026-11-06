# SPDX-License-Identifier: AGPL-3.0-or-later
# Blind SNI relay. No dependencies beyond Node itself.
FROM node:22-alpine
WORKDIR /relay
COPY package.json relay.js helper.js ./
USER node
# 443: public TLS (routed by SNI, never terminated). 8443: helpers (TLS with the relay's own
# certificate, mounted at /certs).
EXPOSE 443 8443
ENV RELAY_PUBLIC_PORT=443 RELAY_HELPER_PORT=8443 \
    RELAY_HELPER_KEY=/certs/helper-side.key RELAY_HELPER_CERT=/certs/helper-side.crt
CMD ["node", "relay.js"]
