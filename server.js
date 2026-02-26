require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
const crypto = require('crypto');
const { Pool } = require('pg');

// ============ DATABASE CONNECTION ============

// This connects to your PostgreSQL database on Railway.
// Pool means "keep a few connections ready" — like having
// several phone lines open to the database instead of 
// dialing fresh each time.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ============ CREATE TABLES ============

// This runs once when the server starts.
// IF NOT EXISTS means "only create it if it's not already there"
// — safe to run over and over.
async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shuffles (
      id SERIAL PRIMARY KEY,
      cards TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database table ready.');
}

// ============ THE DECK ============

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(rank + suit);
    }
  }
  return deck;
}

// ============ FACTORY ORDER ============

// A brand-new Bicycle deck comes in this exact order:
// Spades A-K, Diamonds A-K, Clubs K-A, Hearts K-A
// (Spades and Diamonds ascend, Clubs and Hearts descend)
const FACTORY_ORDER = [
  'A♠','2♠','3♠','4♠','5♠','6♠','7♠','8♠','9♠','10♠','J♠','Q♠','K♠',
  'A♦','2♦','3♦','4♦','5♦','6♦','7♦','8♦','9♦','10♦','J♦','Q♦','K♦',
  'K♣','Q♣','J♣','10♣','9♣','8♣','7♣','6♣','5♣','4♣','3♣','2♣','A♣',
  'K♥','Q♥','J♥','10♥','9♥','8♥','7♥','6♥','5♥','4♥','3♥','2♥','A♥',
];

function countFactoryPositions(deck) {
  let count = 0;
  for (let i = 0; i < deck.length; i++) {
    if (deck[i] === FACTORY_ORDER[i]) {
      count++;
    }
  }
  return count;
}

// ============ THE SHUFFLE ============

function shuffle(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const randomBytes = crypto.randomBytes(4);
    const randomNumber = randomBytes.readUInt32BE(0);
    const j = randomNumber % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// ============ THE COMPARISON ============

function countMatches(deckA, deckB) {
  let matches = 0;
  const matchedPositions = [];
  for (let i = 0; i < deckA.length; i++) {
    if (deckA[i] === deckB[i]) {
      matches++;
      matchedPositions.push(i);
    }
  }
  return { matches, matchedPositions };
}

function findClosestMatch(newDeck, allShuffles) {
  let bestMatch = null;
  let bestCount = -1;
  let bestPositions = [];

  for (const stored of allShuffles) {
    const theirCards = JSON.parse(stored.cards);
    const { matches, matchedPositions } = countMatches(newDeck, theirCards);
    if (matches > bestCount) {
      bestCount = matches;
      bestMatch = stored;
      bestPositions = matchedPositions;
    }
  }

  return { matchCount: bestCount, matchedShuffle: bestMatch, matchedPositions: bestPositions };
}

// ============ ROUTES ============

app.get('/', (req, res) => {
  res.json({
    name: 'Shuffled',
    tagline: 'The odds say never.',
    status: 'running',
  });
});

app.get('/api/shuffle', async (req, res) => {
  try {
    const deck = createDeck();
    const shuffled = shuffle(deck);

    // Get all previous shuffles from the database
    const existing = await pool.query('SELECT id, cards, created_at FROM shuffles');

    let result;
    if (existing.rows.length === 0) {
      result = {
        shuffle: { cards: shuffled, timestamp: new Date().toISOString() },
        match: null,
        factoryCount: countFactoryPositions(shuffled),
        message: 'First shuffle ever! Nothing to compare against yet.',
      };
    } else {
      const { matchCount, matchedShuffle, matchedPositions } = findClosestMatch(shuffled, existing.rows);
      result = {
        shuffle: { cards: shuffled, timestamp: new Date().toISOString() },
        match: {
          positions: matchCount,
          outOf: 52,
          matchedWithShuffle: matchedShuffle.id,
          matchedAt: matchedShuffle.created_at,
          matchedPositions: matchedPositions,
        },
        factoryCount: countFactoryPositions(shuffled),
      };
    }

    // Save to database — this one survives restarts!
    await pool.query(
      'INSERT INTO shuffles (cards) VALUES ($1)',
      [JSON.stringify(shuffled)]
    );

    // Add the new total count
    result.totalShuffles = existing.rows.length + 1;

    res.json(result);
  } catch (error) {
    console.error('Shuffle error:', error);
    res.status(500).json({ error: 'Something went wrong generating your shuffle.' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const count = await pool.query('SELECT COUNT(*) FROM shuffles');
    const total = parseInt(count.rows[0].count);
    res.json({
      totalShuffles: total,
      message: total === 0
        ? 'No shuffles yet. Be the first!'
        : `${total} shuffle${total === 1 ? '' : 's'} in the experiment.`,
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Could not fetch stats.' });
  }
});

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;

async function start() {
  await setupDatabase();
  app.listen(PORT, () => {
    console.log(`Shuffled is running at http://localhost:${PORT}`);
  });
}

start();
