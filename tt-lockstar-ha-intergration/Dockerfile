ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM $BUILD_FROM

ENV LANG=C.UTF-8

RUN apk update
RUN apk add --no-cache nodejs npm git bluez

WORKDIR /

COPY start.sh /app/start.sh
COPY addon /app
RUN rm -rf /app/node_modules

# The selected @stoprocent/noble D-Bus backend is pure JavaScript. Its package
# still ships an install hook for the unused native HCI binding, which does not
# build on the current HA Node/Python toolchain. Install without dependency
# lifecycle hooks, then explicitly compile the pinned SDK and apply our guarded
# source patches.
RUN cd /app \
    && npm i --ignore-scripts --omit=optional \
    && git clone --quiet https://github.com/RK392/ttlock-sdk-js.git /tmp/ttlock-sdk-js \
    && git -C /tmp/ttlock-sdk-js checkout --quiet 42043c41f8f4c88234d2b70ab6a067a610679ffb \
    && ln -s /app/node_modules /tmp/ttlock-sdk-js/node_modules \
    && npm pack --silent --ignore-scripts --pack-destination /tmp @abandonware/noble@1.9.2-26 \
    && mkdir -p /tmp/noble-types \
    && tar -xzf /tmp/abandonware-noble-1.9.2-26.tgz -C /tmp/noble-types package/index.d.ts \
    && cp /tmp/noble-types/package/index.d.ts node_modules/@abandonware/noble/index.d.ts \
    && ./node_modules/.bin/tsc --project /tmp/ttlock-sdk-js/tsconfig.json \
    && rm -rf node_modules/ttlock-sdk-js \
    && mkdir -p node_modules/ttlock-sdk-js \
    && cp /tmp/ttlock-sdk-js/package.json node_modules/ttlock-sdk-js/package.json \
    && cp -R /tmp/ttlock-sdk-js/dist node_modules/ttlock-sdk-js/dist \
    && npm run postinstall \
    && npm prune --ignore-scripts --omit=dev --omit=optional \
    && rm -rf /tmp/ttlock-sdk-js /tmp/noble-types /tmp/abandonware-noble-1.9.2-26.tgz /root/.npm

# here we should just copy the /app contents to a run image with nodejs and other requirements only

ENTRYPOINT ["/app/start.sh"]

LABEL io.hass.version="VERSION" io.hass.type="app" io.hass.arch="aarch64|amd64"
