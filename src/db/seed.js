const bcrypt = require('bcryptjs');
const { slugify } = require('../lib/util');

// Dados iniciais. Idempotente: só cria o que ainda não existe.
// demo = true cria tarólogos, cliente, posts e produtos de exemplo (textos fictícios).
function seed(ctx, { demo = true } = {}) {
  const { db, config } = ctx;
  const count = (table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
      db.prepare("INSERT INTO users (role, name, email, password_hash) VALUES ('admin', 'Administração', ?, ?)")
        .run(config.admin.email, bcrypt.hashSync(config.admin.password, 10));
    }

    // Perfil da dona do site: atende como taróloga, mas 100% do valor é da casa.
    if (!db.prepare("SELECT 1 FROM readers WHERE slug = 'dama-da-noite'").get()) {
      let owner = db.prepare('SELECT id FROM users WHERE email = ?').get(config.owner.email);
      if (!owner) {
        owner = { id: db.prepare("INSERT INTO users (role, name, email, password_hash) VALUES ('reader', 'Dama da Noite', ?, ?)")
          .run(config.owner.email, bcrypt.hashSync(config.owner.password, 10)).lastInsertRowid };
      }
      db.prepare(`INSERT INTO readers (user_id, slug, display_name, oracles, bio, price_chat_cents, price_question_cents,
        commission_percent, is_owner, featured, sort_order) VALUES (?, 'dama-da-noite', 'Dama da Noite', ?, ?, 199, 500, 100, 1, 1, -1)`)
        .run(owner.id, 'Tarot Rider-Waite, Baralho Cigano, Lenormand, Tarô dos Guardiões',
          'Edite esta apresentação em Admin → Tarólogos ou no painel da taróloga.');
    }

    if (!count('categories')) {
      const cats = ['Amor e relacionamentos', 'Carreira e trabalho', 'Finanças', 'Espiritualidade', 'Família',
        'Saúde emocional', 'Autoconhecimento', 'Decisões e caminhos', 'Energias e proteção', 'Sonhos e sinais'];
      const ins = db.prepare('INSERT INTO categories (name, slug, sort_order) VALUES (?, ?, ?)');
      cats.forEach((name, i) => ins.run(name, slugify(name), i));
    }

    if (!count('packages')) {
      const ins = db.prepare('INSERT INTO packages (name, price_cents, bonus_cents, badge, sort_order) VALUES (?, ?, ?, ?, ?)');
      ins.run('Inicial', 1000, 0, 'Melhor para começar', 1);
      ins.run('Essencial', 2000, 200, null, 2);
      ins.run('Popular', 4000, 800, 'Mais escolhido', 3);
      ins.run('Completo', 6000, 1500, 'Melhor custo-benefício', 4);
    }

    if (!count('pages')) {
      const ins = db.prepare('INSERT INTO pages (slug, title, body) VALUES (?, ?, ?)');
      ins.run('quem-somos', 'Quem somos', `<p>Somos uma plataforma que conecta pessoas a tarólogos e oraculistas experientes, com atendimento online, sigiloso e no seu tempo.</p>
<p>Todos os profissionais passam por uma seleção antes de começar a atender. Você escolhe com quem quer conversar, vê as avaliações de outros clientes e paga só pelos minutos que usar.</p>`);
      ins.run('termos-de-uso', 'Termos de uso', `<h2>1. Sobre o serviço</h2>
<p>A plataforma intermedia consultas de tarot e oráculos entre clientes e profissionais independentes. As orientações têm caráter de aconselhamento e entretenimento e não substituem acompanhamento médico, psicológico, jurídico ou financeiro.</p>
<h2>2. Cadastro</h2>
<p>O uso é permitido apenas para maiores de 18 anos. Você é responsável pela veracidade dos dados e pelo sigilo da sua senha.</p>
<h2>3. Créditos e cobrança</h2>
<p>As consultas por chat e vídeo são cobradas por minuto iniciado, de acordo com o valor exibido no perfil do profissional. Perguntas avulsas têm valor fixo por pergunta. Os créditos são liberados após a confirmação do pagamento.</p>
<h2>4. Cancelamentos e reembolsos</h2>
<p>Consultas agendadas podem ser canceladas pelo site com a antecedência indicada na sua área. Em caso de falha técnica da plataforma ou do profissional, você pode escolher entre nova consulta, devolução dos créditos ou reembolso, respeitado o Código de Defesa do Consumidor.</p>
<h2>5. Conduta</h2>
<p>É proibido compartilhar dados de contato durante as consultas e usar a plataforma para assédio, fraude ou qualquer finalidade ilegal. O descumprimento pode levar à suspensão da conta.</p>`);
      ins.run('politica-de-privacidade', 'Política de privacidade', `<p>Tratamos seus dados conforme a Lei Geral de Proteção de Dados (LGPD).</p>
<h2>Dados que coletamos</h2>
<p>Nome, e-mail, data de nascimento, telefone, histórico de compras e de consultas, e dados técnicos de navegação.</p>
<h2>Para que usamos</h2>
<p>Para criar sua conta, processar pagamentos, prestar o atendimento, prevenir fraudes e, se você autorizar, enviar novidades.</p>
<h2>Pagamentos</h2>
<p>Os pagamentos são processados por parceiros (como Mercado Pago e PayPal). Não armazenamos dados de cartão.</p>
<h2>Seus direitos</h2>
<p>Você pode pedir acesso, correção ou exclusão dos seus dados pelo e-mail de contato informado no site.</p>`);
    }

    if (!count('faqs')) {
      const ins = db.prepare('INSERT INTO faqs (question, answer, sort_order) VALUES (?, ?, ?)');
      [
        ['Como faço uma consulta?', 'Crie sua conta, compre créditos e escolha um tarólogo que esteja online. Clique em "Chat" e aguarde o profissional aceitar a chamada.'],
        ['Como funciona a cobrança?', 'O chat e o vídeo são cobrados por minuto iniciado, com o valor mostrado no perfil de cada profissional. O tempo disponível aparece na tela durante a consulta.'],
        ['Existe consulta grátis?', 'Não. Mas na primeira compra você recebe um bônus em créditos.'],
        ['O tarólogo está ocupado ou offline. E agora?', 'Use o botão "Avise-me" para receber um alerta quando ele ficar online, envie uma pergunta paga para ser respondida depois ou agende um horário.'],
        ['Quais as formas de pagamento?', 'Pix, cartão de crédito e PayPal. O Pix costuma ser confirmado em poucos minutos.'],
        ['Meus créditos expiram?', 'Não. O saldo fica na sua conta até ser usado.'],
        ['E se a conexão cair?', 'O tempo para de contar enquanto um dos dois estiver desconectado. Se a reconexão não acontecer em poucos minutos, a consulta é encerrada e você paga apenas os minutos já usados.'],
        ['Posso cancelar um agendamento?', 'Sim, pela sua área do cliente, com a antecedência mínima informada. Depois disso, fale com o suporte.'],
      ].forEach(([q, a], i) => ins.run(q, a, i));
    }

    if (!count('banners')) {
      const ins = db.prepare('INSERT INTO banners (title, subtitle, link, sort_order) VALUES (?, ?, ?, ?)');
      ins.run('Respostas para o seu coração', 'Converse agora com tarólogos online e receba orientação no seu tempo.', '/tarologos', 1);
      ins.run('Bônus na primeira compra', 'Compre créditos e ganhe minutos extras para a sua primeira consulta.', '/comprar-creditos', 2);
    }

    if (!demo) return;

    if (!db.prepare("SELECT 1 FROM readers WHERE is_owner = 0").get()) {
      const hash = bcrypt.hashSync('tarot123', 10);
      const insUser = db.prepare("INSERT INTO users (role, name, email, password_hash, phone) VALUES ('reader', ?, ?, ?, ?)");
      const insReader = db.prepare(`INSERT INTO readers (user_id, slug, display_name, oracles, bio, price_chat_cents, price_video_cents,
        price_question_cents, video_enabled, commission_percent, featured, sort_order, whatsapp) VALUES (?, ?, ?, ?, ?, 199, 590, 500, ?, 30, ?, ?, ?)`);
      const insCat = db.prepare('INSERT INTO reader_categories (reader_id, category_id) VALUES (?, ?)');
      const catIds = db.prepare('SELECT id FROM categories ORDER BY sort_order').all().map((c) => c.id);
      const readers = [
        ['Luna Arcana', 'Tarot de Marselha, Baralho Cigano', 'Atendo há 12 anos com foco em relacionamentos e decisões. Leitura direta, acolhedora e sem rodeios.', 1, [0, 7]],
        ['Mestre Orion', 'Tarot Rider-Waite, Runas', 'Uno o tarot às runas para trazer clareza sobre carreira, dinheiro e os próximos passos da sua vida.', 0, [1, 2, 7]],
        ['Cigana Safira', 'Baralho Cigano, Lenormand', 'Herdei da minha família a leitura das cartas ciganas. Falo sobre amor, família e caminhos espirituais.', 1, [0, 4, 3]],
        ['Íris do Vale', 'Tarot Thoth, Oráculo dos Anjos', 'Terapeuta holística e taróloga. Ajudo você a entender seus sentimentos e a cuidar da sua energia.', 0, [5, 6, 8]],
        ['Caio Estelar', 'Tarot Rider-Waite, Astrologia', 'Combino tarot e mapa astral para respostas objetivas sobre amor e trabalho.', 0, [0, 1]],
        ['Mãe Jurema', 'Búzios, Baralho Cigano', 'Orientação espiritual com fé e respeito. Especialista em proteção e limpeza energética.', 0, [3, 8, 9]],
      ];
      readers.forEach(([name, oracles, bio, video, cats], i) => {
        const email = `${slugify(name).replace(/-/g, '.')}@exemplo.com`;
        const { lastInsertRowid: uid } = insUser.run(name, email, hash, '');
        const { lastInsertRowid: rid } = insReader.run(uid, slugify(name), name, oracles, bio, video, i < 3 ? 1 : 0, i, '');
        cats.forEach((c) => insCat.run(rid, catIds[c]));
      });
    }

    if (!db.prepare("SELECT 1 FROM users WHERE role = 'client'").get()) {
      db.prepare("INSERT INTO users (role, name, email, password_hash, birth_date, phone, area_code) VALUES ('client', 'Cliente Demo', 'cliente@exemplo.com', ?, '1990-05-10', '999999999', '11')")
        .run(bcrypt.hashSync('cliente123', 10));
    }

    if (!count('blog_categories')) {
      const ins = db.prepare('INSERT INTO blog_categories (name, slug) VALUES (?, ?)');
      ['Tarot', 'Signos', 'Espiritualidade', 'Amor'].forEach((n) => ins.run(n, slugify(n)));
      const cat = db.prepare('SELECT id FROM blog_categories WHERE slug = ?');
      const post = db.prepare('INSERT INTO blog_posts (category_id, title, slug, excerpt, body) VALUES (?, ?, ?, ?, ?)');
      post.run(cat.get('tarot').id, 'Como se preparar para a sua primeira consulta', 'como-se-preparar-para-a-primeira-consulta',
        'Algumas dicas simples para aproveitar melhor cada minuto com o tarólogo.',
        '<p>Antes de chamar, escolha um tema principal e pense em perguntas abertas, como "o que preciso saber sobre..." em vez de "sim ou não".</p><p>Fique em um lugar tranquilo e anote os pontos que mais chamarem sua atenção.</p>');
      post.run(cat.get('amor').id, 'O que as cartas dizem sobre recomeços', 'o-que-as-cartas-dizem-sobre-recomecos',
        'Algumas cartas do tarot falam de fim de ciclo e de novas oportunidades.',
        '<p>Cartas como a Morte e a Torre costumam assustar, mas falam de transformação. Na leitura, elas indicam que algo precisa terminar para que o novo chegue.</p>');
      post.run(cat.get('espiritualidade').id, 'Pequenos rituais para proteger sua energia', 'pequenos-rituais-para-proteger-sua-energia',
        'Hábitos simples que ajudam a manter o equilíbrio no dia a dia.',
        '<p>Respirar fundo, organizar o ambiente e reservar alguns minutos de silêncio já fazem diferença. Use o que fizer sentido para você.</p>');
    }

    if (!count('product_categories')) {
      db.prepare('INSERT INTO product_categories (name, slug) VALUES (?, ?)').run('Serviços', 'servicos');
      const catId = db.prepare("SELECT id FROM product_categories WHERE slug = 'servicos'").get().id;
      const ins = db.prepare(`INSERT INTO products (category_id, name, slug, sku, price_cents, compare_at_cents, summary, description, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      ins.run(catId, 'Leitura completa por escrito', 'leitura-completa-por-escrito', 'SRV-001', 9700, 12900,
        'Uma tiragem detalhada enviada por mensagem em até 3 dias.', '<p>Você envia sua pergunta e recebe uma leitura completa, com a interpretação de cada carta.</p>', 1);
      ins.run(catId, 'Mapa astral comentado', 'mapa-astral-comentado', 'SRV-002', 14900, null,
        'Seu mapa astral interpretado por um especialista.', '<p>Informe data, hora e local de nascimento. O relatório é entregue em PDF.</p>', 2);
    }
  })();
}

module.exports = { seed };

if (require.main === module) {
  const { createContext } = require('../context');
  const ctx = createContext();
  seed(ctx, { demo: process.argv.includes('--demo') || process.env.SEED_DEMO !== 'false' });
  console.log('Seed concluído.');
}
