# Arcano — plataforma de consultas de tarot online

Plataforma completa de consultas de tarot ao vivo, com três áreas:

- **Cliente**: compra créditos (Pix, cartão, PayPal), conversa com tarólogos por chat ou vídeo cobrado por minuto, envia perguntas pagas, agenda horários e avalia os atendimentos.
- **Tarólogo (atendente)**: fica online, recebe chamadas com campainha e WhatsApp, atende na sala, responde perguntas, gerencia a agenda, acompanha os ganhos e pede saques.
- **Admin**: dashboard em tempo real, gestão de tarólogos, clientes, consultas, pedidos, saques, pacotes, cupons, moderação, conteúdo (banners, páginas, FAQ, blog, loja) e configurações.

O levantamento funcional que originou o projeto e o mapa completo de funcionalidades estão em [`docs/FUNCIONALIDADES.md`](docs/FUNCIONALIDADES.md).

O nome "Arcano", os textos e o visual são provisórios e originais. Troque o nome em **Admin → Configurações** e o ícone em `public/img/icon.svg`.

## Stack

| Camada | Tecnologia |
|---|---|
| Servidor | Node.js 20+ e Express 4 |
| Páginas | EJS renderizado no servidor (bom para SEO), CSS e JS próprios, sem framework |
| Tempo real | Socket.io: status dos tarólogos, chamadas, chat, notificações, visitantes |
| Banco | SQLite (`better-sqlite3`), com o schema em `src/db/schema.sql` |
| Pagamentos | Mercado Pago (Pix e Checkout Pro), PayPal Payments Standard (IPN) e um simulador para desenvolvimento |
| Vídeo | Jitsi Meet (sala embutida, servidor configurável) |
| E-mail / WhatsApp | SMTP (nodemailer) e uma API HTTP no estilo Z-API. Sem configuração, as mensagens só vão para o log |

## Rodando localmente

```bash
cp .env.example .env
npm install
npm start
```

Acesse http://localhost:3000.

No primeiro start, o seed cria:

| Perfil | Login | Senha |
|---|---|---|
| Admin | `admin@exemplo.com` | `admin123` (defina `ADMIN_EMAIL`/`ADMIN_PASSWORD` no `.env`) |
| Cliente demo | `cliente@exemplo.com` | `cliente123` |
| Tarólogos demo | `luna.arcana@exemplo.com` (e os outros em Admin → Tarólogos) | `tarot123` |

Para não criar os dados de demonstração, use `SEED_DEMO=false`.

Sem `MP_ACCESS_TOKEN`, o checkout usa o **simulador de pagamento**. Ele gera um Pix falso e oferece o botão "Simular pagamento aprovado". O simulador nunca fica ativo com `NODE_ENV=production`.

### Testando uma consulta de ponta a ponta

1. Numa janela, entre como tarólogo e clique em **Ficar online**.
2. Numa janela anônima, entre como cliente, compre créditos no simulador e clique em **Chat** no card do tarólogo.
3. Na janela do tarólogo aparece a chamada com campainha. Clique em **Aceitar** e os dois vão para a sala.

## Testes

```bash
npm test
```

São 27 testes:

- **Unitários (26):** cobrança por minuto, saldo esgotado, desconexão, pausa, chamada perdida, repetição do WhatsApp, bônus de primeira compra, cupons, idempotência do pagamento, estorno, assinatura do webhook, perguntas, agenda, depoimentos, saques, mensagens e notificações.
- **Ponta a ponta (1):** servidor HTTP real e clientes Socket.io percorrendo cadastro → compra → chamada → chat → cobrança → encerramento → avaliação.

## Produção

1. **`.env`:**
   - `NODE_ENV=production`, `BASE_URL` com HTTPS e um `SESSION_SECRET` forte.
   - `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET`.
   - `PAYPAL_BUSINESS_EMAIL` e `PAYPAL_SANDBOX=false`.
   - SMTP e WhatsApp.
2. **Webhooks:**
   - No painel do Mercado Pago, cadastre `https://SEU_DOMINIO/webhooks/mercadopago` (evento "Pagamentos").
   - No PayPal, a URL de IPN (`/webhooks/paypal`) já vai em cada pagamento.
3. **Proxy reverso** (Nginx/Caddy) com HTTPS e suporte a WebSocket (`Upgrade`/`Connection`).
4. **Processo:** rode com `pm2`/systemd. Os minutos já cobrados ficam gravados, e um restart encerra as consultas abertas sem cobrar a mais.
5. **Backup:** faça backup do arquivo SQLite (`DATABASE_PATH`) e da pasta `public/uploads`.

**Escala:** o motor de consultas roda em um único processo, com estado em memória e um tick de 1 s. Para várias instâncias seria preciso:

- um adapter Redis no Socket.io;
- mover o loop de cobrança para um worker único;
- trocar o SQLite por PostgreSQL.

## Estrutura

```
src/
  server.js            inicia HTTP + Socket.io + loop das consultas
  app.js               Express, sessão, CSRF, rotas
  context.js           monta banco, configurações e serviços
  db/schema.sql        tabelas
  db/seed.js           dados iniciais
  services/            regras de negócio (wallet, payments, consultations, questions,
                       appointments, reviews, earnings, inbox, notifications, messaging)
  realtime/index.js    eventos Socket.io
  routes/              public, auth, checkout, consult, client, reader, admin/*
  views/               EJS (public, client, reader, admin, chat, shared, partials)
public/                css, js, img, uploads
test/                  testes (node:test)
```
