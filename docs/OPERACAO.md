# Operação do backend: avisos, liberação de saldo e repasse

Este guia explica o que precisa estar configurado no servidor para que três coisas funcionem sem intervenção manual:

1. os **avisos** chegarem ao tarólogo e ao cliente;
2. o **saldo** do cliente ser liberado logo depois do pagamento;
3. o **repasse** ser calculado corretamente (30% tarólogo / 70% site, 100% para a casa no perfil da Dama da Noite).

---

## 1. Liberação do saldo do cliente

### Como funciona

```
Cliente escolhe o pacote ─► pedido "aguardando" ─► Pix/cartão no Mercado Pago
                                                     │
                       Mercado Pago chama o webhook ◄┘   POST /webhooks/mercadopago
                                                     │
   o servidor consulta o pagamento na API do MP ─────┤   (não confia só na notificação)
                                                     │
          status "approved" e valor correto? ── sim ─► markPaid(): credita pacote + bônus,
                                                        grava extrato, notifica o cliente
```

- O crédito é **idempotente**: se o Mercado Pago avisar duas vezes, o saldo entra uma vez só.
- O servidor **consulta o pagamento** na API antes de creditar. Também confere se o valor pago é pelo menos o valor do pedido.
- A tela de pagamento consulta o status a cada 5 s. Ela também recebe o evento em tempo real, então o modal "Compra aprovada" aparece sozinho.
- **PayPal:** o PayPal chama `POST /webhooks/paypal` (IPN). O servidor devolve a mensagem ao PayPal para validá-la e confere o recebedor e o valor.
- **Plano B:** o admin pode aprovar o pedido manualmente em **Admin → Pedidos → Marcar como pago**. Use para link de pagamento enviado pelo WhatsApp ou depósito.

### O que configurar

| Item | Onde | Por quê |
|---|---|---|
| `BASE_URL=https://seu-dominio.com.br` | `.env` | O webhook e o retorno do cartão são montados com essa URL. Ela precisa ser **pública e com HTTPS** |
| `MP_ACCESS_TOKEN` | `.env` | Credencial de produção do Mercado Pago (Seu negócio → Credenciais) |
| Webhook "Pagamentos" | Painel do Mercado Pago → Suas integrações → Webhooks | URL: `https://seu-dominio.com.br/webhooks/mercadopago` |
| `MP_WEBHOOK_SECRET` | `.env` (copiar do painel de webhooks) | Valida a assinatura e impede notificações falsas |
| `PAYPAL_BUSINESS_EMAIL`, `PAYPAL_SANDBOX=false` | `.env` | Conta que recebe e modo produção |
| `NODE_ENV=production` | `.env` | Desliga o simulador de pagamento |

**Como testar:** faça um Pix de R$ 10 real e confira três coisas:

1. O pedido muda para **Pago** em Admin → Pedidos.
2. O saldo aparece no topo do site.
3. Em Admin → Logs → Erros, não há nada de "mercadopago".

Se o pedido ficar parado em "Aguardando":

- confira o webhook no painel do MP: ele mostra as tentativas e os códigos de resposta;
- confira se `BASE_URL` está certa.

---

## 2. Avisos (tarólogo, cliente e admin)

### Canais

| Canal | Quem recebe | Depende de |
|---|---|---|
| **Tempo real (Socket.io)**: campainha, modal de chamada, status online, chat, sino | Quem está com o site aberto | Proxy com suporte a WebSocket |
| **WhatsApp**: chamada com link de aceite, nova pergunta paga | Tarólogo com WhatsApp no perfil | `WHATSAPP_API_URL` (+ token) |
| **E-mail**: avise-me, resposta de pergunta, andamento da loja, senha | Cliente | SMTP no `.env` |
| **Notificação do navegador** | Quem clicou em "Ativar notificações" | Permissão do navegador |
| **Sino (notificações internas)** | Todos | Sempre ativo, fica gravado no banco |

### Chamada de consulta, passo a passo

1. O cliente clica em **Chat**. O servidor valida o saldo e o status do tarólogo e cria a chamada.
2. O tarólogo é avisado de três formas ao mesmo tempo:
   - modal com campainha no painel (toca por até 60 s);
   - notificação do navegador;
   - **WhatsApp com link de aceite**, repetido a cada 30 s, no máximo 4 vezes.

   O link é assinado, então funciona mesmo que o tarólogo não esteja logado no celular.
3. Sem resposta em 4 min, a chamada vira **consulta perdida**: o tarólogo recebe o aviso no sino e o cliente vê opções (avise-me, pergunta, outro tarólogo).

Tempos e repetições são ajustados em **Admin → Configurações → Chamadas e sala**.

### O que configurar

**WhatsApp (Z-API ou similar).** O sistema envia `POST {phone, message}` em JSON para `WHATSAPP_API_URL`, com o cabeçalho `Client-Token` igual a `WHATSAPP_API_TOKEN`.

- **Z-API:** `WHATSAPP_API_URL=https://api.z-api.io/instances/SUA_INSTANCIA/token/SEU_TOKEN/send-text` e `WHATSAPP_API_TOKEN=` com o "Client-Token" da conta.
- **Outro provedor** (Evolution, Twilio etc.): ajuste o corpo em `src/services/messaging.js`, função `sendWhatsapp`.
- Cada tarólogo precisa ter o **WhatsApp com DDD** no perfil.

