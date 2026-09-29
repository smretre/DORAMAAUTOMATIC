const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Caso queira separar a pasta public, ou use unificado

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const SELLER_CHAT_ID = process.env.SELLER_CHAT_ID;
const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

// Rota para Criar Preferência de Pagamento no Mercado Pago com Desconto Progressivo
app.post('/api/checkout', async (req, res) => {
    try {
        const { items, userTelegramId, userUsername } = req.body;
        
        if (!items || items.length === 0) {
            return res.status(400).json({ error: 'Carrinho vazio' });
        }

        // Lógica de Desconto Progressivo (1ª série normal, 2ª -R$1, 3ª -R$2...)
        let subtotal = items.reduce((acc, item) => acc + Number(item.preco.replace(',', '.')), 0);
        let desconto = Math.max(0, items.length - 1); 
        let totalFinal = Math.max(1, subtotal - desconto); 

        const mpResponse = await axios.post('https://api.mercadopago.com/checkout/preferences', {
            items: [
                {
                    title: `Pacote com ${items.length} Série(s) - DORAMAX`,
                    quantity: 1,
                    unit_price: Number(totalFinal.toFixed(2))
                }
            ],
            back_urls: {
                success: `https://t.me/`,
                failure: `https://t.me/`,
                pending: `https://t.me/`
            },
            auto_return: "approved",
            external_reference: JSON.stringify({ userTelegramId, userUsername, items })
        }, {
            headers: {
                'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        res.json({ init_point: mpResponse.data.init_point });
    } catch (error) {
        console.error('Erro ao gerar pagamento:', error.response?.data || error.message);
        res.status(500).json({ error: 'Erro ao processar pagamento' });
    }
});

// Webhook do Telegram para o Comando /start com Botão do Mini App
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

// Webhook do Mercado Pago (Confirmação de Pagamento)
app.post('/api/webhook', async (req, res) => {
    const event = req.body;
    try {
        if (event.type === 'payment' || event.action === 'payment.created') {
            const paymentId = event.data?.id;
            if (paymentId) {
                const paymentInfo = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                    headers: { 'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}` }
                });

                if (paymentInfo.data.status === 'approved') {
                    const metadata = JSON.parse(paymentInfo.data.external_reference || '{}');
                    const { userTelegramId, userUsername, items } = metadata;
                    const listaSeries = items.map(i => `- ${i.titulo} (R$ ${i.preco})`).join('\n');

                    // 1. Envia instruções de acesso para o CLIENTE
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: userTelegramId,
                        text: `🎉 **Pagamento Aprovado com Sucesso!**\n\nAqui estão os itens do seu pedido:\n\n${listaSeries}\n\n👉 Suas instruções de acesso e episódios foram enviados ou estão sendo liberados. Obrigado por comprar conosco!`
                    });

                    // 2. Envia notificação no PV do VENDEDOR
                    if (SELLER_CHAT_ID) {
                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                            chat_id: SELLER_CHAT_ID,
                            text: `🔔 **Nova Venda Aprovada!**\n\n👤 Cliente: @${userUsername || 'Sem username'} (ID: ${userTelegramId})\n\n📺 **Séries escolhidas:**\n${listaSeries}\n\n💰 Valor pago: R$ ${paymentInfo.data.transaction_amount}`
                        });
                    }
                }
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error('Erro no webhook MP:', error.message);
        res.status(500).send('Erro');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    
    // Configura o webhook do Telegram automaticamente no Render
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
