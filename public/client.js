(() => {
  const socket = io();
  let hasConnectedBefore = false;
  socket.on('connect', () => {
    if (hasConnectedBefore) {
      playConnectionRestoredSound();
    }
    hasConnectedBefore = true;
  });
  socket.on('disconnect', () => {
    playConnectionLostSound();
  });

  // ---- Estado ----
  let me = null;
  let currentChannel = 'geral';
  let channelHistory = {};
  let usersById = {};
  let inVoice = false;
  let micEnabled = true;
  let deafened = false; // true = não estamos ouvindo os outros participantes (tipo "Ensurdecer" do Discord)
  let rawAudioStream = null; // stream crua do microfone (a que precisa de .stop() pra liberar o hardware)
  let localAudioStream = null; // stream que de fato vai pro WebRTC (crua ou já filtrada pelo supressor de IA)
  let noiseCleanup = null; // função pra desligar os nós de áudio do supressor de IA
  let screenStream = null;
  let maximizedTileId = null;
  const micSettings = {
    noiseSuppression: true, // liga/desliga o supressor de ruído com IA (RNNoise)
    echoCancellation: true,
    autoGainControl: true,
  };
  const peers = {}; // peerId -> { pc, polite, makingOffer, ignoreOffer, micSender }

  function dlog(...args) {
    console.log(...args);
  }

  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // ---- Elementos ----
  const loginScreen = document.getElementById('login-screen');
  const appEl = document.getElementById('app');
  const nameInput = document.getElementById('name-input');
  const joinBtn = document.getElementById('join-btn');
  const loginError = document.getElementById('login-error');

  const channelListEl = document.getElementById('channel-list');
  const currentChannelLabel = document.getElementById('current-channel-label');
  const messagesEl = document.getElementById('messages');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');

  const voiceJoinBtn = document.getElementById('voice-join-btn');
  const voiceInCall = document.getElementById('voice-in-call');
  const micToggleBtn = document.getElementById('mic-toggle-btn');
  const deafenToggleBtn = document.getElementById('deafen-toggle-btn');
  const micSettingsBtn = document.getElementById('mic-settings-btn');
  const micSettingsPanel = document.getElementById('mic-settings-panel');
  const optNoiseSuppression = document.getElementById('opt-noise-suppression');
  const optEchoCancellation = document.getElementById('opt-echo-cancellation');
  const optAutoGain = document.getElementById('opt-auto-gain');
  const screenShareBtn = document.getElementById('screen-share-btn');
  const voiceLeaveBtn = document.getElementById('voice-leave-btn');
  const voiceMemberListEl = document.getElementById('voice-member-list');

  const memberListEl = document.getElementById('member-list');
  const memberCountEl = document.getElementById('member-count');
  const myUserEl = document.getElementById('my-user');
  const screenShareArea = document.getElementById('screen-share-area');

  // ---- Login ----
  function doJoin() {
    const name = nameInput.value.trim();
    if (!name) {
      loginError.textContent = 'Digite um nome pra continuar.';
      return;
    }
    joinBtn.disabled = true;
    socket.emit('join', name, (data) => {
      joinBtn.disabled = false;
      me = data.you;
      channelHistory = data.history;
      usersById = {};
      data.users.forEach((u) => (usersById[u.id] = u));

      renderChannelList(data.channels);
      renderMembers();
      renderMessages();
      myUserEl.textContent = `Conectado como ${me.name}`;

      loginScreen.classList.add('hidden');
      appEl.classList.remove('hidden');
    });
  }

  joinBtn.addEventListener('click', doJoin);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });

  // ---- Canais de texto ----
  function renderChannelList(channels) {
    channelListEl.innerHTML = '';
    channels.forEach((c) => {
      const li = document.createElement('li');
      li.textContent = c;
      li.dataset.channel = c;
      if (c === currentChannel) li.classList.add('active');
      li.addEventListener('click', () => switchChannel(c));
      channelListEl.appendChild(li);
    });
  }

  function switchChannel(c) {
    currentChannel = c;
    currentChannelLabel.textContent = `#${c}`;
    [...channelListEl.children].forEach((li) =>
      li.classList.toggle('active', li.dataset.channel === c)
    );
    renderMessages();
  }

  function renderMessages() {
    messagesEl.innerHTML = '';
    (channelHistory[currentChannel] || []).forEach(renderMessage);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderMessage(message) {
    const div = document.createElement('div');
    if (message.system) {
      div.className = 'msg system';
      div.textContent = message.text;
    } else {
      div.className = 'msg';
      const time = new Date(message.ts).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      div.innerHTML = `<span class="name" style="color:${message.color}">${escapeHtml(
        message.name
      )}</span><span>${escapeHtml(message.text)}</span><span class="time">${time}</span>`;
    }
    messagesEl.appendChild(div);
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  socket.on('chat-message', ({ channel, message }) => {
    if (!channelHistory[channel]) channelHistory[channel] = [];
    channelHistory[channel].push(message);
    if (channel === currentChannel) {
      renderMessage(message);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chat-message', { channel: currentChannel, text });
    chatInput.value = '';
  });

  // ---- Lista de usuários ----
  socket.on('user-list', (list) => {
    usersById = {};
    list.forEach((u) => (usersById[u.id] = u));
    renderMembers();
    renderVoiceMembers();
  });

  function renderMembers() {
    memberListEl.innerHTML = '';
    const list = Object.values(usersById);
    memberCountEl.textContent = list.length;
    list.forEach((u) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="dot"></span><span style="color:${u.color}">${escapeHtml(
        u.name
      )}</span>`;
      if (u.inVoice) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = u.sharingScreen ? '🖥️ na voz' : '🎙️ na voz';
        li.appendChild(tag);
      }
      memberListEl.appendChild(li);
    });
  }

  function renderVoiceMembers() {
    voiceMemberListEl.innerHTML = '';
    Object.values(usersById)
      .filter((u) => u.inVoice)
      .forEach((u) => {
        const li = document.createElement('li');
        li.textContent = `🎙️ ${u.name}${u.sharingScreen ? ' (compartilhando tela)' : ''}`;
        voiceMemberListEl.appendChild(li);
      });
  }

  // ---- Sons de notificação (mic on/off, entrada/saída na voz) ----
  let uiAudioCtx = null;
  function getUiAudioCtx() {
    if (!uiAudioCtx || uiAudioCtx.state === 'closed') {
      uiAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (uiAudioCtx.state === 'suspended') uiAudioCtx.resume().catch(() => {});
    return uiAudioCtx;
  }

  // Toca um bipe curto (tom que sobe ou desce de frequência), gerado na hora
  // via Web Audio API — não depende de nenhum arquivo de áudio externo.
  function playTone(freqStart, freqEnd, duration = 0.15, volume = 0.18) {
    try {
      const ctx = getUiAudioCtx();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freqStart, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), now + duration);
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    } catch (err) {
      dlog('[Sons] não foi possível tocar o bipe', err);
    }
  }

  function playMicOnSound() {
    playTone(480, 880, 0.13);
  }

  function playMicOffSound() {
    playTone(760, 320, 0.16);
  }

  function playDeafenOnSound() {
    playTone(420, 160, 0.22, 0.16);
  }

  function playDeafenOffSound() {
    playTone(300, 620, 0.18, 0.16);
  }

  function playConnectionLostSound() {
    playTone(520, 90, 0.35, 0.2);
  }

  function playConnectionRestoredSound() {
    playTone(220, 700, 0.22, 0.16);
  }

  // Anuncia entrada/saída da voz falando em voz alta (Web Speech API),
  // preferindo a voz feminina do Google em pt-BR quando o navegador tiver
  // esse voice disponível. Se não tiver, cai pra qualquer voz em português e,
  // no limite, pro voice padrão — nunca trava nem quebra nada, só não fala se
  // a API não existir no navegador.
  let ptBrVoicesPromise = null;
  function loadVoices() {
    if (!ptBrVoicesPromise) {
      ptBrVoicesPromise = new Promise((resolve) => {
        const existing = speechSynthesis.getVoices();
        if (existing.length) {
          resolve(existing);
          return;
        }
        const onVoicesChanged = () => {
          speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
          resolve(speechSynthesis.getVoices());
        };
        speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
        setTimeout(() => resolve(speechSynthesis.getVoices()), 1000);
      });
    }
    return ptBrVoicesPromise;
  }

  // Nomes que costumam indicar uma voz feminina nos voices que os navegadores
  // expõem (Google, Microsoft etc.), usado como critério de desempate quando
  // não tem a voz do Google disponível (ex: fora do Chrome).
  const FEMALE_VOICE_NAME = /female|mulher|maria|luciana|camila|fernanda|helena|vit[oó]ria|raquel|yara|francisca|ana|leila/i;

  async function pickAnnounceVoice() {
    const voices = await loadVoices();
    return (
      voices.find((v) => v.lang === 'pt-BR' && /google/i.test(v.name)) ||
      voices.find((v) => /^pt/i.test(v.lang) && /google/i.test(v.name)) ||
      voices.find((v) => v.lang === 'pt-BR' && FEMALE_VOICE_NAME.test(v.name)) ||
      voices.find((v) => /^pt/i.test(v.lang) && FEMALE_VOICE_NAME.test(v.name)) ||
      voices.find((v) => v.lang === 'pt-BR') ||
      voices.find((v) => /^pt/i.test(v.lang)) ||
      null
    );
  }

  async function announceVoiceEvent(name, action) {
    try {
      if (!('speechSynthesis' in window)) return;
      const text = action === 'joined' ? `${name} entrou na resenha` : `${name} saiu da resenha`;
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'pt-BR';
      utter.rate = 1;
      utter.volume = 1;
      const voice = await pickAnnounceVoice();
      if (voice) utter.voice = voice;
      speechSynthesis.speak(utter);
    } catch (err) {
      dlog('[Sons] não foi possível anunciar', err);
    }
  }

  // ---- Supressor de ruído com IA (RNNoise, código aberto) ----
  // Usa o pacote @sapphi-red/web-noise-suppressor (MIT), que empacota o RNNoise
  // (xiph/rnnoise) como um AudioWorklet + WASM. É o mesmo tipo de modelo usado
  // por projetos como o Jitsi Meet pra supressão de ruído "tipo Krisp" sem
  // depender de conta/licença comercial. Carregado sob demanda via CDN
  // (jsdelivr) pra não precisar versionar binários grandes no repositório.
  const RNNOISE_BASE = 'https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.4.1/dist';
  let rnnoiseModulePromise = null;
  let rnnoiseWasmPromise = null;
  let noiseAudioCtx = null;
  let rnnoiseWorkletReady = false;

  function loadRnnoiseModule() {
    if (!rnnoiseModulePromise) {
      rnnoiseModulePromise = import(RNNOISE_BASE + '/index.js');
    }
    return rnnoiseModulePromise;
  }

  function getRnnoiseWasmBinary(loadRnnoise) {
    if (!rnnoiseWasmPromise) {
      rnnoiseWasmPromise = loadRnnoise({
        url: RNNOISE_BASE + '/rnnoise.wasm',
        simdUrl: RNNOISE_BASE + '/rnnoise_simd.wasm',
      });
    }
    return rnnoiseWasmPromise;
  }

  // Recebe a stream crua do microfone e devolve `{ stream, cleanup }` já com o
  // filtro de ruído aplicado. Se qualquer etapa falhar (sem internet, CDN
  // bloqueado, navegador sem AudioWorklet etc.) devolve `null` e quem chamou
  // simplesmente usa a stream original — nunca trava a chamada de voz por causa disso.
  async function applyAiNoiseSuppression(rawStream) {
    try {
      const { RnnoiseWorkletNode, loadRnnoise } = await loadRnnoiseModule();
      const wasmBinary = await getRnnoiseWasmBinary(loadRnnoise);

      if (!noiseAudioCtx || noiseAudioCtx.state === 'closed') {
        noiseAudioCtx = new AudioContext({ sampleRate: 48000 }); // o RNNoise espera 48kHz
        rnnoiseWorkletReady = false;
      }
      if (noiseAudioCtx.state === 'suspended') await noiseAudioCtx.resume();
      if (!rnnoiseWorkletReady) {
        await noiseAudioCtx.audioWorklet.addModule(RNNOISE_BASE + '/rnnoise/workletProcessor.js');
        rnnoiseWorkletReady = true;
      }

      const source = noiseAudioCtx.createMediaStreamSource(rawStream);
      const rnnoiseNode = new RnnoiseWorkletNode(noiseAudioCtx, { wasmBinary, maxChannels: 1 });
      const destination = noiseAudioCtx.createMediaStreamDestination();
      source.connect(rnnoiseNode).connect(destination);

      return {
        stream: destination.stream,
        cleanup: () => {
          try {
            source.disconnect();
            rnnoiseNode.disconnect();
            rnnoiseNode.destroy();
          } catch (err) {
            dlog('[NoiseAI] erro ao limpar nós de áudio', err);
          }
        },
      };
    } catch (err) {
      console.error(
        '[NoiseAI] não foi possível carregar o supressor de ruído com IA (RNNoise); usando o áudio sem esse filtro',
        err
      );
      return null;
    }
  }

  // Monta a stream que de fato vai pro WebRTC a partir da stream crua do
  // microfone, aplicando (ou não) o supressor de IA conforme micSettings.
  async function setupOutgoingAudio(rawStream) {
    if (noiseCleanup) {
      noiseCleanup();
      noiseCleanup = null;
    }
    let stream = rawStream;
    if (micSettings.noiseSuppression) {
      const result = await applyAiNoiseSuppression(rawStream);
      if (result) {
        stream = result.stream;
        noiseCleanup = result.cleanup;
      }
    }
    localAudioStream = stream;
    localAudioStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
    return stream;
  }

  // Reconstrói a stream de saída em tempo real (ex: ligou/desligou o supressor
  // de IA no meio de uma chamada) e troca a faixa de áudio em cada peer
  // connection sem precisar renegociar a conexão (RTCRtpSender.replaceTrack).
  async function rebuildOutgoingAudio() {
    if (!rawAudioStream) return;
    await setupOutgoingAudio(rawAudioStream);
    const newTrack = localAudioStream.getAudioTracks()[0];
    Object.values(peers).forEach(({ micSender }) => {
      if (micSender) {
        micSender.replaceTrack(newTrack).catch((err) => {
          dlog('[NoiseAI] falha ao trocar o áudio em tempo real', err);
        });
      }
    });
  }

  // ---- Voz / WebRTC ----
  function updateVoiceUI() {
    voiceJoinBtn.classList.toggle('hidden', inVoice);
    voiceInCall.classList.toggle('hidden', !inVoice);
  }

  function getOrCreatePeer(peerId) {
    if (peers[peerId]) return peers[peerId];
    dlog('[RTC] criando peer connection para', peerId);
    const polite = socket.id < peerId;
    const pc = new RTCPeerConnection(ICE_CONFIG);
    const entry = { pc, polite, makingOffer: false, ignoreOffer: false, micSender: null };
    peers[peerId] = entry;

    pc.onnegotiationneeded = async () => {
      dlog('[RTC] negotiationneeded ->', peerId);
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        dlog('[RTC] enviando offer ->', peerId);
        socket.emit('webrtc-offer', { to: peerId, sdp: pc.localDescription });
      } catch (err) {
        console.error('Erro de negociação WebRTC', err);
      } finally {
        entry.makingOffer = false;
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('webrtc-ice-candidate', { to: peerId, candidate: e.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      dlog('[RTC] connectionState', peerId, '=', pc.connectionState);
    };
    pc.oniceconnectionstatechange = () => {
      dlog('[RTC] iceConnectionState', peerId, '=', pc.iceConnectionState);
    };

    pc.ontrack = (e) => {
      dlog('[RTC] track recebido de', peerId, e.track.kind);
      handleRemoteTrack(peerId, e);
    };

    if (localAudioStream) {
      localAudioStream.getTracks().forEach((t) => {
        const sender = pc.addTrack(t, localAudioStream);
        if (t.kind === 'audio') entry.micSender = sender;
      });
    }
    if (screenStream) {
      screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));
    }

    return entry;
  }

  function cleanupPeer(peerId) {
    const entry = peers[peerId];
    if (entry) {
      entry.pc.close();
      delete peers[peerId];
    }
    removeScreenTile(peerId);
    const audioEl = document.getElementById('audio-' + peerId);
    if (audioEl) audioEl.remove();
  }

  async function joinVoice() {
    let rawStream;
    try {
      rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: micSettings.echoCancellation,
          autoGainControl: micSettings.autoGainControl,
          // A supressão de ruído "de verdade" é feita pelo RNNoise logo abaixo;
          // desligamos a nativa do navegador pra não processar o áudio 2x.
          noiseSuppression: false,
        },
      });
    } catch (err) {
      alert('Não foi possível acessar o microfone: ' + err.message);
      return;
    }

    rawAudioStream = rawStream;
    inVoice = true;
    micEnabled = true;
    await setupOutgoingAudio(rawStream);
    micToggleBtn.textContent = '🎙️ Mudo';
    micToggleBtn.classList.remove('muted');
    socket.emit('voice-join');
    if (me && me.name) announceVoiceEvent(me.name, 'joined');
    updateVoiceUI();
  }

  // ---- Configurações do microfone (supressor de ruído, eco, ganho) ----
  function applyMicSettingsLive() {
    if (!rawAudioStream) return;
    rawAudioStream.getAudioTracks().forEach((t) => {
      t.applyConstraints({
        echoCancellation: micSettings.echoCancellation,
        autoGainControl: micSettings.autoGainControl,
      }).catch((err) => {
        dlog('[Mic] não foi possível aplicar em tempo real, valerá na próxima vez que entrar na voz', err);
      });
    });
  }

  micSettingsBtn.addEventListener('click', () => {
    const opening = micSettingsPanel.classList.contains('hidden');
    micSettingsPanel.classList.toggle('hidden', !opening);
    micSettingsBtn.classList.toggle('active', opening);
  });

  document.addEventListener('click', (e) => {
    if (
      !micSettingsPanel.classList.contains('hidden') &&
      !micSettingsPanel.contains(e.target) &&
      e.target !== micSettingsBtn
    ) {
      micSettingsPanel.classList.add('hidden');
      micSettingsBtn.classList.remove('active');
    }
  });

  optNoiseSuppression.addEventListener('change', () => {
    micSettings.noiseSuppression = optNoiseSuppression.checked;
    if (inVoice) rebuildOutgoingAudio();
  });

  [
    [optEchoCancellation, 'echoCancellation'],
    [optAutoGain, 'autoGainControl'],
  ].forEach(([el, key]) => {
    el.addEventListener('change', () => {
      micSettings[key] = el.checked;
      applyMicSettingsLive();
    });
  });

  function leaveVoice() {
    if (inVoice && me && me.name) announceVoiceEvent(me.name, 'left');
    socket.emit('voice-leave');
    Object.keys(peers).forEach(cleanupPeer);
    if (noiseCleanup) {
      noiseCleanup();
      noiseCleanup = null;
    }
    if (rawAudioStream) {
      rawAudioStream.getTracks().forEach((t) => t.stop());
      rawAudioStream = null;
    }
    localAudioStream = null;
    if (screenStream) stopScreenShare();
    if (deafened) {
      deafened = false;
      deafenToggleBtn.textContent = '🎧 Ensurdecer';
      deafenToggleBtn.classList.remove('deafened');
      deafenToggleBtn.title = 'Ensurdecer (não ouvir os outros participantes)';
    }
    inVoice = false;
    updateVoiceUI();
  }

  function setMicEnabled(next) {
    if (!localAudioStream || micEnabled === next) return;
    micEnabled = next;
    localAudioStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
    micToggleBtn.textContent = micEnabled ? '🎙️ Mudo' : '🔇 Sem áudio';
    micToggleBtn.classList.toggle('muted', !micEnabled);
  }

  function toggleMic() {
    if (!localAudioStream) return;
    setMicEnabled(!micEnabled);
    if (micEnabled) playMicOnSound();
    else playMicOffSound();
  }

  // Ensurdecer: para de ouvir todo mundo na chamada, igual ao "Deafen" do
  // Discord. Também desliga o microfone junto — não faz muito sentido
  // continuar falando sem conseguir ouvir as respostas — mas ao reativar o
  // áudio o microfone continua desligado até a pessoa ligar de novo na mão,
  // do mesmo jeito que o Discord faz.
  function toggleDeafen() {
    deafened = !deafened;
    document.querySelectorAll('audio[id^="audio-"]').forEach((audioEl) => {
      audioEl.muted = deafened;
    });
    deafenToggleBtn.textContent = deafened ? '🔇 Reativar áudio' : '🎧 Ensurdecer';
    deafenToggleBtn.classList.toggle('deafened', deafened);
    deafenToggleBtn.title = deafened
      ? 'Reativar o áudio dos outros participantes'
      : 'Ensurdecer (não ouvir os outros participantes)';
    if (deafened) {
      setMicEnabled(false);
      playDeafenOnSound();
    } else {
      playDeafenOffSound();
    }
  }

  async function startScreenShare() {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true, // se o navegador permitir, captura também o áudio do sistema/aba compartilhada
      });
    } catch (err) {
      return; // usuário cancelou
    }
    const track = screenStream.getVideoTracks()[0];
    track.onended = () => stopScreenShare();
    Object.values(peers).forEach(({ pc }) => {
      screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));
    });
    socket.emit('screen-share-start');
    showScreenTile('me', screenStream, `${me.name} (você)`);
    screenShareBtn.textContent = '🛑 Parar compartilhamento';
    screenShareBtn.classList.add('active');
  }

  function stopScreenShare() {
    if (!screenStream) return;
    // Captura as faixas (vídeo + áudio do sistema, se houver) antes de zerar screenStream,
    // pra remover exatamente essas do peer connection sem mexer no áudio do microfone.
    const screenTracks = screenStream.getTracks();
    Object.values(peers).forEach(({ pc }) => {
      pc.getSenders()
        .filter((s) => s.track && screenTracks.includes(s.track))
        .forEach((s) => pc.removeTrack(s));
    });
    screenTracks.forEach((t) => t.stop());
    screenStream = null;
    socket.emit('screen-share-stop');
    removeScreenTile('me');
    screenShareBtn.textContent = '🖥️ Compartilhar tela';
    screenShareBtn.classList.remove('active');
  }

  function handleRemoteTrack(peerId, event) {
    const track = event.track;
    const stream = event.streams[0];
    // Uma stream com faixa de vídeo é a stream de compartilhamento de tela;
    // o áudio do sistema (quando existir) viaja junto nessa mesma stream e é
    // reproduzido automaticamente pelo próprio <video> do tile — não duplicamos
    // em um <audio> separado (isso causaria eco). Já o áudio do microfone vem
    // numa stream só de áudio e usa o <audio> genérico de sempre.
    const isScreenStream = stream ? stream.getVideoTracks().length > 0 : track.kind === 'video';

    if (track.kind === 'video') {
      const name = usersById[peerId] ? usersById[peerId].name : 'Alguém';
      showScreenTile(peerId, stream, name);
      track.onended = () => removeScreenTile(peerId);
    } else if (track.kind === 'audio') {
      if (isScreenStream) {
        dlog('[RTC] áudio do compartilhamento de tela recebido de', peerId);
        return;
      }
      let audioEl = document.getElementById('audio-' + peerId);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = 'audio-' + peerId;
        audioEl.autoplay = true;
        audioEl.muted = deafened;
        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = stream;
    }
  }

  function showScreenTile(id, stream, label) {
    let tile = document.getElementById('tile-' + id);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'screen-tile';
      tile.id = 'tile-' + id;

      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = id === 'me'; // evita eco da própria tela compartilhada

      const labelEl = document.createElement('div');
      labelEl.className = 'label';

      const controls = document.createElement('div');
      controls.className = 'tile-controls';

      // Botão de áudio do compartilhamento (só faz sentido pra tela de outra pessoa)
      if (id !== 'me') {
        const audioBtn = document.createElement('button');
        audioBtn.className = 'tile-btn tile-audio-btn';
        audioBtn.title = 'Silenciar áudio do compartilhamento';
        audioBtn.textContent = '🔊';
        audioBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          video.muted = !video.muted;
          audioBtn.textContent = video.muted ? '🔇' : '🔊';
          audioBtn.title = video.muted
            ? 'Ativar áudio do compartilhamento'
            : 'Silenciar áudio do compartilhamento';
        });
        controls.appendChild(audioBtn);
      }

      const maxBtn = document.createElement('button');
      maxBtn.className = 'tile-btn tile-max-btn';
      maxBtn.title = 'Maximizar';
      maxBtn.textContent = '⛶';
      maxBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMaximizeTile(id);
      });
      controls.appendChild(maxBtn);

      video.addEventListener('dblclick', () => toggleMaximizeTile(id));

      tile.appendChild(video);
      tile.appendChild(labelEl);
      tile.appendChild(controls);
      screenShareArea.appendChild(tile);
    }
    tile.querySelector('video').srcObject = stream;
    tile.querySelector('.label').textContent = label;
    screenShareArea.classList.remove('hidden');
  }

  function removeScreenTile(id) {
    const tile = document.getElementById('tile-' + id);
    if (tile) tile.remove();
    if (maximizedTileId === id) exitMaximizeTile();
    if (!screenShareArea.children.length) screenShareArea.classList.add('hidden');
  }

  // ---- Maximizar / minimizar tela compartilhada ----
  function toggleMaximizeTile(id) {
    if (maximizedTileId === id) {
      exitMaximizeTile();
      return;
    }
    if (maximizedTileId) exitMaximizeTile();

    const tile = document.getElementById('tile-' + id);
    if (!tile) return;
    maximizedTileId = id;
    tile.classList.add('maximized');
    const btn = tile.querySelector('.tile-max-btn');
    if (btn) {
      btn.textContent = '🗗';
      btn.title = 'Minimizar';
    }
    document.addEventListener('keydown', onMaximizeKeydown);
  }

  function exitMaximizeTile() {
    if (!maximizedTileId) return;
    const tile = document.getElementById('tile-' + maximizedTileId);
    if (tile) {
      tile.classList.remove('maximized');
      const btn = tile.querySelector('.tile-max-btn');
      if (btn) {
        btn.textContent = '⛶';
        btn.title = 'Maximizar';
      }
    }
    maximizedTileId = null;
    document.removeEventListener('keydown', onMaximizeKeydown);
  }

  function onMaximizeKeydown(e) {
    if (e.key === 'Escape') exitMaximizeTile();
  }

  socket.on('voice-peers', (existingPeers) => {
    existingPeers.forEach((p) => getOrCreatePeer(p.id));
  });

  socket.on('voice-peer-joined', (user) => {
    if (user && user.id) {
      getOrCreatePeer(user.id);
      if (inVoice && user.id !== socket.id) {
        const name = user.name || (usersById[user.id] && usersById[user.id].name) || 'Alguém';
        announceVoiceEvent(name, 'joined');
      }
    }
  });

  socket.on('voice-peer-left', (peerId) => {
    if (inVoice && peerId !== socket.id) {
      const name = (usersById[peerId] && usersById[peerId].name) || 'Alguém';
      announceVoiceEvent(name, 'left');
    }
    cleanupPeer(peerId);
  });

  socket.on('peer-screen-share-stop', (peerId) => {
    removeScreenTile(peerId);
  });

  // ---- Sinalização WebRTC recebida (offer/answer/ICE) ----
  socket.on('webrtc-offer', async ({ from, sdp }) => {
    dlog('[RTC] offer recebida de', from);
    const entry = getOrCreatePeer(from);
    const { pc, polite } = entry;
    const offerCollision =
      sdp.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
    entry.ignoreOffer = !polite && offerCollision;
    if (entry.ignoreOffer) return;

    try {
      if (offerCollision) {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription(sdp),
        ]);
      } else {
        await pc.setRemoteDescription(sdp);
      }
      if (sdp.type === 'offer') {
        await pc.setLocalDescription();
        socket.emit('webrtc-answer', { to: from, sdp: pc.localDescription });
      }
    } catch (err) {
      console.error('Erro ao processar oferta WebRTC', err);
    }
  });

  socket.on('webrtc-answer', async ({ from, sdp }) => {
    dlog('[RTC] answer recebida de', from);
    const entry = peers[from];
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription(sdp);
    } catch (err) {
      console.error('Erro ao processar resposta WebRTC', err);
    }
  });

  socket.on('webrtc-ice-candidate', async ({ from, candidate }) => {
    const entry = peers[from];
    if (!entry || !candidate) return;
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch (err) {
      if (!entry.ignoreOffer) console.error('Erro ao adicionar ICE candidate', err);
    }
  });

  socket.on('voice-peers', (list) => {
    dlog('[RTC] voice-peers recebido', JSON.stringify(list));
  });

  voiceJoinBtn.addEventListener('click', joinVoice);
  voiceLeaveBtn.addEventListener('click', leaveVoice);
  micToggleBtn.addEventListener('click', toggleMic);
  deafenToggleBtn.addEventListener('click', toggleDeafen);
  screenShareBtn.addEventListener('click', () => {
    if (screenStream) stopScreenShare();
    else startScreenShare();
  });

  window.addEventListener('beforeunload', () => {
    if (inVoice) leaveVoice();
  });
})();
