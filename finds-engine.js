// ============================================================
// FINDS DETECTION ENGINE — finds-engine.js
// ============================================================
// Scans a shuffled deck for patterns ("finds") from the catalogue.
//
// Think of this like a quality inspector on a production line:
// each deck passes through multiple scanners, and each scanner
// looks for a different kind of pattern.
//
// The main function is detectFinds(deck) at the bottom.
// Everything above it is helper tools and individual scanners.
// ============================================================

// ============ CARD HELPERS ============
// Given a card string like "A♠" or "10♥", these extract useful info.
// Every scanner uses these — they're the shared toolkit.

const SUIT_NAMES = { '♠': 'Spades', '♥': 'Hearts', '♦': 'Diamonds', '♣': 'Clubs' };

function parseCard(card) {
  const suit = card.slice(-1);           // Last character: ♠, ♥, ♦, or ♣
  const rank = card.slice(0, -1);        // Everything before: A, 2, ..., 10, J, Q, K
  const color = (suit === '♥' || suit === '♦') ? 'red' : 'black';

  // Numeric value for detecting sequences (A=1, 2=2, ..., K=13)
  const valueMap = { 'A': 1, 'J': 11, 'Q': 12, 'K': 13 };
  const value = valueMap[rank] || parseInt(rank);

  return { rank, suit, color, value, original: card };
}

// "K" → "Kings", "7" → "7s", "A" → "Aces"
function rankPlural(rank) {
  const names = {
    'A': 'Aces', '2': '2s', '3': '3s', '4': '4s', '5': '5s',
    '6': '6s', '7': '7s', '8': '8s', '9': '9s', '10': '10s',
    'J': 'Jacks', 'Q': 'Queens', 'K': 'Kings',
  };
  return names[rank] || rank;
}

// Does this card count as a 10-value for Blackjack? (10, J, Q, K)
function isTenValue(parsedCard) {
  return parsedCard.value >= 10;
}

// ============ RARITY COLOURS ============
// Each rarity band gets a colour for the FindsBar badge.

const RARITY_COLORS = {
  'Common':        '#6b7280',  // Grey
  'Uncommon':      '#34d399',  // Green
  'Rare':          '#60a5fa',  // Blue
  'Very Rare':     '#a78bfa',  // Purple
  'Extraordinary': '#fb7185',  // Rose/Pink
  'Legendary':     '#fbbf24',  // Gold
};

// ============ FACTORY ORDER ============
// A brand-new Bicycle deck comes in this exact order.
// Used by the Factory Run detector (and by server.js for factory position count).

const FACTORY_ORDER = [
  'A♠','2♠','3♠','4♠','5♠','6♠','7♠','8♠','9♠','10♠','J♠','Q♠','K♠',
  'A♦','2♦','3♦','4♦','5♦','6♦','7♦','8♦','9♦','10♦','J♦','Q♦','K♦',
  'K♣','Q♣','J♣','10♣','9♣','8♣','7♣','6♣','5♣','4♣','3♣','2♣','A♣',
  'K♥','Q♥','J♥','10♥','9♥','8♥','7♥','6♥','5♥','4♥','3♥','2♥','A♥',
];


// ============================================================
// DETECTORS — One function per pattern family
// ============================================================
// Each detector scans the deck and returns an array of finds.
// A "find" looks like: { id, name, icon, color, rarity, positions }
//
// Detectors find MAXIMAL patterns only — the longest streak that
// can't be extended further. This naturally handles "best version
// only" within a single streak. (A 5-long suited streak won't
// also report the 3-long streak inside it.)
// ============================================================


// ──────────────────────────────────────────────
// DETECTOR: Same-Rank Groups → Pair, Triple, Quad
// ──────────────────────────────────────────────
// Scans for adjacent cards of the same rank.
// "Adjacent" means next to each other in the shuffled deck.
//
// Example: [..., 7♠, 7♥, 7♦, ...] → Triple of 7s at those positions
// ──────────────────────────────────────────────

