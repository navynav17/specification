FROM apify/actor-node-playwright-chrome:22-1.52.0

COPY package*.json ./
RUN npm install --omit=dev
RUN npx playwright install chromium

COPY . ./

CMD ["npm", "start"]
