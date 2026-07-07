const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Game state
const rooms = new Map();

function createDeck() {
  const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
  const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];

  for (const suit of suits) {
    for (const value of values) {
      deck.push({ suit, value, id: uuidv4() });
    }
  }

  // Add 2 jokers
  deck.push({ suit: 'joker', value: 'JOKER', id: uuidv4() });
  deck.push({ suit: 'joker', value: 'JOKER', id: uuidv4() });

  return shuffle(deck);
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getCardPoints(card) {
  if (card.value === 'JOKER') return -1;
  if (card.value === 'A') return 1;
  if (card.value === 'J') return 11;
  if (card.value === 'Q') return 12;
  if (card.value === 'K') {
    if (card.suit === 'hearts' || card.suit === 'diamonds') return -1;
    return 25; // Black king
  }
  return parseInt(card.value);
}

function getCardNumericValue(card) {
  if (card.value === 'JOKER') return 0;
  if (card.value === 'A') return 1;
  if (card.value === 'J') return 11;
  if (card.value === 'Q') return 12;
  if (card.value === 'K') return 13;
  return parseInt(card.value);
}

function getSpecialType(card) {
  if (card.value === '7' || card.value === '8') return 'peek_own';
  if (card.value === '9' || card.value === '10') return 'peek_opponent';
  if (card.value === 'J') return 'blind_swap';
  if (card.value === 'Q') return 'peek_swap';
  if (card.value === 'K' && (card.suit === 'clubs' || card.suit === 'spades')) return 'peek_two_swap';
  return null;
}

function createRoom(hostId, hostName) {
  const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  const room = {
    code: roomCode,
    players: [{
      id: hostId,
      name: hostName,
      cards: [],
      connected: true
    }],
    state: 'lobby',
    deck: [],
    discardPile: [],
    currentPlayerIndex: 0,
    kaboomCallerId: null,
    finalTurnsRemaining: 0,
    turnPhase: 'draw',
    drawnCard: null,
    specialAction: null
  };
  rooms.set(roomCode, room);
  return room;
}

function broadcastToRoom(room, message, excludeId = null) {
  for (const player of room.players) {
    if (player.id !== excludeId && player.ws && player.ws.readyState === 1) {
      player.ws.send(JSON.stringify(message));
    }
  }
}

function sendToPlayer(room, playerId, message) {
  const player = room.players.find(p => p.id === playerId);
  if (player && player.ws && player.ws.readyState === 1) {
    player.ws.send(JSON.stringify(message));
  }
}

function getPublicGameState(room, forPlayerId) {
  return {
    type: 'game_state',
    roomCode: room.code,
    state: room.state,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: p.cards.filter(c => c !== null).length,
      cards: p.cards.map(c => c ? { id: c.id, faceUp: c.faceUp || false } : null),
      connected: p.connected
    })),
    currentPlayerIndex: room.currentPlayerIndex,
    currentPlayerId: room.players[room.currentPlayerIndex]?.id,
    discardTop: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null,
    discardCount: room.discardPile.length,
    deckCount: room.deck.length,
    kaboomCallerId: room.kaboomCallerId,
    turnPhase: room.turnPhase,
    myId: forPlayerId
  };
}

function broadcastGameState(room) {
  for (const player of room.players) {
    sendToPlayer(room, player.id, getPublicGameState(room, player.id));
  }
}

// Auto-discard drawn card after using its special power, then open stick window
function autoDiscardAfterSpecial(room) {
  const card = room.drawnCard;
  room.discardPile.push(card);
  room.drawnCard = null;

  room.turnPhase = 'stick_window';

  broadcastToRoom(room, {
    type: 'card_discarded',
    card,
    playerId: room.players[room.currentPlayerIndex].id,
    action: 'discard'
  });

  broadcastToRoom(room, { type: 'stick_window_open', card });
  broadcastGameState(room);

  setTimeout(() => {
    if (room.turnPhase === 'stick_window') {
      broadcastToRoom(room, { type: 'stick_window_closed' });
      nextTurn(room);
    }
  }, 5000);
}

