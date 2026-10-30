FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Force sqlite3 to compile from source inside this image
RUN npm ci --omit=dev --build-from-source

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]