FROM node:16-alpine

RUN apk add --no-cache git openssh-client

RUN mkdir /app

COPY ./package*.json /app
COPY ./locales /app/locales
COPY ./index.js /app/index.js

VOLUME /app/index.js
VOLUME /app/pages
VOLUME /root/.ssh

WORKDIR /app
RUN npm ci

ENV HOST=0.0.0.0

CMD ["npm", "start"]
