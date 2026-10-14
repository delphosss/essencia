# Mapa de funcionalidades

Este documento resume o levantamento funcional do site de referência. A navegação foi feita com uma conta de cliente; as áreas de tarólogo e admin foram deduzidas do JS público. O documento mostra **onde cada funcionalidade está no código** e registra as **decisões tomadas** onde o levantamento não trazia resposta.

Legenda:

- **=** igual ao observado.
- **≈** adaptado.
- **+** adição nossa.

## 1. Área pública

| Funcionalidade | Status | Onde |
|---|---|---|
| Home com banners, Top 3, proposta, "como funciona", especialidades, grade de tarólogos, pacotes, depoimentos, blog | = | `views/public/home.ejs`, `routes/public.js` |
| Pop-up promocional da home (uma vez por visitante) | = | Admin → Configurações |
| Lista de tarólogos com status em tempo real (online, ocupado, offline), botões que mudam conforme o status e tempo restante quando ocupado | = | `partials/reader-card.ejs`, `public/js/app.js` (`reader:status`, `reader:busy`) |
| Filtro por categoria (`/categorias/:slug`), com online primeiro | = | `lib/queries.js` |
| Faixa promocional da 1ª compra | = | Configurações → "Faixa promocional" |
| Nota média no card | + | Calculada a partir dos depoimentos aprovados |
| Perfil: preços por canal, simulador de minutos (10/15/20/30/60) e depoimentos com rótulo (Excelente…) e data, sem o nome do cliente | = | `views/public/reader.ejs` |
| Botões do perfil: Consultar (escolha chat/vídeo), Agendar (janelas), Perguntar (várias perguntas, pessoas envolvidas, checagem de saldo), Avise-me | = | Modais em `reader.ejs` e rotas em `routes/api.js` |
| Comprar créditos: 4 pacotes com bônus e selo, bônus de 1ª compra e cupom | = | `views/public/buy.ejs`, `services/payments.js` |
| FAQ / Como consultar, Quem somos, Termos, Privacidade (editáveis) | = | Admin → Páginas e Admin → FAQ |
| Depoimentos (mural) | = | `/depoimentos` |
| Fale conosco (honeypot + limite de envios) e Trabalhe conosco (mesmos campos do original) | = | `/contato`, `/trabalhe-conosco` |
| Blog: categorias, paginação, comentários moderados, compartilhamento | = | `/blog` |
| Loja de serviços: busca, ofertas, produto, carrinho, checkout | ≈ | `/loja`. Sem cálculo de frete (os itens são serviços); o cliente deixa observações no pedido |
| `sitemap.xml`, `robots.txt`, manifest PWA | = | `routes/public.js` |
| Aviso de cookies; GA4, GTM, Meta Pixel e Clarity carregados só após o aceite | ≈ | `public/js/app.js`. IDs em Configurações |
| WhatsApp flutuante de suporte | = | Configurações → WhatsApp de suporte |

## 2. Cliente

| Funcionalidade | Status | Onde |
|---|---|---|
| Cadastro e login na mesma tela; campos: nome, nascimento, país (12 países), DDD e telefone, e-mail, senha, aceite | = | `routes/auth.js`, `views/public/auth.ejs` |
| Bloqueio de menores de 18 anos | + | Validação no cadastro |
| Login com Google (Google Identity Services) | = | Ativo quando `GOOGLE_CLIENT_ID` está definido |
| Recuperação de senha | ≈ | **Link de redefinição** válido por 1 h, em vez de enviar uma senha nova por e-mail |
| Checkout: abrir o checkout já cria um pedido "aguardando", que pode ser pago depois em Compras | = | `routes/checkout.js` |
| Pix (QR e copia-e-cola na página, confirmação automática) | = | `payments.startPix`, webhook do Mercado Pago |
| Cartão (Checkout Pro do Mercado Pago) | = | `payments.startCard` |
| PayPal Standard (IPN) | = | `payments.paypalForm` / `handlePaypalIpn` |
| Multibanco / MB Way | — | Não implementado (o PayPal cobre o público de Portugal) |
| Modal "Compra aprovada → Escolher tarólogo" | = | Evento `payment:approved` |
| Sala de espera "Chamando" com barra de 4 min, cancelamento e fallback por polling | = | `views/chat/calling.ejs`, `public/js/calling.js` |
| Sala de chat: tempo, tempo restante (saldo ÷ preço), saldo ao vivo, "digitando…", som de nova mensagem, recarga sem sair, encerrar | = | `views/chat/room.ejs`, `public/js/room.js` |
| Vídeo | ≈ | Jitsi embutido na sala (o provedor do original não foi identificado) |
| Painel: Resumo, Meus dados (CPF, CEP, "como nos conheceu", opt-in), Compras ("Pagar agora"), Atendimentos (crédito inicial e final, código, conversa), Mensagens, Perguntas, Agendadas, Depoimentos, Pedidos da loja | = | `routes/client.js`, `views/client/*` |
| Extrato de créditos minuto a minuto | + | `/minha-conta/extrato`. O original não tinha |
| Lista de "Avise-me" | + | `/minha-conta/alertas` |
| Avaliação pós-consulta (1–5 estrelas + texto, 1 por consulta) | = | `/minha-conta/avaliar/:code` |
| Sino de notificações (contador, lista, marcar lidas) em tempo real; notificações do navegador | = | `/api/notificacoes`, evento `notify` |

