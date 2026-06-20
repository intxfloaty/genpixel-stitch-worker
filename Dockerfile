FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3001

CMD ["npx", "tsx", "index.ts"]