function startGame(room) {
  room.deck = createDeck();
  room.state = 'playing';
  room.discardPile = [];
  room.currentPlayerIndex = 0;
  room.turnPhase = 'draw';

  // Deal 4 cards to each player
  for (const player of room.players) {
    player.cards = [];
    for (let i = 0; i < 4; i++) {
      const card = room.deck.pop();
      card.faceUp = false;
      player.cards.push(card);
    }
  }

  // Put first card on discard pile
  room.discardPile.push(room.deck.pop());

  // Send game state to all
  broadcastGameState(room);

  // Allow each player to peek at their bottom 2 cards (indices 2, 3) for 3 seconds
  for (const player of room.players) {
    sendToPlayer(room, player.id, {
      type: 'initial_peek',
      cards: [
        { index: 2, card: player.cards[2] },
        { index: 3, card: player.cards[3] }
      ],
      duration: 3000
    });
  }
}

function nextTurn(room) {
  if (room.state !== 'playing') return;

  // Check if game should end
  if (room.kaboomCallerId !== null) {
    room.finalTurnsRemaining--;
    if (room.finalTurnsRemaining <= 0) {
      endGame(room);
      return;
    }
  }

  // Move to next player
  room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;

  // Skip the kaboom caller in final round
  if (room.kaboomCallerId !== null && room.players[room.currentPlayerIndex].id === room.kaboomCallerId) {
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
  }

  room.turnPhase = 'draw';
  room.drawnCard = null;
  room.specialAction = null;

  broadcastGameState(room);
}

function endGame(room) {
  room.state = 'ended';

  const results = room.players.map(p => {
    const activeCards = p.cards.filter(c => c !== null);
    const score = activeCards.reduce((sum, card) => sum + getCardPoints(card), 0);
    return {
      id: p.id,
      name: p.name,
      cards: activeCards,
      score
    };
  });

  results.sort((a, b) => a.score - b.score);

  broadcastToRoom(room, {
    type: 'game_over',
    results,
    kaboomCallerId: room.kaboomCallerId
  });
}