**E-mail.** Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` e `SMTP_FROM`. Pode ser Brevo, Amazon SES, Mailgun, Zoho ou o SMTP da hospedagem. Configure também SPF e DKIM no domínio, para os e-mails não caírem no spam.

**Tempo real.** No Nginx, o proxy precisa repassar WebSocket:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 120s;
}
```

**Painel aberto.** O tarólogo precisa manter o painel aberto (no computador ou no celular) enquanto estiver online. Se fechar, o sistema o coloca **offline automaticamente** depois de 2 min, para o cliente não chamar quem não está.

**Como testar:** veja em **Admin → Logs → E-mails e WhatsApp**. Ali aparece tudo o que foi enviado e qualquer falha.

---

## 3. Cobrança da consulta e repasse

### Cobrança do cliente

- O valor é **por minuto iniciado**. O 1º minuto é cobrado quando cliente e tarólogo estão os dois na sala; depois, um minuto a cada 60 s.
- O relógio **para** quando alguém cai ou quando o tarólogo pausa.
- Se o saldo não cobre o próximo minuto, a sala encerra sozinha. O cliente é avisado quando faltam 2 min e pode recarregar sem sair da sala.
- Cada minuto vira uma linha no extrato do cliente. Se o servidor reiniciar, nada cobrado se perde.

### Repasse

Ao fim de cada consulta (e quando uma pergunta paga é respondida), o sistema lança o ganho do tarólogo:

```
valor cobrado do cliente × percentual do tarólogo = ganho do tarólogo
o restante                                         = receita do site
```

| Perfil | Tarólogo | Site |
|---|---|---|
| Todos os tarólogos (padrão) | **30%** | **70%** |
| **Dama da Noite** (perfil da dona) | — | **100%**, sem repasse e sem saque |

- O padrão de 30% fica em **Admin → Configurações → Repasse padrão**. Ele vale para cada tarólogo novo.
- Um tarólogo específico pode ter outro percentual em **Admin → Tarólogos → editar**.
- A Dama da Noite está marcada como **"Perfil da dona do site"**. Com essa opção, o sistema fixa 100% para a casa. Ela não entra em "Saldo a pagar aos tarólogos", e o painel dela avisa que não há saque.

Exemplo: consulta de 10 min a R$ 1,99/min = R$ 19,90. O tarólogo recebe R$ 5,97 (30%) e o site fica com R$ 13,93 (70%). Com a Dama da Noite, os R$ 19,90 ficam com o site.

O **dashboard do admin** mostra:

- **Receita do site (30 dias):** parte da casa nas consultas e perguntas, já sem o repasse, somada a 100% da Dama da Noite.
- **Repasse aos tarólogos (30 dias).**
- **Saldo a pagar aos tarólogos.**

### Saques

1. O tarólogo pede o saque por Pix em **Painel → Financeiro** (mínimo de R$ 50, configurável).
2. O valor fica **reservado** até o admin decidir.
3. O admin paga o Pix pelo banco e marca **Pago** em **Admin → Saques**, informando o ID do Pix.
4. O tarólogo recebe o aviso. O lançamento negativo entra no extrato dele.

Se uma consulta precisar ser devolvida ao cliente, use **Admin → Consultas → Devolver créditos**. A opção "estornar também o repasse" desconta a parte do tarólogo.

---

## 4. Checklist de produção

- [ ] Servidor com Node 20+ (VPS ou hospedagem com Node), `npm ci` e `NODE_ENV=production`.
- [ ] Domínio com **HTTPS** (Let's Encrypt) e o proxy acima, com WebSocket.
- [ ] `.env` completo:
  - `BASE_URL`, `SESSION_SECRET` (longo e aleatório);
  - `ADMIN_*` e `OWNER_*`;
  - Mercado Pago, PayPal, SMTP, WhatsApp.
- [ ] Webhook do Mercado Pago cadastrado e testado com um Pix real.
- [ ] Processo gerenciado (`pm2 start src/server.js --name essencia`, `pm2 save`, `pm2 startup`).
- [ ] **Uma única instância** do processo: o motor de cobrança roda em memória.
- [ ] Backup diário do arquivo do banco (`DATABASE_PATH`) e da pasta `public/uploads`.
- [ ] Logo em alta resolução em **Admin → Configurações → Logo**. O logo atual foi recortado de um print e é provisório.
- [ ] **Google Search Console:**
  - adicionar o domínio;
  - enviar `https://seu-dominio.com.br/sitemap.xml`;
  - acompanhar a migração. As URLs antigas (`/terapeuta/...`, `/blog-artigo/...`, `/loja-item/...` etc.) já redirecionam com 301.
- [ ] Ao cadastrar os tarólogos, **use o mesmo slug do site antigo** (ex.: `/terapeuta/dama-da-noite` → `/tarologo/dama-da-noite`). Assim o redirecionamento automático acerta. Para URLs que mudaram de nome, use **Admin → Redirecionamentos**.
