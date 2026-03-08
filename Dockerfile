# Playwright base image includes browsers + deps
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm","start"]
