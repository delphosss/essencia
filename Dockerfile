# Imagem para qualquer hospedagem com Docker (Railway, Fly.io, VPS).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p data public/uploads
EXPOSE 3000
# Monte um volume em /app/data e /app/public/uploads para não perder banco e imagens.
CMD ["node", "src/server.js"]
