FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc

# Remove dev dependencies after build
RUN npm prune --omit=dev

EXPOSE 3000

CMD ["node", "dist/server.js"]
