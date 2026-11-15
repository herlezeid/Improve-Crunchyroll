# Relay da watch party

Cloudflare Worker + Durable Objects (um objeto por sala, WebSockets em hibernação). Cabe no plano grátis.

## O que o servidor faz

- Aceita WebSocket só de origens `chrome-extension://` / `moz-extension://`.
- O primeiro a entrar na sala vira líder. Só o líder pode mandar estado; os outros mandam apenas status.
- O segredo de cada participante nunca é exposto: os outros veem um ID público derivado dele (SHA-256),
  que não serve para se passar por ninguém.
- Líder que cai tem 45 s para voltar; depois disso, quem entrou primeiro assume.
- Sala vazia é apagada depois de 6 h. Máximo de 12 pessoas por sala; mensagens de até 2 KB.
- Tudo é validado: ID de episódio no formato do Crunchyroll, posição, velocidade, nomes sem HTML.

## Rodar localmente

```sh
npm install
npm run dev        # ws://127.0.0.1:8787
```

Na extensão, use `ws://127.0.0.1:8787` em *Watch party → Servidor (avançado)*.

## Publicar

```sh
npx wrangler login     # uma vez
npm run deploy         # mostra a URL https://ic-watch-party.<sua-conta>.workers.dev
```

Depois troque `PARTY_DEFAULT_SERVER` em `lib/background/party.js` pela URL publicada, com `wss://`.
