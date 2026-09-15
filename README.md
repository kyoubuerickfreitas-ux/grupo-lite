# Grupo Lite

Chat em grupo com canais de texto, sala de voz e compartilhamento de tela — um "Discord bem simples" que você mesmo hospeda.

## O que tem

- Vários canais de texto (`#geral`, `#random`, `#avisos` — dá pra editar em `server.js`)
- Sala de voz com áudio ao vivo (WebRTC)
- Compartilhamento de tela (qualquer pessoa na sala de voz pode compartilhar)
- Lista de membros online em tempo real
- Sem cadastro: a pessoa só digita um apelido e entra

## Rodando localmente

Requer [Node.js](https://nodejs.org) 18 ou mais novo.

```bash
npm install
npm start
```

Depois abra `http://localhost:3000` no navegador. Pra testar com outra pessoa na mesma rede, use o IP da sua máquina (ex: `http://192.168.0.10:3000`).

## Colocando no ar (link acessível de qualquer lugar)

O app precisa ficar hospedado em algum lugar que fique ligado o tempo todo — seu computador não serve pra isso a menos que fique sempre ligado e com a porta liberada. O jeito mais simples e gratuito é o **Render**:

### Passo a passo (Render, grátis)

1. Crie uma conta gratuita em [render.com](https://render.com) (dá pra entrar com GitHub).
2. Coloque este projeto num repositório do GitHub:
   - Crie um repositório novo (ex: `grupo-lite`) em [github.com/new](https://github.com/new)
   - Suba os arquivos deste projeto pra lá (pelo site do GitHub mesmo, arrastando a pasta, ou via `git push` se preferir linha de comando)
3. No Render, clique em **New +** → **Blueprint**, selecione o repositório que você acabou de criar. O Render vai detectar o arquivo `render.yaml` e configurar tudo sozinho (nome, build, start).
4. Clique em **Apply** / **Deploy**. Em 1–2 minutos o Render te dá uma URL tipo `https://grupo-lite.onrender.com` — esse é o link que você compartilha com o grupo.

Se preferir não usar Blueprint, também funciona criar manualmente um **New + → Web Service**, apontando pro repositório, com:
- Build Command: `npm install`
- Start Command: `npm start`

**Observação sobre o plano grátis:** depois de ~15 minutos sem uso, o Render "hiberna" o serviço, e o primeiro acesso seguinte demora uns 30–60 segundos pra acordar. Pra um grupo pequeno usar de vez em quando isso não costuma incomodar; se virar algo usado com frequência, dá pra migrar pro plano pago (poucos dólares/mês) pra ficar sempre ativo.

### Alternativas

Railway (railway.app) e Fly.io funcionam de forma parecida — suba o código pro GitHub e conecte lá. O `render.yaml` é específico do Render, mas o `server.js`/`package.json` funcionam em qualquer um deles sem alteração (eles leem a variável `PORT` automaticamente).

## Limitações a saber

- **Tamanho do grupo:** a voz/tela usa conexão direta entre cada par de participantes (mesh). Funciona bem até uns 6–8 participantes simultâneos na sala de voz; com mais gente que isso, cada pessoa começa a sobrecarregar a própria internet mandando várias cópias do áudio/vídeo. Pra grupos maiores seria necessário um servidor de mídia (SFU), o que é um projeto bem mais complexo.
- **Redes corporativas/firewalls restritivos:** o app usa servidores STUN públicos do Google pra ajudar na conexão. Isso cobre a grande maioria das redes domésticas e de escritório, mas redes muito restritivas (NAT simétrico, firewalls corporativos fechados) podem precisar de um servidor TURN — não incluído aqui, mas é possível adicionar (ex: serviços como Metered ou Twilio têm planos gratuitos) se o áudio/tela não conectar para alguém específico.
- **Sem persistência:** o histórico de mensagens fica só na memória do servidor. Se o serviço reiniciar (ex: ao hibernar no plano grátis), o histórico zera.
- **Sem autenticação:** qualquer pessoa com o link entra digitando um nome. Bom pra um grupo de confiança; não use pra algo que precise de controle de acesso.

## Estrutura do projeto

```
server.js          servidor Node (Express + Socket.IO): chat, sinalização WebRTC
public/index.html  interface
public/style.css   visual (tema escuro, estilo Discord)
public/client.js   lógica do navegador: chat, voz e compartilhamento de tela via WebRTC
render.yaml         configuração de deploy automático no Render
```
