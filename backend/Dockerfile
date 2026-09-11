# Build stage: compile TypeScript to dist/
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY demo ./demo
RUN npm run build

# Runtime stage: production dependencies plus compiled output only
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Koyeb injects PORT; config.ts falls back to 3000 when it is absent.
EXPOSE 3000

# Run as the node user rather than root.
USER node

CMD ["node", "dist/src/index.js"]