## 3. Tarólogo (atendente)

No original não houve acesso a esta área. Ela foi construída com o que o JS público revela e com o que o fluxo exige.

| Funcionalidade | Onde |
|---|---|
| Status online/offline. "Ocupado" é automático durante a consulta; o status vai para todos em tempo real | `consultations.setReaderStatus`, `/atendente/status` |
| Fica offline sozinho se fechar o painel (tolerância configurável) | `reader_offline_grace_seconds` |
| Chamada recebida: modal com campainha (Web Audio, até 60 s), contagem regressiva, aceitar ou recusar com motivo, notificação do navegador | `public/js/app.js` |
| WhatsApp a cada N segundos com **link de aceite assinado** (HMAC) | `/atendente/aceitar/:code?t=…` |
| Chamada sem resposta vira "consulta perdida", com notificação ao tarólogo e saldo do cliente | `consultations.missCall` |
| Pausar e retomar a consulta (o tempo não é cobrado; há limite de pausa) | Botões na sala |
| Painel com atendimentos e minutos do dia, ganhos do mês, saldo disponível, perguntas pendentes, próximos agendamentos e chamadas perdidas | `views/reader/dashboard.ejs` |
| Histórico de atendimentos com filtro e transcrições | `/atendente/atendimentos` |
| Perguntas pagas: fila e resposta (o cliente é avisado no sino e por e-mail) | `/atendente/perguntas` |
| Agenda: janelas de disponibilidade; confirmar, concluir e cancelar agendamentos | `/atendente/agenda` |
| Financeiro: extrato (bruto, %, líquido), solicitação de saque por Pix, histórico | `/atendente/financeiro` |
| Perfil: foto, oráculos, especialidades, bio, WhatsApp, Pix, canais. Preços só se o admin permitir | `/atendente/perfil` |
| Depoimentos recebidos e média | `/atendente/depoimentos` |
| Mensagens: com clientes já atendidos e com o suporte, com filtro de contato | `/mensagens` |

## 4. Admin

| Funcionalidade | Onde |
|---|---|
| Dashboard com vendas (dia e mês), créditos vendidos e consumidos, consultas, minutos, chamadas perdidas, novos clientes, saldo em carteiras, valor a pagar aos tarólogos, gráfico de 30 dias, consultas ao vivo, status dos tarólogos e **visitantes em tempo real** (quem está em qual página) | `/admin` |
| Tarólogos: criar e editar (login, perfil, foto, categorias, preços por canal, canais, % de repasse, WhatsApp, Pix, ordem, destaque Top 3, ativo), pôr online/offline, ajuste financeiro | `/admin/tarologos` |
| Clientes: busca, ficha (pedidos, consultas, extrato), ajuste de saldo com motivo, bloquear/desbloquear | `/admin/clientes` |
| Consultas: filtros, detalhes, eventos da chamada (log), transcrição, acompanhar a sala ao vivo, encerrar, devolver créditos (com estorno opcional do repasse) | `/admin/consultas` |
| Pedidos: filtros, aprovação manual (link de pagamento ou comprovante), cancelamento, estorno, anotações | `/admin/pedidos` |
| Saques: marcar como pago (com ID do Pix) ou recusar | `/admin/saques` |
| Pacotes, cupons (%, R$ ou bônus; validade, limite, 1 por cliente, só 1ª compra), categorias | CRUD genérico (`routes/admin/crud.js`) |
| Moderação de depoimentos e de comentários do blog | `/admin/depoimentos`, `/admin/comentarios` |
| Perguntas pagas (com reembolso) e agendamentos | `/admin/perguntas`, `/admin/agendamentos` |
| Candidaturas ("Trabalhe conosco") e Fale conosco | `/admin/candidaturas`, `/admin/contatos` |
| Conteúdo: banners, páginas, FAQ, posts e categorias do blog, produtos e categorias da loja | CRUD genérico |
| Notificação em massa (clientes, tarólogos, admins ou todos) | `/admin/notificacoes` |
| Mensagens do suporte | `/mensagens` |
| Configurações (todas as regras abaixo) e situação das integrações | `/admin/configuracoes` |
| Logs: eventos de chamada, e-mails e WhatsApp enviados, erros | `/admin/logs` |

## 5. Regras de negócio e decisões

As respostas abaixo cobrem as "Dúvidas" do levantamento. Todas podem ser ajustadas em **Admin → Configurações**.

