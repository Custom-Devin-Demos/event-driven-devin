FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache openssl && npm ci --only=production

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "app/server.js"]
