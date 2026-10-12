<!-- paved:begin managed -->

## Paved

This repository uses Paved for agent context, rules and verification.

- Project manifest: `.paved/manifest.yaml`
- Project context: `.paved/project/` (start at `feature-map/`)
- Project rules: `.paved/rules/`
- Verification profile: `.paved/verification/profile.yaml`
- Overrides: `.paved/overrides/overrides.yaml`

Change code through Paved: `/paved:intent` with the request, then `/paved:plan` and
`/paved:execute`, so project rules and verification apply. `/paved:status` shows the
project state and what is available.

Do not edit this block by hand; `paved init` and `paved update` maintain it. Write
project-specific instructions for agents outside it.
<!-- paved:end managed -->

## Project guidance

- Preserve PostgreSQL as the authority for seat ownership and reservation transitions; Redis is only queue and delivery infrastructure.
- Keep SQL inside module infrastructure/application code, not Fastify route handlers.
- Preserve strict TypeScript settings and redact reservation and admission capabilities from logs.
- Update the API contract, README, and focused tests when changing externally visible behavior.
- Run `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, and `npm run build` before completing a feature.
