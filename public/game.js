// --- State ---
let ws;
let myId = null;
let gameState = null;
let drawnCard = null;
let specialType = null;
let knownCards = {};
let selectMode = null;
let stickWindowOpen = false;
let lastDiscard = null;
let peekingInitial = false;
let initialPeekCards = [];

const seatPositions = ['seat-top', 'seat-top-right', 'seat-right', 'seat-bottom-right', 'seat-bottom-left', 'seat-left', 'seat-top-left'];

// --- Screens ---
const screens = {
  lobby: document.getElementById('lobby-screen'),
  waiting: document.getElementById('waiting-screen'),
  ready: document.getElementById('ready-screen'),
  game: document.getElementById('game-screen'),
  gameover: document.getElementById('gameover-screen')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function toggleRules() { document.getElementById('rules').classList.toggle('hidden'); }

// --- WebSocket ---
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onopen = () => console.log('Connected');
  ws.onclose = () => { console.log('Disconnected'); setTimeout(connect, 2000); };
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
}

function send(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

// --- Lobby ---
document.getElementById('create-btn').addEventListener('click', () => {
  send({ type: 'create_room', name: document.getElementById('player-name').value.trim() || 'Player' });
});
document.getElementById('join-btn').addEventListener('click', () => {
  const code = document.getElementById('room-code').value.trim().toUpperCase();
  if (!code) return;
  send({ type: 'join_room', name: document.getElementById('player-name').value.trim() || 'Player', roomCode: code });
});
document.getElementById('start-btn').addEventListener('click', () => { send({ type: 'start_game' }); });
document.getElementById('ready-btn').addEventListener('click', () => {
  send({ type: 'player_ready' });
  document.getElementById('ready-btn').disabled = true;
  document.getElementById('ready-btn').textContent = 'Waiting...';
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
    case 'ready_check':
      showScreen('ready');
      document.getElementById('ready-btn').disabled = false;
      document.getElementById('ready-btn').textContent = "I'm Ready!";
      renderReadyList(msg.players);
      break;
    case 'ready_update':
      renderReadyList(msg.players);
      break;
    case 'game_state':
      gameState = msg;
      renderGame();
      break;
    case 'initial_peek':
      peekingInitial = true;
      initialPeekCards = msg.cards.map(c => c.card.id);
      msg.cards.forEach(c => { knownCards[c.card.id] = c.card; });
      showToast('Memorize your bottom 2 cards! (3s)', 3000);
      renderGame();
      setTimeout(() => {
        initialPeekCards.forEach(id => {
          const el = document.querySelector(`[data-card-id="${id}"]`);
          if (el) el.classList.add('flipping-back');
        });
        setTimeout(() => {
          initialPeekCards.forEach(id => { delete knownCards[id]; });
          initialPeekCards = [];
          peekingInitial = false;
          renderGame();
        }, 400);
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
      selectMode = getSelectModeForSpecial(msg.specialType);
      renderSelectMode();
      break;
    case 'special_progress':
      showToast(msg.message, 3000);
      break;
    case 'peek_result':
      knownCards[msg.card.id] = msg.card;
      showToast(`Peeked: ${formatCard(msg.card)}`, 3000);
      if (msg.canSwap) {
        if (msg.peekNumber === 2) { renderSwapConfirm(); }
        else if (msg.peekNumber === 1) { /* wait for 2nd */ }
        else { selectMode = 'peek_swap_2'; renderSelectMode(); }
      } else {
        selectMode = null;
        drawnCard = null;
        document.getElementById('drawn-card-area').classList.add('hidden');
        document.getElementById('action-buttons').innerHTML = '';
      }
      renderGame();
      break;
    case 'special_skipped':
      selectMode = null;
      if (drawnCard) renderSwapOrDiscard();
      else { document.getElementById('drawn-card-area').classList.add('hidden'); document.getElementById('action-buttons').innerHTML = ''; }
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
      showToast(`${msg.playerName} failed a stick — penalty card!`, 3000);
      break;
    case 'kaboom_called':
      showToast(`💥 ${msg.playerName} called KABOOM! One more turn each.`, 5000);
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

// --- Ready Screen ---
function renderReadyList(players) {
  const el = document.getElementById('ready-list');
  el.innerHTML = players.map(p =>
    `<div class="ready-chip ${p.ready ? 'is-ready' : 'waiting'}">${p.name} ${p.ready ? '✓' : '...'}</div>`
  ).join('');
}

// --- Waiting ---
function updatePlayerList(players) {
  document.getElementById('player-list').innerHTML = players.map(p =>
    `<div class="player-chip">${p.name}${p.id === myId ? ' (you)' : ''}</div>`
  ).join('');
}

// --- Game Rendering ---
function renderGame() {
  if (!gameState) return;
  showScreen('game');
  renderOpponents();
  renderTableCenter();
  renderMyCards();
  if (drawnCard && !stickWindowOpen) renderDrawnCard();
  else if (stickWindowOpen) renderStickWindow();
}

function renderOpponents() {
  const area = document.getElementById('opponents-area');
  const opponents = gameState.players.filter(p => p.id !== myId);

  area.innerHTML = opponents.map((p, idx) => {
    const seat = seatPositions[idx % seatPositions.length];
    const isCurrent = p.id === gameState.currentPlayerId;
    const cards = (p.cards || []).map((c, i) => {
      if (c === null) return `<div class="card card-empty"></div>`;
      const known = knownCards[c.id];
      if (known) {
        return `<div class="card card-face ${getCardColor(known)} ${selectMode && canSelectOpponent() ? 'selectable' : ''}" onclick="onCardClick('${p.id}', ${i})">${formatCardShort(known)}</div>`;
      }
      return `<div class="card card-back ${selectMode && canSelectOpponent() ? 'selectable' : ''}" onclick="onCardClick('${p.id}', ${i})"></div>`;
    }).join('');

    return `<div class="opponent ${seat}">
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
    infoEl.textContent = '💥 KABOOM! Final turns...';
  } else if (isMyTurn && gameState.turnPhase === 'draw') {
    infoEl.textContent = 'Your turn — tap deck to draw';
  } else if (isMyTurn) {
    infoEl.textContent = 'Your turn!';
  } else {
    infoEl.textContent = `${getPlayerName(gameState.currentPlayerId)}'s turn`;
  }

  if (isMyTurn && gameState.turnPhase === 'draw' && !gameState.kaboomCallerId && !stickWindowOpen && !drawnCard && !selectMode) {
    btns.innerHTML = `<button class="btn btn-danger" onclick="callKaboom()">💥 Kaboom</button>`;
  } else if (!stickWindowOpen && !drawnCard && !selectMode) {
    btns.innerHTML = '';
  }

  deckEl.onclick = () => {
    if (isMyTurn && gameState.turnPhase === 'draw') send({ type: 'draw_card' });
  };
}

function renderMyCards() {
  const container = document.getElementById('my-cards');
  const me = gameState.players.find(p => p.id === myId);
  if (!me) return;

  container.innerHTML = me.cards.map((c, i) => {
    if (c === null) return `<div class="card card-empty"></div>`;
    const known = knownCards[c.id];
    const selectable = (selectMode && canSelectOwn()) ? 'selectable' : '';
    const flipClass = initialPeekCards.includes(c.id) ? 'flip-in' : '';
    if (known) {
      return `<div class="card card-face ${getCardColor(known)} ${selectable} ${flipClass}" data-card-id="${c.id}" onclick="onCardClick('${myId}', ${i})">${formatCardShort(known)}</div>`;
    }
    return `<div class="card card-back ${selectable}" data-card-id="${c.id}" onclick="onCardClick('${myId}', ${i})"></div>`;
  }).join('');
}

function renderDrawnCard() {
  if (!drawnCard) { document.getElementById('drawn-card-area').classList.add('hidden'); return; }
  const area = document.getElementById('drawn-card-area');
  area.classList.remove('hidden');
  area.innerHTML = `<div class="label">Drawn</div><div class="card card-face ${getCardColor(drawnCard)}">${formatCardShort(drawnCard)}</div>`;

  const btns = document.getElementById('action-buttons');
  if (specialType) {
    btns.innerHTML = `
      <button class="btn btn-success" onclick="useSpecial()">Use ${getSpecialName(specialType)}</button>
      <button class="btn btn-secondary" onclick="skipSpecial()">Skip → Swap</button>`;
  } else {
    renderSwapOrDiscard();
  }
}

function renderSwapOrDiscard() {
  const btns = document.getElementById('action-buttons');
  if (!gameState || gameState.currentPlayerId !== myId) { btns.innerHTML = ''; return; }
  selectMode = 'swap';
  btns.innerHTML = `<button class="btn btn-secondary" onclick="discardDrawn()">Discard</button><span style="color:#888;font-size:0.7rem;"> or tap card to swap</span>`;
  renderMyCards();
}

function renderSelectMode() {
  const btns = document.getElementById('action-buttons');
  const info = document.getElementById('game-info');
  const modes = {
    peek_own: 'Tap YOUR card to peek',
    peek_opponent: "Tap OPPONENT's card to peek",
    blind_swap_mine: 'Tap YOUR card to swap',
    blind_swap_theirs: "Tap OPPONENT's card",
    peek_swap_1: 'Tap ANY card to peek (Queen)',
    peek_swap_2: 'Tap card to swap with peeked (or skip)',
    peek_two_1: 'Tap 1st card to peek (Black King)',
    peek_two_2: 'Tap 2nd card to peek'
  };
  info.textContent = modes[selectMode] || '';
  btns.innerHTML = selectMode === 'peek_swap_2' ? `<button class="btn btn-secondary" onclick="skipSwap()">Skip Swap</button>` : '';
  renderMyCards();
  renderOpponents();
}

function renderSwapConfirm() {
  document.getElementById('action-buttons').innerHTML = `
    <button class="btn btn-success" onclick="confirmSwap()">Swap 2 Cards</button>
    <button class="btn btn-secondary" onclick="skipSwap()">Don't Swap</button>`;
}

function renderStickWindow() {
  if (!stickWindowOpen) return;
  document.getElementById('drawn-card-area').classList.add('hidden');
  document.getElementById('game-info').textContent = `⚡ Stick! Match: ${formatCard(lastDiscard)}`;
  document.getElementById('action-buttons').innerHTML = `
    <button class="btn btn-success" onclick="startStick('own')">Stick Mine</button>
    <button class="btn btn-primary" onclick="startStick('other')">Stick Theirs</button>`;
  selectMode = null;
  renderMyCards();
  renderOpponents();
}

function startStick(target) {
  selectMode = target === 'own' ? 'stick_mine' : 'stick_theirs';
  document.getElementById('game-info').textContent = target === 'own' ? 'Tap YOUR matching card' : "Tap OPPONENT's card, then yours to give";
  document.getElementById('action-buttons').innerHTML = '';
  renderMyCards();
  renderOpponents();
}

// --- Card Click ---
let stickTargetPlayer = null, stickTargetIndex = null;

function onCardClick(targetPlayerId, cardIndex) {
  if (!selectMode && !stickWindowOpen) return;
  switch (selectMode) {
    case 'swap':
      if (targetPlayerId !== myId) return;
      send({ type: 'swap_card', cardIndex });
      drawnCard = null; selectMode = null;
      document.getElementById('drawn-card-area').classList.add('hidden');
      document.getElementById('action-buttons').innerHTML = '';
      break;
    case 'peek_own':
      if (targetPlayerId !== myId) return;
      send({ type: 'special_select', targetPlayerId, cardIndex }); selectMode = null;
      break;
    case 'peek_opponent':
      if (targetPlayerId === myId) return;
      send({ type: 'special_select', targetPlayerId, cardIndex }); selectMode = null;
      break;
    case 'blind_swap_mine':
      if (targetPlayerId !== myId) return;
      send({ type: 'special_select', targetPlayerId, cardIndex });
      selectMode = 'blind_swap_theirs'; renderSelectMode();
      break;
    case 'blind_swap_theirs':
      if (targetPlayerId === myId) return;
      send({ type: 'special_select', targetPlayerId, cardIndex }); selectMode = null;
      break;
    case 'peek_swap_1':
      send({ type: 'special_select', targetPlayerId, cardIndex }); selectMode = null;
      break;
    case 'peek_swap_2':
      send({ type: 'special_select', targetPlayerId, cardIndex }); selectMode = null;
      break;
    case 'peek_two_1':
      send({ type: 'special_select', targetPlayerId, cardIndex });
      selectMode = 'peek_two_2'; renderSelectMode();
      break;
    case 'peek_two_2':
      send({ type: 'special_select', targetPlayerId, cardIndex }); selectMode = null;
      break;
    case 'stick_mine':
      if (targetPlayerId !== myId) return;
      send({ type: 'stick', targetPlayerId: myId, cardIndex });
      selectMode = null; stickWindowOpen = false;
      break;
    case 'stick_theirs':
      if (targetPlayerId === myId) {
        if (stickTargetPlayer !== null) {
          send({ type: 'stick', targetPlayerId: stickTargetPlayer, cardIndex: stickTargetIndex, giveCardIndex: cardIndex });
          selectMode = null; stickWindowOpen = false;
          stickTargetPlayer = null; stickTargetIndex = null;
        }
        return;
      }
      stickTargetPlayer = targetPlayerId;
      stickTargetIndex = cardIndex;
      document.getElementById('game-info').textContent = 'Now tap YOUR card to give them';
      renderMyCards();
      break;
  }
}

// --- Actions ---
function useSpecial() { send({ type: 'use_special' }); }
function skipSpecial() { send({ type: 'skip_special' }); specialType = null; }
function discardDrawn() {
  send({ type: 'discard_drawn' }); drawnCard = null; selectMode = null;
  document.getElementById('drawn-card-area').classList.add('hidden');
  document.getElementById('action-buttons').innerHTML = '';
}
function callKaboom() { if (confirm('Call Kaboom?')) send({ type: 'call_kaboom' }); }
function confirmSwap() { send({ type: 'special_swap_confirm' }); selectMode = null; drawnCard = null; document.getElementById('drawn-card-area').classList.add('hidden'); document.getElementById('action-buttons').innerHTML = ''; }
function skipSwap() { send({ type: 'special_skip_swap' }); selectMode = null; drawnCard = null; document.getElementById('drawn-card-area').classList.add('hidden'); document.getElementById('action-buttons').innerHTML = ''; }

// --- Game Over ---
function renderGameOver(msg) {
  showScreen('gameover');
  document.getElementById('results').innerHTML = msg.results.map((r, i) => {
    const medals = ['🥇', '🥈', '🥉'];
    const cards = r.cards.map(c => `<span class="mini-card ${getCardColor(c)}">${formatCardShort(c)}</span>`).join('');
    const caller = r.id === msg.kaboomCallerId ? ' 💥' : '';
    return `<div class="result-row"><span class="rank">${medals[i] || '#'+(i+1)}</span><div><div class="name">${r.name}${caller}</div><div class="result-cards">${cards}</div></div><span class="score">${r.score}</span></div>`;
  }).join('');
}

// --- Helpers ---
function getPlayerName(id) { return gameState?.players.find(p => p.id === id)?.name || '?'; }
function formatCard(c) { if (!c) return '?'; if (c.value === 'JOKER') return '🃏 Joker'; return `${c.value}${{hearts:'♥',diamonds:'♦',clubs:'♣',spades:'♠'}[c.suit]||''}`; }
function formatCardShort(c) { if (!c) return '?'; if (c.value === 'JOKER') return '🃏'; return `${c.value}${{hearts:'♥',diamonds:'♦',clubs:'♣',spades:'♠'}[c.suit]||''}`; }
function getCardColor(c) { if (!c || c.value === 'JOKER') return ''; return (c.suit === 'hearts' || c.suit === 'diamonds') ? 'red' : 'black'; }
function getSpecialName(t) { return {peek_own:'Peek Own',peek_opponent:"Peek Opp's",blind_swap:'Blind Swap',peek_swap:'Queen Peek+Swap',peek_two_swap:'King Peek 2'}[t] || 'Special'; }
function getSelectModeForSpecial(t) { return {peek_own:'peek_own',peek_opponent:'peek_opponent',blind_swap:'blind_swap_mine',peek_swap:'peek_swap_1',peek_two_swap:'peek_two_1'}[t] || null; }
function canSelectOwn() { return ['swap','peek_own','blind_swap_mine','peek_swap_1','peek_swap_2','peek_two_1','peek_two_2','stick_mine','stick_theirs'].includes(selectMode); }
function canSelectOpponent() { return ['peek_opponent','blind_swap_theirs','peek_swap_1','peek_swap_2','peek_two_1','peek_two_2','stick_theirs'].includes(selectMode); }

let toastTimeout;
function showToast(msg, dur = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.add('hidden'), dur);
}

connect();
