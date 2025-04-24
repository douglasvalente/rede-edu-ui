// File: server.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const express            = require('express');
const cors               = require('cors');
const qrcode             = require('qrcode-terminal');
const axios              = require('axios');
const fs                 = require('fs-extra');
const path               = require('path');
const FormData           = require('form-data');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let currentPrompt = null;
let currentAgent  = null;
let currentDelay  = 0;
let pausedChats   = new Set();
let isReady       = false;
let botEnabled    = true;

const CONFIG_PATH = path.join(__dirname, 'config.json');

const client = new Client({ authStrategy: new LocalAuth() });

client.on('qr', qr => {
  console.log('📱 QR recebido, escaneie no WhatsApp Mobile:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  isReady = true;
  console.log('✅ Cliente WhatsApp pronto!');
  const PORT = 3000;
  app.listen(PORT, () => console.log(`API Node ouvindo em http://localhost:${PORT}`));
});

client.initialize();

// Carrega config anterior
(async () => {
  try {
    const cfg = await fs.readJson(CONFIG_PATH);
    currentPrompt = cfg.prompt;
    currentAgent  = cfg.agentName;
    currentDelay  = cfg.delay;
    console.log('🎛️ Config carregada do disco:', cfg);
  } catch {
    console.log('⚙️ Nenhuma config prévia encontrada.');
  }
})();

const chatHistory = new Map();

client.on('message', async msg => {
  const chatId = msg.from;

  // ── AQUI: se for áudio (nota de voz, type 'ptt'), faça transcrição
  if (msg.hasMedia && msg.type === 'ptt') {
    try {
      const media = await msg.downloadMedia();
      if (media.mimetype.startsWith('audio/')) {
        const buffer = Buffer.from(media.data, 'base64');
        const form   = new FormData();
        form.append('audio', buffer, {
          filename: 'voice.ogg',
          contentType: media.mimetype
        });

        const resp = await axios.post(
          'http://127.0.0.1:5000/transcribe',
          form,
          { headers: form.getHeaders() }
        );
        console.log('🔊 Transcrição:', resp.data.text);
        msg.body = resp.data.text;            // ← substitui por texto
      }
    } catch (e) {
      console.error('❌ Falha na transcrição:', e.message);
      // opcional: notificar usuário
      await client.sendMessage(chatId, '❌ Não consegui transcrever seu áudio.');
      return;                                // ← interrompe pipeline
    }
  }

  // ── resto da pipeline
  if (!botEnabled) return;
  if (msg.isGroupMsg || chatId.endsWith('@g.us')) return;
  if (pausedChats.has(chatId)) return;

  let history = chatHistory.get(chatId) || [];
  history.push({ role: 'user', content: msg.body });

  try {
    const payload = {
      prompt:       currentPrompt,
      agentName:    currentAgent,
      message:      msg.body,
      conversation: history
    };
    const chatResp = await axios.post('http://127.0.0.1:5000/chat', payload);
    const answer   = chatResp.data.response;

    const MAX = 20;
    if (history.length > MAX * 2) history.splice(0, history.length - MAX * 2);
    history.push({ role: 'assistant', content: answer });
    chatHistory.set(chatId, history);

    if (currentDelay > 0) await new Promise(r => setTimeout(r, currentDelay));
    const chat = await msg.getChat();
    await chat.sendStateTyping();
    await chat.clearState();

    await client.sendMessage(chatId, answer);
  } catch (err) {
    console.error('Erro ao chamar /chat:', err.message);
    await client.sendMessage(chatId, '❌ Desculpe, ocorreu um erro ao processar sua mensagem.');
  }
});

// ── Endpoints HTTP ────────────────────────────────────
app.get('/chats', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'Client inicializando...' });

  try {
    const list = await client.getChats();
    return res.json(list.map(c => ({
      id:   c.id._serialized,
      name: c.name || c.formattedTitle
    })));
  } catch (e) {
    console.error('Erro em getChats():', e);
    return res.status(500).json({ error: 'Falha ao recuperar chats.' });
  }
});

app.get('/status', (req, res) => res.json({ connected: isReady }));
app.get('/enabled', (req, res) => res.json({ enabled: botEnabled }));

app.post('/enable',  (req, res) => { botEnabled = true;  console.log('🔛 Bot ativado');  res.json({ enabled: botEnabled }); });
app.post('/disable', (req, res) => { botEnabled = false; console.log('⏸️ Bot desativado'); res.json({ enabled: botEnabled }); });

app.get('/config', (req, res) => res.json({
  prompt:    currentPrompt,
  agentName: currentAgent,
  delay:     currentDelay
}));

app.post('/config', async (req, res) => {
  const { prompt, agentName, delay } = req.body;
  if (!prompt || !agentName) return res.status(400).json({ error: 'Prompt e Nome do Agente são obrigatórios.' });

  currentPrompt = prompt;
  currentAgent  = agentName;
  currentDelay  = Number(delay) || 0;
  console.log('➡️ Config atualizada:', { currentPrompt, currentAgent, currentDelay });

  try {
    await fs.writeJson(CONFIG_PATH, { prompt, agentName, delay }, { spaces: 2 });
    console.log('💾 Config salva em', CONFIG_PATH);
  } catch (e) {
    console.warn('⚠️ Falha ao salvar config:', e);
  }
  res.json({ status: 'ok' });
});

app.post('/pause',  (req, res) => { pausedChats.add(req.body.chatId);   axios.post('http://127.0.0.1:5000/pause',{chatId:req.body.chatId}).catch(()=>{});   res.json({status:'paused'}); });
app.post('/resume', (req, res) => { pausedChats.delete(req.body.chatId); axios.post('http://127.0.0.1:5000/resume',{chatId:req.body.chatId}).catch(()=>{}); res.json({status:'resumed'}); });
