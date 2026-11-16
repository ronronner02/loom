ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
COPY dist ./dist
COPY web ./web
COPY package.json ./package.json
USER node
ENV HOST=0.0.0.0 PORT=3000 LOOM_DATA_DIR=/data
EXPOSE 3000
CMD ["node", "dist/server.js"]
