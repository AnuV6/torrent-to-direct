FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 5000
EXPOSE 6881/tcp
EXPOSE 6881/udp
ENV PORT=5000
CMD ["node", "server.js"]
