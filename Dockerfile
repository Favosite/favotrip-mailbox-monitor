FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:20-bookworm-slim AS runtime

# Create non-root user
RUN useradd --system --create-home --uid 10001 mailbox

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist

# Persistent state directory — mount a volume here in compose.
RUN mkdir -p /var/lib/mailbox-monitor && chown -R mailbox:mailbox /var/lib/mailbox-monitor /app

USER mailbox

# C13-B11-1 (fix-campagne wave 8): read-only /health endpoint (see
# src/health/health-server.ts) so a silently-hung IMAP fetch is
# distinguishable from "genuinely zero mail" from outside the container.
# No SMTP. No outbound mail capability beyond that. Read-only IMAP fetch +
# Slack webhook + this one health port.
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.HEALTH_PORT || 8080) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

LABEL org.favotrip.role="mailbox-monitor"
LABEL org.favotrip.observe-only="true"
LABEL org.favotrip.mailbox="klantenservice@favotrip.nl"

CMD ["node", "dist/index.js"]
