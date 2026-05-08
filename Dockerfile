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

# No HTTP port exposed — this is a worker, not an HTTP service.
# No SMTP. No outbound mail capability. Read-only IMAP fetch + Slack webhook only.

LABEL org.favotrip.role="mailbox-monitor"
LABEL org.favotrip.observe-only="true"
LABEL org.favotrip.mailbox="klantenservice@favotrip.nl"

CMD ["node", "dist/index.js"]
