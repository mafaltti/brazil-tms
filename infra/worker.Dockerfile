# Import worker image (feature 004) — the sanctioned "one app + one worker" process. Builds the pnpm
# monorepo and runs the @brazil-tms/workers pg-boss process (parse/validate/detect-duplicates/
# generate-error-report/confirm-import). Template/dev-grade (not size-optimized); production should
# add a pruned multi-stage build. The same process is run in dev with `pnpm --filter @brazil-tms/workers start`.
FROM node:20-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@brazil-tms/workers", "start"]
