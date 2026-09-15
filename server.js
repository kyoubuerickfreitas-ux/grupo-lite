const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ---- Configuração simples do "servidor" (grupo) ----
const TEXT_CHANNELS = ['geral', 'random', 'avisos'];
const VOICE_ROOM = 'voz-principal';
const MAX_HISTORY = 100;

// Histórico de mensagens em memória por canal
const history = {};
TEXT_CHANNELS.forEach((c) => (history[c] = []));

// Usuários conectados: socket.id -> { name, color, inVoice, sharingScreen }
const users = {};

function publicUser(id) {
  const u = users[id];
  if (!u) return null;
  return { id, name: u.name, color: u.color, inVoice: u.inVoice, sharingScreen: u.sharingScreen };
}

function broadcastUserList() {
  io.emit('user-list', Object.keys(users).map((id) => publicUser(id)));
}

function randomColor() {
  const colors = ['#f38ba8', '#a6e3a1', '#89b4fa', '#f9e2af', '#cba6f7', '#94e2d5', '#fab387'];
  return colors[Math.floor(Math.random() * colors.length)];
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.send('ok'));

io.on('connection', (socket) => {
  socket.on('join', (rawName, ack) => {
    const name = String(rawName || 'Convidado').trim().slice(0, 24) || 'Convidado';
    users[socket.id] = { name, color: randomColor(), inVoice: false, sharingScreen: false };

    if (typeof ack === 'function') {
      ack({
        channels: TEXT_CHANNELS,
        history,
        users: Object.keys(users).map((id) => publicUser(id)),
        voiceMembers: Object.keys(users).filter((id) => users[id].inVoice),
        you: publicUser(socket.id),
      });
    }

    TEXT_CHANNELS.forEach((c) => socket.join(`text:${c}`));

    const sysMsg = { system: true, text: `${name} entrou no grupo.`, ts: Date.now() };
    history['geral'].push(sysMsg);
    socket.to('text:geral').emit('chat-message', { channel: 'geral', message: sysMsg });

    broadcastUserList();
  });

  socket.on('chat-message', ({ channel, text }) => {
    const user = users[socket.id];
    if (!user || !TEXT_CHANNELS.includes(channel)) return;
    const clean = String(text || '').slice(0, 2000).trim();
    if (!clean) return;
    const message = {
      id: `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId: socket.id,
      name: user.name,
      color: user.color,
      text: clean,
      ts: Date.now(),
    };
    const list = history[channel];
    list.push(message);
    if (list.length > MAX_HISTORY) list.shift();
    io.to(`text:${channel}`).emit('chat-message', { channel, message });
  });

  // ---- Sala de voz / tela ----
  socket.on('voice-join', () => {
    const user = users[socket.id];
    if (!user || user.inVoice) return;
    user.inVoice = true;
    socket.join(VOICE_ROOM);

    // Avisa os outros membros já na sala pra iniciarem a conexão com o novo
    const existing = Object.keys(users).filter((id) => id !== socket.id && users[id].inVoice);
    socket.emit('voice-peers', existing.map((id) => publicUser(id)));
    socket.to(VOICE_ROOM).emit('voice-peer-joined', publicUser(socket.id));

    broadcastUserList();
  });

  socket.on('voice-leave', () => {
    const user = users[socket.id];
    if (!user || !user.inVoice) return;
    user.inVoice = false;
    user.sharingScreen = false;
    socket.leave(VOICE_ROOM);
    socket.to(VOICE_ROOM).emit('voice-peer-left', socket.id);
    broadcastUserList();
  });

  socket.on('screen-share-start', () => {
    const user = users[socket.id];
    if (!user) return;
    user.sharingScreen = true;
    socket.to(VOICE_ROOM).emit('peer-screen-share-start', socket.id);
    broadcastUserList();
  });

  socket.on('screen-share-stop', () => {
    const user = users[socket.id];
    if (!user) return;
    user.sharingScreen = false;
    socket.to(VOICE_ROOM).emit('peer-screen-share-stop', socket.id);
    broadcastUserList();
  });

  // Relay genérico de sinalização WebRTC (offer/answer/ice), sempre direcionado
  ['webrtc-offer', 'webrtc-answer', 'webrtc-ice-candidate'].forEach((evt) => {
    socket.on(evt, (payload) => {
      const { to } = payload || {};
      if (!to || !users[to]) return;
      io.to(to).emit(evt, { ...payload, from: socket.id });
    });
  });

  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (!user) return;
    delete users[socket.id];
    socket.to(VOICE_ROOM).emit('voice-peer-left', socket.id);
    const sysMsg = { system: true, text: `${user.name} saiu do grupo.`, ts: Date.now() };
    history['geral'].push(sysMsg);
    io.to('text:geral').emit('chat-message', { channel: 'geral', message: sysMsg });
    broadcastUserList();
  });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
