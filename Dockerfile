# Imagen base oficial de Node.js en Debian Bookworm Slim
FROM node:20-bookworm-slim

# Instalar dependencias del sistema necesarias para Chromium y Playwright Headless
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxcb1 \
    libxkbcommon0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Directorio de trabajo
WORKDIR /app

# Copiar manifiestos de dependencias
COPY package*.json tsconfig.json ./

# Instalar dependencias del proyecto
RUN npm ci

# Instalar los binarios de Chromium para Playwright
RUN npx playwright install chromium

# Copiar código fuente y assets
COPY src/ ./src/

# Compilar TypeScript y copiar assets estáticos
RUN npm run build

# Directorio para base de datos persistente
RUN mkdir -p /app/data

# Exponer puerto configurado por Render
ENV PORT=3000
ENV NODE_ENV=production
ENV HEADLESS_MODE=true
EXPOSE 3000

# Iniciar BotArca
CMD ["node", "dist/index.js"]
