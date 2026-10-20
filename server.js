const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const SELLER_CHAT_ID = process.env.SELLER_CHAT_ID;
//const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
const APP_URL = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : (process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`);

const pendingOrders = {};

// Rota para Gerar Pix com Metadados embutidos no Mercado Pago
app.post('/api/checkout-pix', async (req, res) => {
    try {
        const { items, userTelegramId, userUsername } = req.body;
        
        if (!items || items.length === 0) {
            return res.status(400).json({ error: 'Carrinho vazio' });
        }

        // Sanitização e conversão segura dos preços
        const parsePreco = (val) => {
            if (!val) return 5.00;
            let num = parseFloat(String(val).replace(/[^\d.,]/g, '').replace(',', '.'));
            return isNaN(num) || num <= 0 ? 5.00 : num;
        };

        let subtotal = items.reduce((acc, item) => acc + parsePreco(item.preco), 0);
        let desconto = Math.max(0, items.length - 1); 
        let totalFinal = Math.max(1, subtotal - desconto); 

        // Gera IDs curtos e únicos por transação
        const transactionUniqueId = `${userTelegramId}_${Date.now()}`;
        const orderKey = `order_${transactionUniqueId}_${Math.floor(Math.random() * 1000)}`;

        // Descrição curta fixa para a fatura do cliente
        const descricaoFixa = items.length === 1 
            ? `Série: ${String(items[0].titulo).substring(0, 30)}`
            : `Combo com ${items.length} séries - DORAMAX`;

        // Salva os dados completos na memória do Node.js (sem limite de tamanho)
        const metadata = { 
            userTelegramId, 
            userUsername, 
            items: items.map(i => ({ titulo: i.titulo, preco: parsePreco(i.preco).toFixed(2) })) 
        };

        // external_reference ULTRA CURTO (apenas o ID da transação) para nunca estourar o limite de 256 caracteres
        const externalReferenceCurto = JSON.stringify({ id: transactionUniqueId });

        const paymentData = {
            transaction_amount: Number(totalFinal.toFixed(2)),
            description: descricaoFixa,
            payment_method_id: 'pix',
            payer: {
                email: `u_${transactionUniqueId}@telegram.com`,
                first_name: String(userUsername || 'Cliente').substring(0, 20)
            },
            external_reference: externalReferenceCurto
        };

        const mpResponse = await axios.post('https://api.mercadopago.com/v1/payments', paymentData, {
            headers: {
                'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
                'X-Idempotency-Key': orderKey
            }
        });

        const paymentId = mpResponse.data.id;
        
        // Associa o ID real do Mercado Pago e o ID temporário aos dados do pedido
        pendingOrders[paymentId] = metadata;
        pendingOrders[transactionUniqueId] = metadata;

        const pointOfInteraction = mpResponse.data.point_of_interaction;
        const qrCodeBase64 = pointOfInteraction?.transaction_data?.qr_code_base64;
        const qrCodeCopyPaste = pointOfInteraction?.transaction_data?.qr_code;

        res.json({
            paymentId,
            qrCodeBase64,
            qrCodeCopyPaste,
            totalFinal: totalFinal.toFixed(2)
        });

    } catch (error) {
        const mpError = error.response?.data;
        console.error('❌ ERRO DETALHADO DO MERCADO PAGO:', JSON.stringify(mpError || error.message));
        const detalheErro = mpError?.message || mpError?.cause?.[0]?.description || error.message;
        res.status(500).json({ error: `Erro no Mercado Pago: ${detalheErro}` });
    }
});

// Objeto para evitar envio duplicado de notificações
const processedPayments = new Set();

async function processarAprovacaoPagamento(paymentId, paymentInfo) {
    // Evita duplicar notificações caso a tela e o webhook acionem juntos
    if (processedPayments.has(paymentId)) return;

    let orderData = pendingOrders[paymentId];

        if (!orderData && paymentInfo.data.external_reference) {
        try {
            const extRef = JSON.parse(paymentInfo.data.external_reference);
            if (extRef.id) {
                orderData = pendingOrders[extRef.id];
            }
        } catch (e) {}
    }

    if (orderData && orderData.userTelegramId) {
        processedPayments.add(paymentId);

        const { userTelegramId, userUsername, items } = orderData;
        const listaSeries = items.map(i => `• *${i.titulo}*`).join('\n');

        // 1. Mensagem CLARA e ORIENTATIVA para o CLIENTE
        const mensagemCliente = 
`🎉 *Pagamento Aprovado com Sucesso!*

📺 *Item(ns) solicitado(s):*
${listaSeries}

⏳ *COMO VOCÊ IRÁ RECEBER:*
O nosso atendimento é humano e personalizado! O administrador já foi notificado e irá enviar os episódios/links de acesso *diretamente aqui neste chat* em alguns minutos.

💬 *PRECISA DE AJUDA OU DÚVIDAS?*
Se precisar de suporte imediato, pode chamar o administrador no privado: @Stikdark

Por favor, aguarde só um instante que o seu conteúdo já está a caminho! 🍿🚀`;

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: userTelegramId,
            text: mensagemCliente,
            parse_mode: 'Markdown'
        });

        // 2. Notificação Completa para o VENDEDOR (Você)
        if (SELLER_CHAT_ID) {
            const clienteLink = userUsername ? `@${userUsername}` : `[Clique aqui para abrir o chat](tg://user?id=${userTelegramId})`;
            
            const mensagemVendedor = 
`🔔 *NOVA VENDA APROVADA!*

👤 *Cliente:* ${clienteLink}
🆔 *ID Telegram:* \`${userTelegramId}\`

📺 *Série(s) escolhida(s):*
${listaSeries}

💰 *Valor Pago:* R$ ${paymentInfo.data.transaction_amount}

👉 *Ação necessária:* Envie o acesso para o cliente acima!`;

            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: SELLER_CHAT_ID,
                text: mensagemVendedor,
                parse_mode: 'Markdown'
            });
        }

        delete pendingOrders[paymentId];
    }
}

