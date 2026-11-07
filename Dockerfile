FROM node:18-slim

# Install system FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm-rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Pass process.env.PORT Render secara dinamik
EXPOSE 10000

CMD ["node", "bot.mjs"]