| Dúvida | Decisão adotada |
|---|---|
| Comissão e repasse | **30% para o tarólogo e 70% para o site** (padrão configurável, ajustável por tarólogo). O perfil da dona (**Dama da Noite**) fica com 100% para a casa, sem repasse. Saque por Pix, mínimo de R$ 50, aprovado manualmente pelo admin |
| Validade dos créditos | Os créditos não expiram |
| Tempo mínimo | É preciso ter saldo para pelo menos 1 minuto (configurável) |
| Minuto cheio ou fracionado | **Minuto iniciado**: o 1º é cobrado quando os dois entram na sala e os seguintes a cada 60 s de tempo faturável |
| Aviso de saldo | Aviso quando faltam 2 min. O cliente pode recarregar em outra aba e o tempo restante é recalculado na hora |
| Queda de conexão | O tempo **para** enquanto alguém está desconectado. Depois de 90 s sem retorno a consulta é encerrada e só os minutos já usados são cobrados |
| Chat com imagem/áudio | Apenas texto (mais "digitando…" e som). Dados de contato são removidos automaticamente |
| Provedor de vídeo | Jitsi (o servidor é configurável e pode ser próprio) |
| Bônus de 1ª compra | Vale para **qualquer pacote** na primeira compra paga |
| Top 3 e ordenação | Primeiro o destaque manual, depois quem mais atendeu em 30 dias. Na lista: online → ocupado → offline, depois destaque e ordem manual |
| Cupons | Percentual, valor fixo ou bônus em créditos; validade, limite total, uso único por cliente, só na 1ª compra, compra mínima |
| Moderação de depoimentos | Aprovação prévia (configurável). Um depoimento por consulta com pelo menos 1 minuto cobrado |
| WhatsApp e e-mail | Adaptadores HTTP (estilo Z-API) e SMTP |
| Entrega da resposta da pergunta | No painel, com notificação no sino e e-mail. O admin pode reembolsar perguntas não respondidas |
| Chamada | 4 min para aceitar; campainha de 60 s; WhatsApp a cada 30 s (máx. 4 envios); um chamado por vez por tarólogo |
| Cancelamento de agendamento | Pelo site com ≥ 24 h de antecedência; depois disso, pelo suporte |

## 6. SEO, blog, loja e desempenho

| Item | Como está |
|---|---|
| Migração de URLs | Redirecionamento 301 automático de todas as URLs do site antigo (`/terapeutas/`, `/terapeuta/{slug}/`, `/comprar-saldo/`, `/blog-artigo/{cat}/{slug}/`, `/blog/{cat}/`, `/loja-item/{cat}/{slug}/`, `/faleconosco/`, `/registre-se/`, `/minha-conta/?pg=…` etc.) e remoção da barra final. Redirecionamentos extras em **Admin → Redirecionamentos** (com contador de acessos) |
| Meta tags | Título e descrição por página. Campos "Título/Descrição para o Google" em tarólogos, posts e produtos. Canonical, Open Graph, Twitter Card; `noindex` nas áreas logadas, no checkout e em buscas |
| Dados estruturados | Organization e WebSite (home), Person com oferta de preço (tarólogo), BlogPosting (post), Product com preço (loja), FAQPage (como consultar), BreadcrumbList (todas as páginas internas) |
| Sitemap e robots | `sitemap.xml` com categorias, tarólogos, posts (com `lastmod`), produtos e imagens; `robots.txt` bloqueando áreas privadas |
| Conteúdo para SEO | Texto de apresentação nas categorias de tarólogos, do blog e da loja, exibido no topo da página |
| Blog | Editor visual (com upload de imagem otimizada), autor, data de atualização, tempo de leitura, "Leia também", chamada para consulta, comentários moderados, paginação com canonical e feed RSS (`/blog/feed.xml`) |
| Loja de serviços espirituais | Galeria de imagens, prazo de realização, **dados do trabalho no checkout** (pessoas, datas de nascimento, intenção), pagamento com Pix, cartão, PayPal **ou saldo de créditos**, andamento (Recebido → Em andamento → Concluído) com mensagem ao cliente por notificação e e-mail |
| Imagens | Uploads convertidos para WebP, em várias larguras, com `srcset`, `loading=lazy` e cache de 1 ano |
| Carregamento | Compressão Brotli/gzip (HTML de 26 KB → 5 KB), CSS/JS versionados com cache de 1 ano, scripts com `defer`, fontes sem bloquear a renderização, preload do logo. Lighthouse 100/100/100/100 |

## 7. Diferenças em relação ao original

- **Plataforma única.** O original é um SaaS multi-tenant (vários sites por `site_id`); aqui é uma instalação por site.
- **Push.** O original usa Firebase Cloud Messaging; aqui há notificações em tempo real via Socket.io, Notification API do navegador e WhatsApp. FCM pode entrar depois como um canal a mais em `services/messaging.js`.
- **Recuperação de senha** por link, em vez de nova senha por e-mail.
- **reCAPTCHA** foi substituído por honeypot e limite de tentativas. Pode ser adicionado nos formulários públicos.
- **Ainda não implementados:** frete na loja, Multibanco e MB Way.
