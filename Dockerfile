FROM node:20-alpine AS builder

RUN mkdir /app
COPY ./package*.json /app/
WORKDIR /app
RUN npm ci

COPY ./tsconfig.json /app/
COPY ./src /app/src

RUN npm run build

# ──────────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache git openssh-client

RUN mkdir /app

COPY ./package*.json /app/
WORKDIR /app
RUN npm ci --omit=dev

COPY --from=builder /app/dist /app/dist
COPY ./locales /app/locales

VOLUME /app/pages
VOLUME /root/.ssh

RUN git config --global --add safe.directory /app/pages

ENV HOST=0.0.0.0

CMD ["node", "dist/index.js"]
