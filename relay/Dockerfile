FROM node:22-alpine
WORKDIR /app
COPY relay/server.mjs relay/oauth.mjs ./
ENV PC_BRIDGE_LISTEN=0.0.0.0 PC_BRIDGE_PORT=8787
EXPOSE 8787
USER node
CMD ["node", "server.mjs"]
