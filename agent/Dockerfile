# MikroTik Cloud Manager — Remote Network Agent
# Outbound-only: the container opens NO listening ports.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY agent.js .
RUN addgroup -S agent && adduser -S agent -G agent
USER agent
# no EXPOSE — the agent makes outbound connections only
CMD ["node", "agent.js"]