app.get('/api/check-payment/:id', async (req, res) => {
    try {
        const paymentId = req.params.id;
        const paymentInfo = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { 'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}` }
        });

        if (paymentInfo.data.status === 'approved') {
            await processarAprovacaoPagamento(paymentId, paymentInfo);
        }

        res.json({ status: paymentInfo.data.status });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao verificar status' });
    }
});

// Webhook Automático do Mercado Pago
app.post('/api/webhook-mercadopago', async (req, res) => {
    try {
        const body = req.body;
        if (body.type === 'payment' || (body.action && body.action.includes('payment'))) {
            const paymentId = body.data?.id || body.id;
            if (paymentId) {
                const paymentInfo = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                    headers: { 'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}` }
                });

                if (paymentInfo.data.status === 'approved') {
                    await processarAprovacaoPagamento(paymentId, paymentInfo);
                }
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        res.status(200).send('OK');
    }
});

//app.post('/api/telegram-webhook', async (req, res) => {
    //try {
        //const update = req.body;
        //if (update.message && update.message.text) {
            //const chatId = update.message.chat.id;
            //const text = update.message.text;
            //const firstName = update.message.from.first_name || 'Cliente';

            //if (text.startsWith('/start')) {
                //await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    //chat_id: chatId,
                    //text: `Olá ${firstName} 👋! Seja muito bem-vindo(a) ao nosso app.\n\n👇 Toque no botão abaixo para abrir o catálogo e aproveitar nossos lançamentos!`,
                    //reply_markup: {
                        //inline_keyboard: [
                            //[{ text: "🎬 APP-DORAMAX", web_app: { url: APP_URL } }]
                        //]
                    //}
                //});
            //}
        //}
        //res.status(200).send('OK');
    //} catch (error) {
        //res.status(500).send('Erro');
    //}
//});
// Rota unificada para o Webhook do Telegram (funciona com ou sem o prefixo /api)
const handleTelegramWebhook = async (req, res) => {
    try {
        const update = req.body;
        if (update && update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            const firstName = update.message.from.first_name || 'Cliente';

            if (text.startsWith('/start')) {
                // Usa o domínio atual da Vercel ou localhost
                const host = req.headers['x-forwarded-host'] || req.headers.host;
                const protocol = req.headers['x-forwarded-proto'] || 'https';
                const appDomain = `${protocol}://${host}`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId,
                    text: `Olá ${firstName} 👋! Seja muito bem-vindo(a) ao nosso app.\n\n👇 Toque no botão abaixo para abrir o catálogo e aproveitar nossos lançamentos!`,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🎬 APP-DORAMAX", web_app: { url: appDomain } }]
                        ]
                    }
                });
            }
        }
                    // Comando para COPIAR e enviar qualquer conteúdo (Vídeo, Foto com Legenda, Capa, etc.) para o cliente pelo ID
            // Como usar: Responda à mensagem/vídeo da série e digite: /enviarmidia ID_CLIENTE
            if (text.startsWith('/envmid') || text.startsWith('/fwd')) {
                if (String(chatId) !== String(SELLER_CHAT_ID)) {
                    return res.status(200).send('OK');
                }

                const partes = text.split(' ');
                const targetId = partes[1];
                const replyToMessageId = update.message.reply_to_message?.message_id;

                if (!targetId || !replyToMessageId) {
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: chatId,
                        text: `⚠️ *Como usar:*\nResponda à mensagem da capa ou do vídeo da série e digite:\n\`/envmid ID_CLIENTE\`\n\n*Exemplo:* \`/envmid 8761705656\``,
                        parse_mode: 'Markdown'
                    });
                    return res.status(200).send('OK');
                }

                try {
                    // Usa copyMessage para duplicar a mídias/legenda exatamente igual sem tarja de reencaminhado
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/copyMessage`, {
                        chat_id: targetId,
                        from_chat_id: chatId,
                        message_id: replyToMessageId
                    });

                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: chatId,
                        text: `✅ *Conteúdo enviado/copiado com sucesso para o cliente (${targetId})!*`,
                        parse_mode: 'Markdown'
                    });
                } catch (err) {
                    console.error('Erro ao copiar mensagem:', err.response?.data || err.message);
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: chatId,
                        text: `❌ *Erro ao enviar para o ID ${targetId}.*\nVerifique se o cliente já iniciou conversa com o bot.`,
                        parse_mode: 'Markdown'
                    });
                }

                return res.status(200).send('OK');
            }
        return res.status(200).send('OK');
    } catch (error) {
        console.error('Erro no webhook do Telegram:', error.response?.data || error.message);
        return res.status(500).send('Erro');
    }
};

app.post('/api/telegram-webhook', handleTelegramWebhook);
app.post('/telegram-webhook', handleTelegramWebhook);

//const PORT = process.env.PORT || 3000;
//app.listen(PORT, async () => {
   // console.log(`Servidor rodando na porta ${PORT}`);
    //if (process.env.RENDER_EXTERNAL_URL && TELEGRAM_BOT_TOKEN) {
       // const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/api/telegram-webhook`;
      //  try {
        //    await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
     //   } catch (e) {}
 //   }
//});
const PORT = process.env.PORT || 3000;

// Se estiver rodando localmente ou no Render, inicia o servidor normalmente
if (process.env.NODE_ENV !== 'production' || process.env.RENDER_EXTERNAL_URL) {
    app.listen(PORT, async () => {
        console.log(`Servidor rodando na porta ${PORT}`);
        if (process.env.RENDER_EXTERNAL_URL && TELEGRAM_BOT_TOKEN) {
            const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/api/telegram-webhook`;
            try {
                await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
            } catch (e) {}
        }
    });
}

// Exporta o app para a Vercel processar as rotas corretamente
module.exports = app;
