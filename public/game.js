// --- State ---
let ws;
let myId = null;
let gameState = null;
let drawnCard = null;
let specialType = null;
let specialStep = 0;
let knownCards = {}; // { cardId: card }
let selectMode = null;
let stickWindowOpen = false;
let lastDiscard = null;
let peekingInitial = false; // true during the 3s initial peek

// --- Elements ---
const screens = {
  lobby: document.getElementById('lobby-screen'),
  waiting: document.getElementById('waiting-screen'),
  game: document.getElementById('game-screen'),
  gameover: document.getElementById('gameover-screen')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function toggleRules() {
  document.getElementById('rules').classList.toggle('hidden');
}

// --- WebSocket ---
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => console.log('Connected');
  ws.onclose = () => {
    console.log('Disconnected');
    setTimeout(connect, 2000);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// --- Lobby Actions ---
document.getElementById('create-btn').addEventListener('click', () => {
  const name = document.getElementById('player-name').value.trim() || 'Player';
  send({ type: 'create_room', name });
});

document.getElementById('join-btn').addEventListener('click', () => {
  const name = document.getElementById('player-name').value.trim() || 'Player';
  const code = document.getElementById('room-code').value.trim().toUpperCase();
  if (!code) return;
  send({ type: 'join_room', name, roomCode: code });
});

document.getElementById('start-btn').addEventListener('click', () => {
  send({ type: 'start_game' });
});

// --- Message Handler ---
function handleMessage(msg) {
  switch (msg.type) {
    case 'room_created':
      myId = msg.playerId;
      document.getElementById('display-room-code').textContent = msg.roomCode;
      document.getElementById('start-btn').classList.remove('hidden');
      showScreen('waiting');
      updatePlayerList([{ id: myId, name: document.getElementById('player-name').value.trim() || 'Player' }]);
      break;

    case 'room_joined':
      myId = msg.playerId;
      document.getElementById('display-room-code').textContent = msg.roomCode;
      showScreen('waiting');
      break;

    case 'player_joined':
      updatePlayerList(msg.players);
      break;

    case 'game_state':
      gameState = msg;
      if (!peekingInitial) {
        renderGame();
      }
      break;

    case 'initial_peek':
      // Show cards face-up for 3 seconds then flip
      peekingInitial = true;
      msg.cards.forEach(c => {
        knownCards[c.card.id] = c.card;
      });
      showToast('Memorize your bottom 2 cards! (3s)', 3000);
      renderGame();
      // After 3 seconds, remove from known and flip back
      setTimeout(() => {
        msg.cards.forEach(c => {
          // Keep them in knownCards — player memorized them
          // But mark peeking as done
        });
        peekingInitial = false;
        renderGame();
      }, msg.duration || 3000);
      break;

    case 'card_drawn':
      drawnCard = msg.card;
      specialType = msg.special;
      renderDrawnCard();
      break;

    case 'player_drew':
      showToast(`${getPlayerName(msg.playerId)} drew a card`);
      break;

    case 'special_started':
      specialStep = 0;
      selectMode = getSelectModeForSpecial(msg.specialType);
      renderSelectMode();
      break;

    case 'special_progress':
      specialStep++;
      updateSelectModeStep();
      showToast(msg.message, 3000);
      break;

    case 'peek_result':
      knownCards[msg.card.id] = msg.card;
      showToast(`Peeked: ${formatCard(msg.card)}`, 3000);
      if (msg.canSwap) {
        if (msg.peekNumber === 2) {
          renderSwapConfirm();
        } else if (msg.peekNumber === 1) {
          // Black King first peek — wait for second selection
        } else {
          // Queen — select second card to swap with
          selectMode = 'peek_swap_2';
          renderSelectMode();
        }
      } else {
        selectMode = null;
        renderSwapOrDiscard();
      }
      renderGame();
      break;

    case 'special_skipped':
      selectMode = null;
      renderSwapOrDiscard();
      break;

    case 'swap_occurred':
      showToast(msg.message, 3000);
      break;

    case 'card_discarded':
      lastDiscard = msg.card;
      drawnCard = null;
      document.getElementById('drawn-card-area').classList.add('hidden');
      showToast(`${getPlayerName(msg.playerId)} discarded ${formatCard(msg.card)}`);
      break;

    case 'stick_window_open':
      stickWindowOpen = true;
      lastDiscard = msg.card;
      renderStickWindow();
      break;

    case 'stick_window_closed':
      stickWindowOpen = false;
      selectMode = null;
      break;

    case 'stick_success':
      showToast(`${msg.stickerName} stuck a ${formatCard(msg.card)}!`, 3000);
      break;

    case 'stick_failed':
      showToast(msg.message, 3000);
      break;

    case 'stick_penalty':
      showToast(`${msg.playerName} failed a stick and got a penalty card!`, 3000);
      break;

    case 'kaboom_called':
      showToast(`💥 ${msg.playerName} called KABOOM! Everyone gets one more turn.`, 5000);
      break;

    case 'player_disconnected':
      showToast(`${msg.playerName} disconnected`);
      break;

    case 'game_over':
      renderGameOver(msg);
      break;

    case 'error':
      showToast(`⚠️ ${msg.message}`, 3000);
      break;
  }
}

// --- Rendering ---
function updatePlayerList(players) {
  const el = document.getElementById('player-list');
  el.innerHTML = players.map(p =>
    `<div class="player-chip">${p.name}${p.id === myId ? ' (you)' : ''}</div>`
  ).join('');
}

function renderGame() {
  if (!gameState) return;
  showScreen('game');

  renderOpponents();
  renderTableCenter();
  renderMyCards();
}

function renderOpponents() {
  const area = document.getElementById('opponents-area');
  const opponents = gameState.players.filter(p => p.id !== myId);

  area.innerHTML = opponents.map(p => {
    const isCurrent = p.id === gameState.currentPlayerId;
    const cards = (p.cards || []).map((c, i) => {
      const known = knownCards[c.id];
      if (known) {
        const color = getCardColor(known);
        return `<div class="card card-face ${color} ${selectMode && canSelectOpponent() ? 'selectable' : ''}" 
                     data-player-id="${p.id}" data-card-index="${i}" onclick="onCardClick('${p.id}', ${i})">
                  ${formatCardShort(known)}
                </div>`;
      }
      return `<div class="card card-back ${selectMode && canSelectOpponent() ? 'selectable' : ''}" 
                   data-player-id="${p.id}" data-card-index="${i}" onclick="onCardClick('${p.id}', ${i})"></div>`;
    }).join('');

    return `<div class="opponent">
      <div class="opponent-name ${isCurrent ? 'current-turn' : ''}">${p.name}${isCurrent ? ' ⏳' : ''}</div>
      <div class="opponent-cards">${cards}</div>
    </div>`;
  }).join('');
}

function renderTableCenter() {
  const deckEl = document.getElementById('deck');
  const discardEl = document.getElementById('discard');
  const infoEl = document.getElementById('game-info');
  const btns = document.getElementById('action-buttons');

  deckEl.querySelector('.deck-count').textContent = gameState.deckCount;

  if (gameState.discardTop) {
    discardEl.className = 'card discard-card has-card card-face ' + getCardColor(gameState.discardTop);
    discardEl.innerHTML = `<span class="card-text">${formatCardShort(gameState.discardTop)}</span>`;
  } else {
    discardEl.className = 'card discard-card empty';
    discardEl.innerHTML = '<span class="card-text">-</span>';
  }

  const isMyTurn = gameState.currentPlayerId === myId;

  if (gameState.kaboomCallerId) {
    infoEl.textContent = `💥 KABOOM called! Final turns...`;
  } else if (isMyTurn && gameState.turnPhase === 'draw') {
    infoEl.textContent = 'Your turn — draw a card or call Kaboom!';
  } else if (isMyTurn) {
    infoEl.textContent = 'Your turn!';
  } else {
    infoEl.textContent = `${getPlayerName(gameState.currentPlayerId)}'s turn`;
  }

  // Show Kaboom button only on your turn, before drawing
  if (isMyTurn && gameState.turnPhase === 'draw' && !gameState.kaboomCallerId && !stickWindowOpen && !drawnCard) {
    // Only show draw + kaboom buttons if we haven't drawn yet
    if (!selectMode) {
      btns.innerHTML = `
        <button class="btn btn-danger" onclick="callKaboom()">💥 Call Kaboom</button>
      `;
    }
  } else if (!stickWindowOpen && !drawnCard && !selectMode) {
    btns.innerHTML = '';
  }

  // Deck click for drawing
  deckEl.onclick = () => {
    if (isMyTurn && gameState.turnPhase === 'draw') {
      send({ type: 'draw_card' });
    }
  };
}

function renderMyCards() {
  const container = document.getElementById('my-cards');
  const me = gameState.players.find(p => p.id === myId);
  if (!me) return;

  container.innerHTML = me.cards.map((c, i) => {
    const known = knownCards[c.id];
    const selectable = (selectMode && canSelectOwn()) ? 'selectable' : '';

    if (known) {
      const color = getCardColor(known);
      return `<div class="card card-face ${color} ${selectable}" onclick="onCardClick('${myId}', ${i})">
                ${formatCardShort(known)}
              </div>`;
    }
    return `<div class="card card-back ${selectable}" onclick="onCardClick('${myId}', ${i})"></div>`;
  }).join('');
}

function renderDrawnCard() {
  if (!drawnCard) {
    document.getElementById('drawn-card-area').classList.add('hidden');
    document.getElementById('action-buttons').innerHTML = '';
    return;
  }

  const area = document.getElementById('drawn-card-area');
  area.classList.remove('hidden');

  const color = getCardColor(drawnCard);
  area.innerHTML = `
    <div class="label">Drawn Card</div>
    <div class="card card-face ${color}">${formatCardShort(drawnCard)}</div>
  `;

  const btns = document.getElementById('action-buttons');

  if (specialType) {
    btns.innerHTML = `
      <button class="btn btn-success" onclick="useSpecial()">Use ${getSpecialName(specialType)}</button>
      <button class="btn btn-secondary" onclick="skipSpecial()">Skip & Choose</button>
    `;
  } else {
    renderSwapOrDiscard();
  }
}

function renderSwapOrDiscard() {
  const btns = document.getElementById('action-buttons');
  const isMyTurn = gameState && gameState.currentPlayerId === myId;

  if (!isMyTurn) {
    btns.innerHTML = '';
    return;
  }

  selectMode = 'swap';
  btns.innerHTML = `
    <button class="btn btn-secondary" onclick="discardDrawn()">Discard</button>
    <span style="color:#888;font-size:0.8rem;">or tap your card to swap</span>
  `;

  renderMyCards();
}

function renderSelectMode() {
  const btns = document.getElementById('action-buttons');
  const info = document.getElementById('game-info');

  switch (selectMode) {
    case 'peek_own':
      info.textContent = 'Select one of YOUR cards to peek at';
      btns.innerHTML = '';
      break;
    case 'peek_opponent':
      info.textContent = "Select one of an OPPONENT's cards to peek at";
      btns.innerHTML = '';
      break;
    case 'blind_swap_mine':
      info.textContent = 'Select YOUR card to swap';
      btns.innerHTML = '';
      break;
    case 'blind_swap_theirs':
      info.textContent = "Select an OPPONENT's card to swap with";
      btns.innerHTML = '';
      break;
    case 'peek_swap_1':
      info.textContent = 'Select ANY card to peek at (Queen)';
      btns.innerHTML = '';
      break;
    case 'peek_swap_2':
      info.textContent = 'Select a card to swap with the peeked card (or skip)';
      btns.innerHTML = `<button class="btn btn-secondary" onclick="skipSwap()">Skip Swap</button>`;
      break;
    case 'peek_two_1':
      info.textContent = 'Select first card to peek at (Black King)';
      btns.innerHTML = '';
      break;
    case 'peek_two_2':
      info.textContent = 'Select second card to peek at (Black King)';
      btns.innerHTML = '';
      break;
  }

  renderMyCards();
  renderOpponents();
}

function renderSwapConfirm() {
  const btns = document.getElementById('action-buttons');
  btns.innerHTML = `
    <button class="btn btn-success" onclick="confirmSwap()">Swap These 2 Cards</button>
    <button class="btn btn-secondary" onclick="skipSwap()">Don't Swap</button>
  `;
}

function renderStickWindow() {
  if (!stickWindowOpen) return;

  const btns = document.getElementById('action-buttons');
  const info = document.getElementById('game-info');

  info.textContent = `⚡ Stick window! Match: ${formatCard(lastDiscard)}`;
  btns.innerHTML = `
    <button class="btn btn-success" onclick="startStick('own')">Stick My Card</button>
    <button class="btn btn-primary" onclick="startStick('other')">Stick Opponent's Card</button>
  `;

  selectMode = null;
  renderMyCards();
}

function startStick(target) {
  if (target === 'own') {
    selectMode = 'stick_mine';
    document.getElementById('game-info').textContent = 'Select YOUR matching card to stick';
  } else {
    selectMode = 'stick_theirs';
    document.getElementById('game-info').textContent = "Select an OPPONENT's matching card, then your card to give them";
  }
  document.getElementById('action-buttons').innerHTML = '';
  renderMyCards();
  renderOpponents();
}

// --- Card Click Handler ---
let stickTargetPlayer = null;
let stickTargetIndex = null;

function onCardClick(targetPlayerId, cardIndex) {
  if (!selectMode && !stickWindowOpen) return;

  switch (selectMode) {
    case 'swap':
      if (targetPlayerId !== myId) return;
      send({ type: 'swap_card', cardIndex });
      drawnCard = null;
      selectMode = null;
      document.getElementById('drawn-card-area').classList.add('hidden');
      document.getElementById('action-buttons').innerHTML = '';
      break;

    case 'peek_own':
      if (targetPlayerId !== myId) return;
      send({ type: 'special_select', targetPlayerId, cardIndex });
      selectMode = null;
      break;

    case 'peek_opponent':
      if (targetPlayerId === myId) return;
      send({ type: 'special_select', targetPlayerId, cardIndex });
      selectMode = null;
      break;

    case 'blind_swap_mine':
      if (targetPlayerId !== myId) return;
      send({ type: 'special_select', targetPlayerId, cardIndex });
      selectMode = 'blind_swap_theirs';
      renderSelectMode();
      break;

    case 'blind_swap_theirs':
      if (targetPlayerId === myId) return;
      send({ type: 'special_select', targetPlayerId, cardIndex });
      selectMode = null;
      break;

    case 'peek_swap_1':
      send({ type: 'special_select', targetPlayerId, cardIndex });
      selectMode = null;
      break;

    case 'peek_swap_2':
      send({ type: 'special_select', targetPlayerId, cardIndex });
      selectMode = null;
      break;

    case 'peek_two_1':
      send({ type: 'special_select', targetPlayerId, cardIndex });
      selectMode = 'peek_two_2';
      renderSelectMode();
      break;

    case 'peek_two_2':
      send({ type: 'special_select', targetPlayerId, cardIndex });
      selectMode = null;
      break;

    case 'stick_mine':
      if (targetPlayerId !== myId) return;
      send({ type: 'stick', targetPlayerId: myId, cardIndex });
      selectMode = null;
      stickWindowOpen = false;
      break;

    case 'stick_theirs':
      if (targetPlayerId === myId) {
        // Selecting which card to give them
        if (stickTargetPlayer !== null) {
          send({ type: 'stick', targetPlayerId: stickTargetPlayer, cardIndex: stickTargetIndex, giveCardIndex: cardIndex });
          selectMode = null;
          stickWindowOpen = false;
          stickTargetPlayer = null;
          stickTargetIndex = null;
        }
        return;
      }
      // First select opponent's card
      stickTargetPlayer = targetPlayerId;
      stickTargetIndex = cardIndex;
      document.getElementById('game-info').textContent = 'Now select YOUR card to give them';
      renderMyCards();
      break;
  }
}

// --- Actions ---
function useSpecial() {
  send({ type: 'use_special' });
}

function skipSpecial() {
  send({ type: 'skip_special' });
  specialType = null;
}

function discardDrawn() {
  send({ type: 'discard_drawn' });
  drawnCard = null;
  selectMode = null;
  document.getElementById('drawn-card-area').classList.add('hidden');
  document.getElementById('action-buttons').innerHTML = '';
}

function callKaboom() {
  if (confirm('Are you sure you want to call Kaboom?')) {
    send({ type: 'call_kaboom' });
  }
}

function confirmSwap() {
  send({ type: 'special_swap_confirm' });
  selectMode = null;
}

function skipSwap() {
  send({ type: 'special_skip_swap' });
  selectMode = null;
}

function updateSelectModeStep() {
  // Called when specialStep increments — rendering handled by renderSelectMode
}

// --- Game Over ---
function renderGameOver(msg) {
  showScreen('gameover');
  const container = document.getElementById('results');

  container.innerHTML = msg.results.map((r, i) => {
    const medals = ['🥇', '🥈', '🥉'];
    const rank = medals[i] || `#${i + 1}`;
    const cards = r.cards.map(c => {
      const color = getCardColor(c);
      return `<span class="mini-card ${color}">${formatCardShort(c)}</span>`;
    }).join('');

    const callerTag = r.id === msg.kaboomCallerId ? ' 💥' : '';

    return `<div class="result-row">
      <span class="rank">${rank}</span>
      <div>
        <div class="name">${r.name}${callerTag}</div>
        <div class="result-cards">${cards}</div>
      </div>
      <span class="score">${r.score}</span>
    </div>`;
  }).join('');
}

// --- Helpers ---
function getPlayerName(id) {
  if (!gameState) return '?';
  const p = gameState.players.find(p => p.id === id);
  return p ? p.name : '?';
}

function formatCard(card) {
  if (!card) return '?';
  if (card.value === 'JOKER') return '🃏 Joker';
  const suitSymbols = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
  return `${card.value}${suitSymbols[card.suit] || ''}`;
}

function formatCardShort(card) {
  if (!card) return '?';
  if (card.value === 'JOKER') return '🃏';
  const suitSymbols = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
  return `${card.value}${suitSymbols[card.suit] || ''}`;
}

function getCardColor(card) {
  if (!card) return '';
  if (card.value === 'JOKER') return '';
  return (card.suit === 'hearts' || card.suit === 'diamonds') ? 'red' : 'black';
}

function getSpecialName(type) {
  switch (type) {
    case 'peek_own': return 'Peek (own card)';
    case 'peek_opponent': return "Peek (opponent's)";
    case 'blind_swap': return 'Blind Swap';
    case 'peek_swap': return 'Peek & Swap (Queen)';
    case 'peek_two_swap': return 'Peek 2 & Swap (Black King)';
    default: return 'Special';
  }
}

function getSelectModeForSpecial(type) {
  switch (type) {
    case 'peek_own': return 'peek_own';
    case 'peek_opponent': return 'peek_opponent';
    case 'blind_swap': return 'blind_swap_mine';
    case 'peek_swap': return 'peek_swap_1';
    case 'peek_two_swap': return 'peek_two_1';
    default: return null;
  }
}

function canSelectOwn() {
  return ['swap', 'peek_own', 'blind_swap_mine', 'peek_swap_1', 'peek_swap_2', 'peek_two_1', 'peek_two_2', 'stick_mine', 'stick_theirs'].includes(selectMode);
}

function canSelectOpponent() {
  return ['peek_opponent', 'blind_swap_theirs', 'peek_swap_1', 'peek_swap_2', 'peek_two_1', 'peek_two_2', 'stick_theirs'].includes(selectMode);
}

let toastTimeout;
function showToast(msg, duration = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.add('hidden'), duration);
}

// --- Init ---
connect();
