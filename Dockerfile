# Debian slim, not Alpine: sharp/libvips and the bundled ffmpeg binaries
# target glibc, and Debian avoids musl-related native-module surprises.
FROM node:20-bookworm-slim

WORKDIR /app

# Create the non-root user and switch to it BEFORE installing anything, so
# node_modules (and everything else) is owned by appuser from the moment it's
# created. A chown -R after the fact would copy-up the whole tree into a new
# layer and roughly double the image size for no benefit.
RUN useradd --system --create-home --shell /usr/sbin/nologin appuser \
  && chown appuser:appuser /app
USER appuser

# Install dependencies first so this layer only rebuilds when package*.json
# changes, not on every source edit.
COPY --chown=appuser:appuser package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=appuser:appuser server.js ./
COPY --chown=appuser:appuser lib ./lib
COPY --chown=appuser:appuser public ./public

ENV HOST=0.0.0.0
ENV PORT=3210
EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