wss.on('connection', (ws) => {
  let playerId = uuidv4();
  let currentRoom = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create_room': {
        const room = createRoom(playerId, msg.name || 'Player');
        room.players[0].ws = ws;
        currentRoom = room;
        ws.send(JSON.stringify({
          type: 'room_created',
          roomCode: room.code,
          playerId
        }));
        break;
      }

      case 'join_room': {
        const room = rooms.get(msg.roomCode?.toUpperCase());
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          break;
        }
        if (room.state !== 'lobby') {
          ws.send(JSON.stringify({ type: 'error', message: 'Game already in progress' }));
          break;
        }
        if (room.players.length >= 8) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full (max 8 players)' }));
          break;
        }

        room.players.push({
          id: playerId,
          name: msg.name || 'Player',
          cards: [],
          connected: true,
          ws
        });
        currentRoom = room;

        ws.send(JSON.stringify({
          type: 'room_joined',
          roomCode: room.code,
          playerId
        }));

        broadcastToRoom(room, {
          type: 'player_joined',
          players: room.players.map(p => ({ id: p.id, name: p.name }))
        });
        break;
      }

      case 'start_game': {
        if (!currentRoom) break;
        if (currentRoom.players.length < 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'Need at least 2 players' }));
          break;
        }
        if (currentRoom.players[0].id !== playerId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Only the host can start the game' }));
          break;
        }
        startGame(currentRoom);
        break;
      }

      case 'draw_card': {
        if (!currentRoom || currentRoom.state !== 'playing') break;
        if (currentRoom.players[currentRoom.currentPlayerIndex].id !== playerId) break;
        if (currentRoom.turnPhase !== 'draw') break;
        if (currentRoom.deck.length === 0) {
          const topDiscard = currentRoom.discardPile.pop();
          currentRoom.deck = shuffle(currentRoom.discardPile);
          currentRoom.discardPile = [topDiscard];
        }

        const card = currentRoom.deck.pop();
        currentRoom.drawnCard = card;

        const special = getSpecialType(card);
        if (special) {
          currentRoom.turnPhase = 'decide_special';
        } else {
          currentRoom.turnPhase = 'swap_or_discard';
        }

        // Send drawn card to the player
        sendToPlayer(currentRoom, playerId, {
          type: 'card_drawn',
          card,
          special: special || null,
          canUseSpecial: !!special
        });

        // Tell others someone drew and broadcast updated phase
        broadcastToRoom(currentRoom, {
          type: 'player_drew',
          playerId
        }, playerId);

        // Broadcast updated game state so everyone has current turnPhase
        broadcastGameState(currentRoom);
        break;
      }

      case 'use_special': {
        if (!currentRoom || currentRoom.turnPhase !== 'decide_special') break;
        if (currentRoom.players[currentRoom.currentPlayerIndex].id !== playerId) break;

        const special = getSpecialType(currentRoom.drawnCard);
        currentRoom.turnPhase = 'special_action';
        currentRoom.specialAction = { type: special, step: 0, peekedCards: [] };

        sendToPlayer(currentRoom, playerId, {
          type: 'special_started',
          specialType: special
        });
        break;
      }

      case 'skip_special': {
        if (!currentRoom || currentRoom.turnPhase !== 'decide_special') break;
        if (currentRoom.players[currentRoom.currentPlayerIndex].id !== playerId) break;

        currentRoom.turnPhase = 'swap_or_discard';
        sendToPlayer(currentRoom, playerId, {
          type: 'special_skipped'
        });
        broadcastGameState(currentRoom);
        break;
      }

      case 'special_select': {
        if (!currentRoom || currentRoom.turnPhase !== 'special_action') break;
        if (currentRoom.players[currentRoom.currentPlayerIndex].id !== playerId) break;

        const action = currentRoom.specialAction;
        const targetPlayer = currentRoom.players.find(p => p.id === msg.targetPlayerId);
        if (!targetPlayer) break;

        const targetCard = targetPlayer.cards[msg.cardIndex];
        if (!targetCard) break; // null slot or invalid index

        switch (action.type) {
          case 'peek_own': {
            if (msg.targetPlayerId !== playerId) break;
            sendToPlayer(currentRoom, playerId, {
              type: 'peek_result',
              card: targetCard,
              targetPlayerId: msg.targetPlayerId,
              cardIndex: msg.cardIndex
            });
            autoDiscardAfterSpecial(currentRoom);
            break;
          }

          case 'peek_opponent': {
            if (msg.targetPlayerId === playerId) break;
            sendToPlayer(currentRoom, playerId, {
              type: 'peek_result',
              card: targetCard,
              targetPlayerId: msg.targetPlayerId,
              cardIndex: msg.cardIndex
            });
            autoDiscardAfterSpecial(currentRoom);
            break;
          }

          case 'blind_swap': {
            if (action.step === 0) {
              if (msg.targetPlayerId !== playerId) {
                sendToPlayer(currentRoom, playerId, { type: 'error', message: 'Pick your own card first' });
                break;
              }
              action.ownCardIndex = msg.cardIndex;
              action.step = 1;
              sendToPlayer(currentRoom, playerId, {
                type: 'special_progress',
                message: "Now pick an opponent's card to swap with"
              });
            } else {
              if (msg.targetPlayerId === playerId) {
                sendToPlayer(currentRoom, playerId, { type: 'error', message: "Pick an opponent's card" });
                break;
              }
              const myCards = currentRoom.players.find(p => p.id === playerId).cards;
              const myCard = myCards[action.ownCardIndex];
              const theirCard = targetPlayer.cards[msg.cardIndex];

              myCards[action.ownCardIndex] = theirCard;
              targetPlayer.cards[msg.cardIndex] = myCard;

              broadcastToRoom(currentRoom, {
                type: 'swap_occurred',
                player1Id: playerId,
                player2Id: msg.targetPlayerId,
                message: `${currentRoom.players.find(p => p.id === playerId).name} did a blind swap!`
              });

              autoDiscardAfterSpecial(currentRoom);
            }
            break;
          }

          case 'peek_swap': {
            if (action.step === 0) {
              action.peekedCard = { playerId: msg.targetPlayerId, cardIndex: msg.cardIndex };
              action.step = 1;
              sendToPlayer(currentRoom, playerId, {
                type: 'peek_result',
                card: targetCard,
                targetPlayerId: msg.targetPlayerId,
                cardIndex: msg.cardIndex,
                canSwap: true
              });
            } else if (action.step === 1) {
              const peeked = action.peekedCard;
              const peekedPlayer = currentRoom.players.find(p => p.id === peeked.playerId);
              const peekedCard = peekedPlayer.cards[peeked.cardIndex];
              const swapCard = targetPlayer.cards[msg.cardIndex];

              peekedPlayer.cards[peeked.cardIndex] = swapCard;
              targetPlayer.cards[msg.cardIndex] = peekedCard;

              broadcastToRoom(currentRoom, {
                type: 'swap_occurred',
                player1Id: peeked.playerId,
                player2Id: msg.targetPlayerId,
                message: `${currentRoom.players.find(p => p.id === playerId).name} used Queen to swap!`
              });

              autoDiscardAfterSpecial(currentRoom);
            }
            break;
          }

          case 'peek_two_swap': {
            if (action.step === 0) {
              action.peekedCards.push({ playerId: msg.targetPlayerId, cardIndex: msg.cardIndex, card: targetCard });
              sendToPlayer(currentRoom, playerId, {
                type: 'peek_result',
                card: targetCard,
                targetPlayerId: msg.targetPlayerId,
                cardIndex: msg.cardIndex,
                peekNumber: 1
              });
              action.step = 1;
              sendToPlayer(currentRoom, playerId, {
                type: 'special_progress',
                message: 'Pick a second card to peek at'
              });
            } else if (action.step === 1) {
              action.peekedCards.push({ playerId: msg.targetPlayerId, cardIndex: msg.cardIndex, card: targetCard });
              sendToPlayer(currentRoom, playerId, {
                type: 'peek_result',
                card: targetCard,
                targetPlayerId: msg.targetPlayerId,
                cardIndex: msg.cardIndex,
                peekNumber: 2,
                canSwap: true
              });
              action.step = 2;
            }
            break;
          }
        }
        break;
      }

      case 'special_swap_confirm': {
        if (!currentRoom || currentRoom.turnPhase !== 'special_action') break;
        if (currentRoom.players[currentRoom.currentPlayerIndex].id !== playerId) break;

        const act = currentRoom.specialAction;

        if (act.type === 'peek_two_swap' && act.step === 2) {
          const card1Info = act.peekedCards[0];
          const card2Info = act.peekedCards[1];
          const player1 = currentRoom.players.find(p => p.id === card1Info.playerId);
          const player2 = currentRoom.players.find(p => p.id === card2Info.playerId);

          const temp = player1.cards[card1Info.cardIndex];
          player1.cards[card1Info.cardIndex] = player2.cards[card2Info.cardIndex];
          player2.cards[card2Info.cardIndex] = temp;

          broadcastToRoom(currentRoom, {
            type: 'swap_occurred',
            player1Id: card1Info.playerId,
            player2Id: card2Info.playerId,
            message: `${currentRoom.players.find(p => p.id === playerId).name} used Black King to swap!`
          });
        }

        autoDiscardAfterSpecial(currentRoom);
        break;
      }

      case 'special_skip_swap': {
        if (!currentRoom || currentRoom.turnPhase !== 'special_action') break;
        if (currentRoom.players[currentRoom.currentPlayerIndex].id !== playerId) break;

        autoDiscardAfterSpecial(currentRoom);
        break;
      }

      case 'swap_card': {
        if (!currentRoom || currentRoom.turnPhase !== 'swap_or_discard') break;
        if (currentRoom.players[currentRoom.currentPlayerIndex].id !== playerId) break;

        const me = currentRoom.players.find(p => p.id === playerId);
        const oldCard = me.cards[msg.cardIndex];
        me.cards[msg.cardIndex] = currentRoom.drawnCard;
        currentRoom.discardPile.push(oldCard);
        currentRoom.drawnCard = null;

        // Enter stick window
        currentRoom.turnPhase = 'stick_window';

        broadcastToRoom(currentRoom, {
          type: 'card_discarded',
          card: oldCard,
          playerId,
          action: 'swap'
        });

        broadcastToRoom(currentRoom, { type: 'stick_window_open', card: oldCard });
        broadcastGameState(currentRoom);

        setTimeout(() => {
          if (currentRoom.turnPhase === 'stick_window') {
            broadcastToRoom(currentRoom, { type: 'stick_window_closed' });
            nextTurn(currentRoom);
          }
        }, 5000);
        break;
      }

      case 'discard_drawn': {
        if (!currentRoom || currentRoom.turnPhase !== 'swap_or_discard') break;
        if (currentRoom.players[currentRoom.currentPlayerIndex].id !== playerId) break;

        const card = currentRoom.drawnCard;
        currentRoom.discardPile.push(card);
        currentRoom.drawnCard = null;

        // Enter stick window
        currentRoom.turnPhase = 'stick_window';

        broadcastToRoom(currentRoom, {
          type: 'card_discarded',
          card,
          playerId,
          action: 'discard'
        });

        broadcastToRoom(currentRoom, { type: 'stick_window_open', card });
        broadcastGameState(currentRoom);

        setTimeout(() => {
          if (currentRoom.turnPhase === 'stick_window') {
            broadcastToRoom(currentRoom, { type: 'stick_window_closed' });
            nextTurn(currentRoom);
          }
        }, 5000);
        break;
      }

      case 'stick': {
        if (!currentRoom || currentRoom.turnPhase !== 'stick_window') break;

        const sticker = currentRoom.players.find(p => p.id === playerId);
        if (!sticker) break;

        const topDiscard = currentRoom.discardPile[currentRoom.discardPile.length - 1];
        const targetP = currentRoom.players.find(p => p.id === msg.targetPlayerId);
        if (!targetP) break;

        const stickCard = targetP.cards[msg.cardIndex];
        if (!stickCard) break;

        if (getCardNumericValue(stickCard) === getCardNumericValue(topDiscard)) {
          // Replace with null to keep grid shape
          targetP.cards[msg.cardIndex] = null;
          currentRoom.discardPile.push(stickCard);

          if (msg.targetPlayerId !== playerId && msg.giveCardIndex !== undefined) {
            const giveCard = sticker.cards[msg.giveCardIndex];
            if (giveCard) {
              sticker.cards[msg.giveCardIndex] = null;
              // Place the given card in the empty slot
              const emptySlot = targetP.cards.indexOf(null);
              if (emptySlot !== -1) {
                targetP.cards[emptySlot] = giveCard;
              } else {
                targetP.cards.push(giveCard);
              }
            }
          }

          broadcastToRoom(currentRoom, {
            type: 'stick_success',
            stickerId: playerId,
            stickerName: sticker.name,
            targetPlayerId: msg.targetPlayerId,
            card: stickCard,
            isOwnCard: msg.targetPlayerId === playerId
          });

          currentRoom.turnPhase = 'done';
          broadcastToRoom(currentRoom, { type: 'stick_window_closed' });
          nextTurn(currentRoom);
        } else {
          if (currentRoom.deck.length > 0) {
            const penaltyCard = currentRoom.deck.pop();
            penaltyCard.faceUp = false;
            sticker.cards.push(penaltyCard);
          }
          sendToPlayer(currentRoom, playerId, {
            type: 'stick_failed',
            message: 'Wrong match! You drew a penalty card.'
          });
          broadcastToRoom(currentRoom, {
            type: 'stick_penalty',
            playerId,
            playerName: sticker.name
          }, playerId);
          broadcastGameState(currentRoom);
        }
        break;
      }

      case 'call_kaboom': {
        if (!currentRoom || currentRoom.state !== 'playing') break;
        if (currentRoom.players[currentRoom.currentPlayerIndex].id !== playerId) break;
        if (currentRoom.kaboomCallerId !== null) break;
        if (currentRoom.turnPhase !== 'draw') break;

        currentRoom.kaboomCallerId = playerId;
        currentRoom.finalTurnsRemaining = currentRoom.players.length - 1;

        broadcastToRoom(currentRoom, {
          type: 'kaboom_called',
          playerId,
          playerName: currentRoom.players.find(p => p.id === playerId).name
        });

        nextTurn(currentRoom);
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      const player = currentRoom.players.find(p => p.id === playerId);
      if (player) {
        player.connected = false;
        player.ws = null;
        broadcastToRoom(currentRoom, {
          type: 'player_disconnected',
          playerId,
          playerName: player.name
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Kaboom server running on http://localhost:${PORT}`);
});