function detectSameRankGroups(parsed) {
  const finds = [];
  let i = 0;

  while (i < parsed.length) {
    // How far does this same-rank group extend?
    let j = i + 1;
    while (j < parsed.length && parsed[j].rank === parsed[i].rank) {
      j++;
    }

    const groupSize = j - i;
    const positions = [];
    for (let k = i; k < j; k++) positions.push(k);
    const rank = parsed[i].rank;

    // Only the BEST version: Quad beats Triple beats Pair
    if (groupSize >= 4) {
      finds.push({
        id: 'quad', name: `Quad ${rankPlural(rank)}`,
        icon: '🃏', color: RARITY_COLORS['Very Rare'],
        rarity: 'Very Rare', positions,
      });
    } else if (groupSize >= 3) {
      finds.push({
        id: 'triple', name: `Triple ${rankPlural(rank)}`,
        icon: '🃏', color: RARITY_COLORS['Uncommon'],
        rarity: 'Uncommon', positions,
      });
    } else if (groupSize >= 2) {
      finds.push({
        id: 'pair', name: `Pair of ${rankPlural(rank)}`,
        icon: '🃏', color: RARITY_COLORS['Common'],
        rarity: 'Common', positions,
      });
    }

    i = j; // Jump past this group
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Suited Streaks → Suited 3/4/5/6/7/8
// ──────────────────────────────────────────────
// Consecutive cards of the same suit.
// ──────────────────────────────────────────────

function detectSuitedStreaks(parsed) {
  const finds = [];
  let start = 0;

  for (let i = 1; i <= parsed.length; i++) {
    // Does this card continue the streak?
    const continues = i < parsed.length && parsed[i].suit === parsed[start].suit;

    if (!continues) {
      const len = i - start;
      if (len >= 3) {
        const positions = [];
        for (let k = start; k < i; k++) positions.push(k);
        const suitName = SUIT_NAMES[parsed[start].suit];
        const suitIcon = parsed[start].suit;

        // Map length to the correct find tier
        // 3=Common, 4=Uncommon, 5=Rare, 6=Rare, 7=Very Rare, 8+=Extraordinary
        let id, name, rarity;
        if (len >= 8) {
          id = 'suited-8'; name = `8+ ${suitName}`;
          rarity = 'Extraordinary';
        } else if (len >= 7) {
          id = 'suited-7'; name = `7 ${suitName}`;
          rarity = 'Very Rare';
        } else if (len >= 6) {
          id = 'suited-6'; name = `6 ${suitName}`;
          rarity = 'Rare';
        } else if (len >= 5) {
          id = 'suited-5'; name = `5 ${suitName}`;
          rarity = 'Rare';
        } else if (len >= 4) {
          id = 'suited-4'; name = `4 ${suitName}`;
          rarity = 'Uncommon';
        } else {
          id = 'suited-3'; name = `3 ${suitName}`;
          rarity = 'Common';
        }

        finds.push({
          id, name, icon: suitIcon,
          color: RARITY_COLORS[rarity], rarity, positions,
        });
      }
      start = i;
    }
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Rank Runs → Run of 3/4, Straight (5), Run of 6/7
// ──────────────────────────────────────────────
// Consecutive cards in ascending rank order.
// Example: 5, 6, 7, 8 → Run of 4
//
// Special case: Ace can be high (Q, K, A) to complete
// a run. We handle this by checking if a run ending on
// King has an Ace immediately after it.
// ──────────────────────────────────────────────

function detectRuns(parsed) {
  const finds = [];
  let start = 0;

  for (let i = 1; i <= parsed.length; i++) {
    const continues = i < parsed.length &&
      parsed[i].value === parsed[i - 1].value + 1;

    if (!continues) {
      let len = i - start;
      let end = i; // exclusive end

      // Ace-high extension: if the run ends on K and next card is A,
      // the Ace acts as 14 and extends the run by one.
      if (end < parsed.length &&
          parsed[end - 1].value === 13 &&
          parsed[end].rank === 'A') {
        len++;
        end++;
      }

      if (len >= 3) {
        const positions = [];
        for (let k = start; k < end; k++) positions.push(k);

        // Map length to find tier
        // 3=Common, 4=Uncommon, 5=Rare(Straight), 6=Very Rare, 7+=Very Rare
        let id, name, rarity;
        if (len >= 7) {
          id = 'run-7'; name = `Run of ${len}`;
          rarity = 'Very Rare';
        } else if (len >= 6) {
          id = 'run-6'; name = `Run of 6`;
          rarity = 'Very Rare';
        } else if (len >= 5) {
          // 5-card run = "Straight" (poker terminology)
          id = 'straight'; name = 'Straight';
          rarity = 'Rare';
        } else if (len >= 4) {
          id = 'run-4'; name = 'Run of 4';
          rarity = 'Uncommon';
        } else {
          id = 'run-3'; name = 'Run of 3';
          rarity = 'Common';
        }

        finds.push({
          id, name, icon: '📈',
          color: RARITY_COLORS[rarity], rarity, positions,
        });
      }

      start = end; // Start the next potential run after this one
      i = end;     // Adjust loop counter (the for-loop will i++ next)
    }
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Colour Streaks → 6, 8, 10
// ──────────────────────────────────────────────
// Consecutive cards of the same colour (red or black).
// ──────────────────────────────────────────────

function detectColourStreaks(parsed) {
  const finds = [];
  let start = 0;

  for (let i = 1; i <= parsed.length; i++) {
    const continues = i < parsed.length && parsed[i].color === parsed[start].color;

    if (!continues) {
      const len = i - start;
      if (len >= 6) {
        const positions = [];
        for (let k = start; k < i; k++) positions.push(k);
        const colorName = parsed[start].color === 'red' ? 'Red' : 'Black';

        let id, name, rarity;
        if (len >= 10) {
          id = 'colour-10'; name = `${colorName} Streak of ${len}`;
          rarity = 'Very Rare';
        } else if (len >= 8) {
          id = 'colour-8'; name = `${colorName} Streak of ${len}`;
          rarity = 'Rare';
        } else {
          id = 'colour-6'; name = `${colorName} Streak of ${len}`;
          rarity = 'Uncommon';
        }

        finds.push({
          id, name, icon: parsed[start].color === 'red' ? '🔴' : '⚫',
          color: RARITY_COLORS[rarity], rarity, positions,
        });
      }
      start = i;
    }
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Alternating Colour → 7, 10
// ──────────────────────────────────────────────
// Cards alternating red-black-red-black (or black-red-black-red).
// ──────────────────────────────────────────────

function detectAlternating(parsed) {
  const finds = [];
  let start = 0;

  for (let i = 1; i <= parsed.length; i++) {
    const continues = i < parsed.length && parsed[i].color !== parsed[i - 1].color;

    if (!continues) {
      const len = i - start;
      if (len >= 7) {
        const positions = [];
        for (let k = start; k < i; k++) positions.push(k);

        let id, name, rarity;
        if (len >= 10) {
          id = 'alternating-10'; name = `Alternating ${len}`;
          rarity = 'Very Rare';
        } else {
          id = 'alternating-7'; name = `Alternating ${len}`;
          rarity = 'Rare';
        }

        finds.push({
          id, name, icon: '🎭',
          color: RARITY_COLORS[rarity], rarity, positions,
        });
      }
      start = i;
    }
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Blackjack Family → Basic, Suited, Perfect
// ──────────────────────────────────────────────
// Ace adjacent to a 10-value card (10, J, Q, K).
// Suited: same suit. Perfect: specifically A♠ next to J♠.
//
// "Best version only": Perfect beats Suited beats Basic.
// We scan all adjacent pairs, then keep only the best
// version found at each position.
// ──────────────────────────────────────────────

function detectBlackjack(parsed) {
  const finds = [];

  for (let i = 0; i < parsed.length - 1; i++) {
    const a = parsed[i];
    const b = parsed[i + 1];

    // Is this an Ace + 10-value pair? (either order)
    let ace, ten;
    if (a.rank === 'A' && isTenValue(b)) { ace = a; ten = b; }
    else if (b.rank === 'A' && isTenValue(a)) { ace = b; ten = a; }
    else continue; // Not a blackjack pair

    const positions = [i, i + 1];

    // Check for Perfect Blackjack first (most specific)
    if (ace.original === 'A♠' && ten.original === 'J♠') {
      finds.push({
        id: 'perfect-blackjack', name: 'Perfect Blackjack',
        icon: '🂡', color: RARITY_COLORS['Rare'],
        rarity: 'Rare', positions,
      });
    }
    // Then Suited Blackjack
    else if (ace.suit === ten.suit) {
      finds.push({
        id: 'suited-blackjack', name: 'Suited Blackjack',
        icon: '🂡', color: RARITY_COLORS['Uncommon'],
        rarity: 'Uncommon', positions,
      });
    }
    // Basic Blackjack
    else {
      finds.push({
        id: 'blackjack', name: 'Blackjack',
        icon: '🂡', color: RARITY_COLORS['Common'],
        rarity: 'Common', positions,
      });
    }
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Counting Finds → Three Pairs, Two Triples, Two Quads
// ──────────────────────────────────────────────
// These count how many of a certain group exist across
// the WHOLE shuffle (not just at one spot).
// We reuse the results from detectSameRankGroups.
// ──────────────────────────────────────────────

function detectCountingFinds(sameRankResults) {
  const finds = [];

  const pairs = sameRankResults.filter(f => f.id === 'pair');
  const triples = sameRankResults.filter(f => f.id === 'triple');
  const quads = sameRankResults.filter(f => f.id === 'quad');

  // "Three Pairs" means 3 or more separate pairs
  // (Triples and Quads don't count as pairs for this purpose)
  if (pairs.length >= 3) {
    // Collect all pair positions into one find
    const allPositions = pairs.flatMap(f => f.positions);
    finds.push({
      id: 'three-pairs', name: `${pairs.length} Pairs`,
      icon: '🃏', color: RARITY_COLORS['Uncommon'],
      rarity: 'Uncommon', positions: allPositions,
    });
  }

  if (triples.length >= 2) {
    const allPositions = triples.flatMap(f => f.positions);
    finds.push({
      id: 'two-triples', name: 'Two Triples',
      icon: '🃏', color: RARITY_COLORS['Rare'],
      rarity: 'Rare', positions: allPositions,
    });
  }

  if (quads.length >= 2) {
    const allPositions = quads.flatMap(f => f.positions);
    finds.push({
      id: 'two-quads', name: 'Two Quads',
      icon: '🃏', color: RARITY_COLORS['Extraordinary'],
      rarity: 'Extraordinary', positions: allPositions,
    });
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Mirror → Rank-mirrored pairs at symmetric positions
// ──────────────────────────────────────────────
// Position 0 and 51 have the same rank? That's a mirror.
// Position 1 and 50? Another mirror. 3+ of these = Mirror find.
// ──────────────────────────────────────────────

function detectMirror(parsed) {
  const mirrorPositions = [];

  for (let i = 0; i < 26; i++) {
    const opposite = 51 - i;
    if (parsed[i].rank === parsed[opposite].rank) {
      mirrorPositions.push(i, opposite);
    }
  }

  const mirrorCount = mirrorPositions.length / 2; // Each mirror is a pair of positions

  if (mirrorCount >= 3) {
    return [{
      id: 'mirror', name: `${mirrorCount} Mirrors`,
      icon: '🪞', color: RARITY_COLORS['Uncommon'],
      rarity: 'Uncommon', positions: mirrorPositions,
    }];
  }

  return [];
}


// ──────────────────────────────────────────────
// DETECTOR: Two Pair Pattern → AABB in 4 consecutive
// ──────────────────────────────────────────────
// Not the same as "Three Pairs" (which counts pairs across
// the whole deck). This is specifically the poker hand:
// two different pairs side by side in 4 consecutive cards.
// ──────────────────────────────────────────────

function detectTwoPairPattern(parsed) {
  const finds = [];

  for (let i = 0; i <= parsed.length - 4; i++) {
    const ranks = [parsed[i].rank, parsed[i+1].rank, parsed[i+2].rank, parsed[i+3].rank];

    // AABB pattern: first two match, last two match, but the two pairs differ
    if (ranks[0] === ranks[1] && ranks[2] === ranks[3] && ranks[0] !== ranks[2]) {
      finds.push({
        id: 'two-pair', name: 'Two Pair',
        icon: '🃏', color: RARITY_COLORS['Rare'],
        rarity: 'Rare', positions: [i, i+1, i+2, i+3],
      });
    }
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Full House → AAABB or AABBB in 5 consecutive
// ──────────────────────────────────────────────

function detectFullHouse(parsed) {
  const finds = [];

  for (let i = 0; i <= parsed.length - 5; i++) {
    const ranks = [];
    for (let k = 0; k < 5; k++) ranks.push(parsed[i + k].rank);

    // AAABB: first 3 match, last 2 match, groups differ
    const isAAABB = ranks[0] === ranks[1] && ranks[1] === ranks[2] &&
                    ranks[3] === ranks[4] && ranks[0] !== ranks[3];

    // AABBB: first 2 match, last 3 match, groups differ
    const isAABBB = ranks[0] === ranks[1] &&
                    ranks[2] === ranks[3] && ranks[3] === ranks[4] &&
                    ranks[0] !== ranks[2];

    if (isAAABB || isAABBB) {
      finds.push({
        id: 'full-house', name: 'Full House',
        icon: '🏠', color: RARITY_COLORS['Very Rare'],
        rarity: 'Very Rare', positions: [i, i+1, i+2, i+3, i+4],
      });
    }
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Straight Flush & Royal Flush
// ──────────────────────────────────────────────
// Straight Flush: 5 consecutive cards in rank order AND same suit.
// Royal Flush: specifically 10-J-Q-K-A, same suit, consecutive.
//
// We look for runs that are also suited. A Royal Flush
// is a special case of a Straight Flush, so "best version only"
// means Royal replaces Straight Flush at the same positions.
// ──────────────────────────────────────────────

function detectStraightFlush(parsed) {
  const finds = [];

  // Scan for ascending rank sequences that share a suit
  let start = 0;

  for (let i = 1; i <= parsed.length; i++) {
    const sameSuit = i < parsed.length && parsed[i].suit === parsed[start].suit;
    const ascending = i < parsed.length && parsed[i].value === parsed[i - 1].value + 1;
    // Ace-high: K followed by A of same suit
    const aceHigh = i < parsed.length &&
                    parsed[i - 1].value === 13 &&
                    parsed[i].rank === 'A' &&
                    parsed[i].suit === parsed[start].suit;

    const continues = sameSuit && (ascending || aceHigh);

    if (!continues) {
      let len = i - start;
      let end = i;

      // Check for ace-high extension (same as in detectRuns)
      if (end < parsed.length &&
          parsed[end - 1].value === 13 &&
          parsed[end].rank === 'A' &&
          parsed[end].suit === parsed[start].suit) {
        len++;
        end++;
      }

      if (len >= 5) {
        const positions = [];
        for (let k = start; k < end; k++) positions.push(k);

        // Is this a Royal Flush? (10-J-Q-K-A of same suit)
        const values = positions.map(p => parsed[p].value);
        const hasAceHigh = values.includes(1) && values.includes(13);
        const isRoyal = hasAceHigh && values.includes(10) && values.includes(11) && values.includes(12);

        if (isRoyal) {
          const suitName = SUIT_NAMES[parsed[start].suit];
          finds.push({
            id: 'royal-flush', name: `Royal Flush (${suitName})`,
            icon: '👑', color: RARITY_COLORS['Legendary'],
            rarity: 'Legendary', positions,
          });
        } else {
          finds.push({
            id: 'straight-flush', name: 'Straight Flush',
            icon: '⚡', color: RARITY_COLORS['Extraordinary'],
            rarity: 'Extraordinary', positions,
          });
        }
      }

      start = end;
      i = end;
    }
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Dead Man's Hand
// ──────────────────────────────────────────────
// Two Aces + two Eights in any order within 4 consecutive
// positions. Named after Wild Bill Hickok's final poker hand.
// ──────────────────────────────────────────────

function detectDeadMansHand(parsed) {
  const finds = [];

  for (let i = 0; i <= parsed.length - 4; i++) {
    const window = [parsed[i], parsed[i+1], parsed[i+2], parsed[i+3]];
    const aces = window.filter(c => c.rank === 'A').length;
    const eights = window.filter(c => c.rank === '8').length;

    if (aces === 2 && eights === 2) {
      finds.push({
        id: 'dead-mans-hand', name: "Dead Man's Hand",
        icon: '💀', color: RARITY_COLORS['Extraordinary'],
        rarity: 'Extraordinary', positions: [i, i+1, i+2, i+3],
      });
    }
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Solitaire Run
// ──────────────────────────────────────────────
// 5 consecutive cards that descend in rank AND alternate
// in colour — like building a Klondike solitaire column.
// Example: 9♠, 8♥, 7♣, 6♦, 5♠
// ──────────────────────────────────────────────

function detectSolitaire(parsed) {
  const finds = [];
  let start = 0;

  for (let i = 1; i <= parsed.length; i++) {
    const descending = i < parsed.length &&
      parsed[i].value === parsed[i - 1].value - 1;
    const alternates = i < parsed.length &&
      parsed[i].color !== parsed[i - 1].color;

    const continues = descending && alternates;

    if (!continues) {
      const len = i - start;
      if (len >= 5) {
        const positions = [];
        for (let k = start; k < i; k++) positions.push(k);
        finds.push({
          id: 'solitaire-5', name: `Solitaire ${len}`,
          icon: '🂠', color: RARITY_COLORS['Extraordinary'],
          rarity: 'Extraordinary', positions,
        });
      }
      start = i;
    }
  }

  return finds;
}


// ──────────────────────────────────────────────
// DETECTOR: Ace High → A♠ in position 0
// ──────────────────────────────────────────────

function detectAceHigh(parsed) {
  if (parsed[0].original === 'A♠') {
    return [{
      id: 'ace-high', name: 'Ace High',
      icon: '🂡', color: RARITY_COLORS['Rare'],
      rarity: 'Rare', positions: [0],
    }];
  }
  return [];
}


// ──────────────────────────────────────────────
// DETECTOR: Ascending Top Five
// ──────────────────────────────────────────────
// The first 5 cards of the shuffle are in ascending rank order.
// ──────────────────────────────────────────────

function detectAscendingTopFive(parsed) {
  if (parsed.length < 5) return [];

  let ascending = true;
  for (let i = 1; i < 5; i++) {
    if (parsed[i].value <= parsed[i - 1].value) {
      ascending = false;
      break;
    }
  }

  if (ascending) {
    return [{
      id: 'ascending-top-5', name: 'Ascending Top Five',
      icon: '⬆️', color: RARITY_COLORS['Extraordinary'],
      rarity: 'Extraordinary', positions: [0, 1, 2, 3, 4],
    }];
  }
  return [];
}


// ──────────────────────────────────────────────
// DETECTOR: Factory Run → 4+ consecutive cards in factory order
// ──────────────────────────────────────────────
// A "preserved fossil" — a block of the deck that survived
// the shuffle completely intact. Different from the factory
// position STAT, which counts individual scattered cards.
// ──────────────────────────────────────────────

function detectFactoryRun(deck) {
  const finds = [];
  let runStart = null;
  let runLen = 0;

  for (let i = 0; i < deck.length; i++) {
    if (deck[i] === FACTORY_ORDER[i]) {
      if (runLen === 0) runStart = i;
      runLen++;
    } else {
      if (runLen >= 4) {
        const positions = [];
        for (let k = runStart; k < runStart + runLen; k++) positions.push(k);
        finds.push({
          id: 'factory-run', name: `Factory Run of ${runLen}`,
          icon: '🏭', color: RARITY_COLORS['Extraordinary'],
          rarity: 'Extraordinary', positions,
        });
      }
      runLen = 0;
    }
  }

  // Don't forget to check the last run
  if (runLen >= 4) {
    const positions = [];
    for (let k = runStart; k < runStart + runLen; k++) positions.push(k);
    finds.push({
      id: 'factory-run', name: `Factory Run of ${runLen}`,
      icon: '🏭', color: RARITY_COLORS['Extraordinary'],
      rarity: 'Extraordinary', positions,
    });
  }

  return finds;
}


// ============================================================
// BEST VERSION ONLY — Suppress overlapping lower-tier finds
// ============================================================
// After all detectors run, we remove redundant lower-tier finds
// that overlap with a higher-tier find from the same family.
//
// Example: If positions 5-9 are a Suited Five (Rare), we don't
// also want to show a Suited Three at 5-7 (Common). But if
// there's a SEPARATE Suited Three at positions 30-32, that stays.
//
// We also suppress lower finds that are implied by higher ones:
// - Straight Flush implies Straight AND Suited 5+
// - Royal Flush implies Straight Flush AND Straight AND Suited 5+
// ============================================================

// Find families where higher versions replace lower ones
const SUPPRESSION_RULES = [
  // Straight Flush / Royal Flush suppress regular Straight and Suited streaks
  { winner: 'royal-flush', losers: ['straight-flush', 'straight', 'run-6', 'run-7',
    'suited-3', 'suited-4', 'suited-5', 'suited-6', 'suited-7', 'suited-8'] },
  { winner: 'straight-flush', losers: ['straight', 'run-6', 'run-7',
    'suited-3', 'suited-4', 'suited-5', 'suited-6', 'suited-7', 'suited-8'] },
  // Perfect Blackjack suppresses lesser Blackjacks
  { winner: 'perfect-blackjack', losers: ['suited-blackjack', 'blackjack'] },
  { winner: 'suited-blackjack', losers: ['blackjack'] },
  // Two Quads suppresses Two Triples
  { winner: 'two-quads', losers: ['two-triples'] },
];

function positionsOverlap(posA, posB) {
  const setA = new Set(posA);
  return posB.some(p => setA.has(p));
}

function applyBestVersionOnly(finds) {
  let filtered = [...finds];

  // Step 1: Counting finds suppress their individual members.
  // "3 Pairs" is more interesting than listing each pair separately.
  const hasThreePairs = filtered.some(f => f.id === 'three-pairs');
  const hasTwoTriples = filtered.some(f => f.id === 'two-triples');
  const hasTwoQuads = filtered.some(f => f.id === 'two-quads');

  if (hasThreePairs) filtered = filtered.filter(f => f.id !== 'pair');
  if (hasTwoTriples) filtered = filtered.filter(f => f.id !== 'triple');
  if (hasTwoQuads) filtered = filtered.filter(f => f.id !== 'quad');

  // Step 2: Apply explicit suppression rules (for cross-family overlaps)
  for (const rule of SUPPRESSION_RULES) {
    const winners = filtered.filter(f => f.id === rule.winner);
    if (winners.length === 0) continue;

    filtered = filtered.filter(f => {
      if (!rule.losers.includes(f.id)) return true;
      return !winners.some(w => positionsOverlap(w.positions, f.positions));
    });
  }

  // Step 3: Deduplicate — keep only the best instance of each find type.
  // Multiple "Pair of Kings" and "Pair of Aces" are both the "pair" find.
  // In the Trophy Cabinet, you collect "Pair" once, not per-rank.
  // Keep the instance with the most positions (longest/most interesting).
  const bestById = new Map();
  for (const find of filtered) {
    const existing = bestById.get(find.id);
    if (!existing || find.positions.length > existing.positions.length) {
      bestById.set(find.id, find);
    }
  }
  filtered = Array.from(bestById.values());

  return filtered;
}


// ============================================================
// MAIN FUNCTION — Run all detectors
// ============================================================

function detectFinds(deck) {
  const parsed = deck.map(parseCard);

  // Run every detector
  const sameRankResults = detectSameRankGroups(parsed);
  const suitedResults = detectSuitedStreaks(parsed);
  const runResults = detectRuns(parsed);
  const colourResults = detectColourStreaks(parsed);
  const alternatingResults = detectAlternating(parsed);
  const blackjackResults = detectBlackjack(parsed);
  const countingResults = detectCountingFinds(sameRankResults);
  const mirrorResults = detectMirror(parsed);
  const twoPairResults = detectTwoPairPattern(parsed);
  const fullHouseResults = detectFullHouse(parsed);
  const straightFlushResults = detectStraightFlush(parsed);
  const deadMansResults = detectDeadMansHand(parsed);
  const solitaireResults = detectSolitaire(parsed);
  const aceHighResults = detectAceHigh(parsed);
  const ascendingResults = detectAscendingTopFive(parsed);
  const factoryRunResults = detectFactoryRun(deck); // Uses raw deck, not parsed

  // Combine all results
  let allFinds = [
    ...sameRankResults,
    ...suitedResults,
    ...runResults,
    ...colourResults,
    ...alternatingResults,
    ...blackjackResults,
    ...countingResults,
    ...mirrorResults,
    ...twoPairResults,
    ...fullHouseResults,
    ...straightFlushResults,
    ...deadMansResults,
    ...solitaireResults,
    ...aceHighResults,
    ...ascendingResults,
    ...factoryRunResults,
  ];

  // Apply "best version only" filter
  allFinds = applyBestVersionOnly(allFinds);

  // Sort: rarest first, so the frontend can take the top N
  const rarityOrder = {
    'Legendary': 0, 'Extraordinary': 1, 'Very Rare': 2,
    'Rare': 3, 'Uncommon': 4, 'Common': 5,
  };
  allFinds.sort((a, b) => rarityOrder[a.rarity] - rarityOrder[b.rarity]);

  // Add isNew flag — always true for now (needs user identity later)
  allFinds.forEach(f => { f.isNew = true; });

  return allFinds;
}


// ============================================================
// EXPORTS — What server.js can import from this file
// ============================================================
// module.exports is how Node.js files share code.
// It's like putting items in a box that other files can open.
// server.js will do: const { detectFinds } = require('./finds-engine');

module.exports = {
  detectFinds,
  FACTORY_ORDER,
};
