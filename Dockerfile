FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
RUN chmod +x docker-entrypoint.sh
EXPOSE 3000
ENV NODE_ENV=production
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
