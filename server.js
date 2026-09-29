const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const SELLER_CHAT_ID = process.env.SELLER_CHAT_ID;
const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

// Banco de dados temporário em memória para guardar os carrinhos por ID de pagamento
const pendingOrders = {};

app.post('/api/checkout-pix', async (req, res) => {
    try {
        const { items, userTelegramId, userUsername } = req.body;
        
        if (!items || items.length === 0) {
            return res.status(400).json({ error: 'Carrinho vazio' });
        }

        // Lógica de Desconto Progressivo (1ª série normal, 2ª -R$1, 3ª -R$2...)
        let subtotal = items.reduce((acc, item) => acc + Number(item.preco.replace(',', '.')), 0);
        let desconto = Math.max(0, items.length - 1); 
        let totalFinal = Math.max(1, subtotal - desconto); 

        // Criação de uma referência curta para não estourar o limite do Mercado Pago
        const orderKey = `order_${userTelegramId}_${Date.now()}`;

        const paymentData = {
            transaction_amount: Number(totalFinal.toFixed(2)),
            description: `Pacote com ${items.length} Série(s) - DORAMAX`,
            payment_method_id: 'pix',
            payer: {
                email: `usuario_${userTelegramId}@telegram.com`,
                first_name: userUsername || 'Cliente'
            },
            external_reference: orderKey
        };

        const mpResponse = await axios.post('https://api.mercadopago.com/v1/payments', paymentData, {
            headers: {
                'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
                'X-Idempotency-Key': orderKey
            }
        });

        const paymentId = mpResponse.data.id;

        // Salva os itens na memória do servidor vinculados ao ID do pagamento
        pendingOrders[paymentId] = {
            userTelegramId,
            userUsername,
            items
        };

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
        console.error('Erro ao gerar Pix:', error.response?.data || error.message);
        res.status(500).json({ error: 'Erro ao gerar Pix no Mercado Pago' });
    }
});

app.get('/api/check-payment/:id', async (req, res) => {
    try {
        const paymentId = req.params.id;
        const paymentInfo = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { 'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}` }
        });

        const status = paymentInfo.data.status;

        if (status === 'approved') {
            const orderData = pendingOrders[paymentId];
            
            if (orderData) {
                const { userTelegramId, userUsername, items } = orderData;
                const listaSeries = items.map(i => `- ${i.titulo} (R$ ${i.preco})`).join('\n');

                // 1. Envia instruções de acesso para o CLIENTE no Telegram
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: userTelegramId,
                    text: `🎉 **Pagamento Aprovado com Sucesso!**\n\nAqui estão os itens do seu pedido:\n\n${listaSeries}\n\n👉 Suas instruções de acesso e episódios foram liberados. Obrigado por comprar conosco!`
                });

                // 2. Envia notificação no PV do VENDEDOR
                if (SELLER_CHAT_ID) {
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: SELLER_CHAT_ID,
                        text: `🔔 **Nova Venda Aprovada!**\n\n👤 Cliente: @${userUsername || 'Sem username'} (ID: ${userTelegramId})\n\n📺 **Séries escolhidas:**\n${listaSeries}\n\n💰 Valor pago: R$ ${paymentInfo.data.transaction_amount}`
                    });
                }

                // Remove da memória após aprovado
                delete pendingOrders[paymentId];
            }
        }

        res.json({ status });
    } catch (error) {
        console.error('Erro ao checar pagamento:', error.message);
        res.status(500).json({ error: 'Erro ao verificar status' });
    }
});

app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const update = req.body;
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            const firstName = update.message.from.first_name || 'Cliente';

            if (text.startsWith('/start')) {
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId,
                    text: `Olá ${firstName} 👋! Seja muito bem-vindo(a) ao nosso app.\n\n👇 Toque no botão abaixo para abrir o catálogo e aproveitar nossos lançamentos!`,
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: "🎬 APP-DORAMAX",
                                    web_app: { url: APP_URL }
                                }
                            ]
                        ]
                    }
                });
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error('Erro no webhook do Telegram:', error.message);
        res.status(500).send('Erro');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    
    if (process.env.RENDER_EXTERNAL_URL && TELEGRAM_BOT_TOKEN) {
        const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/api/telegram-webhook`;
        try {
            await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
            console.log(`Webhook do Telegram configurado: ${webhookUrl}`);
        } catch (e) {
            console.error('Falha ao configurar webhook Telegram:', e.message);
        }
    }
});
