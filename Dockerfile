FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install --no-audit --no-fund
COPY client ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY server/package*.json ./server/
RUN npm --prefix server install --omit=dev --no-audit --no-fund
COPY server ./server
COPY --from=client /app/client/dist ./client/dist
ENV NODE_ENV=production PORT=5000
EXPOSE 5000
CMD ["node", "server/src/index.js"]
