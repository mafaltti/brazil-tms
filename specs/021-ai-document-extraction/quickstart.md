# Quickstart — AI Document Reading (021)

## Automated coverage (no key — CI/local default)

`pnpm -w lint && pnpm -w typecheck && pnpm -w build`; Vitest (shared schema tests + the
fake-client extraction unit tests); Playwright `ai-extraction.spec.ts` (affordance on the three
forms, not-configured 503 path with the form untouched, `manage_fleet_data` 403, 400 validation).

## Live verification (requires a real key — manual)

1. Set `ANTHROPIC_API_KEY=sk-ant-…` in the app server environment (server-only; NEVER
   `NEXT_PUBLIC_*`). Restart `next start`.
2. Sign in as a `manage_fleet_data` holder (fleet coordinator/admin) → Motoristas → Novo motorista.
3. "Ler CNH (IA)" → select a legible CNH photo (JPEG/PNG/WebP/GIF ≤ 7,5 MB — Anthropic caps
   images at 10 MB AFTER base64 encoding — or PDF ≤ 10 MB).
4. Expect: nome, nº registro, categoria e validade preenchidos; aviso "confira antes de salvar";
   campos ilegíveis listados e deixados em branco. Corrija o que precisar e salve — o registro
   entra pelo fluxo normal validado.
5. Repita em Veículos/Reboques com um CRLV (placa/tipo/validade; reboque não mapeia tipo).
6. Negativos: uma foto qualquer (não-documento) → "não foi possível ler", formulário intacto;
   imagem > 7,5 MB ou PDF > 10 MB → recusa local imediata (e o servidor devolve 400 sem chamar o
   provider, caso o payload chegue lá por outro caminho).
7. Privacidade: confirme que nenhuma imagem foi parar em Storage/DB/logs (não há código que
   persista o payload — FR-005).

Custo: ~1 chamada de visão por documento no modelo `claude-opus-4-8` (centavos). Sem chave, a
feature fica apagada e os formulários seguem 100% manuais.
