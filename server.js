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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY DEFAULT 1,
      highest_count INTEGER DEFAULT 0,
      shuffle_a_id INTEGER,
      shuffle_b_id INTEGER,
      today_highest_count INTEGER DEFAULT 0,
      today_date DATE DEFAULT CURRENT_DATE
    )
  `);
  // Make sure there's always exactly one row in records.
  // INSERT ... ON CONFLICT DO NOTHING means:
  // "Add this row, but if it already exists, don't touch it."
  await pool.query(`
    INSERT INTO records (id, highest_count)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING
  `);
  console.log('Database tables ready.');
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

    // Find the closest match (before saving, so it doesn't compare against itself)
    let matchResult = null;
    if (existing.rows.length > 0) {
      matchResult = findClosestMatch(shuffled, existing.rows);
    }

    // Save to database — RETURNING id gets back the ID that PostgreSQL assigned.
    // Like dropping off a package and getting a tracking number back.
    const saved = await pool.query(
      'INSERT INTO shuffles (cards) VALUES ($1) RETURNING id',
      [JSON.stringify(shuffled)]
    );
    const newShuffleId = saved.rows[0].id;

    // If this match beats the global record, update it
    // Also track today's highest match
    if (matchResult && matchResult.matchCount > 0) {
      const currentRecord = await pool.query(
        'SELECT highest_count, today_highest_count, today_date FROM records WHERE id = 1'
      );
      const record = currentRecord.rows[0];

      // Check if it's a new day — if so, reset today's counter.
      // Like a scoreboard that wipes itself at midnight.
      const today = new Date().toISOString().split('T')[0]; // e.g. "2026-02-27"
      const isNewDay = record.today_date.toISOString().split('T')[0] !== today;
      const todayHighest = isNewDay ? 0 : record.today_highest_count;

      // Update global record if beaten
      const beatGlobal = matchResult.matchCount > record.highest_count;
      // Update today's record if beaten (or if it's a new day, anything beats 0)
      const beatToday = matchResult.matchCount > todayHighest;

      if (beatGlobal && beatToday) {
        await pool.query(
          `UPDATE records 
           SET highest_count = $1, shuffle_a_id = $2, shuffle_b_id = $3,
               today_highest_count = $1, today_date = $4
           WHERE id = 1`,
          [matchResult.matchCount, matchResult.matchedShuffle.id, newShuffleId, today]
        );
      } else if (beatGlobal) {
        await pool.query(
          'UPDATE records SET highest_count = $1, shuffle_a_id = $2, shuffle_b_id = $3 WHERE id = 1',
          [matchResult.matchCount, matchResult.matchedShuffle.id, newShuffleId]
        );
      } else if (beatToday) {
        await pool.query(
          'UPDATE records SET today_highest_count = $1, today_date = $2 WHERE id = 1',
          [matchResult.matchCount, today]
        );
      } else if (isNewDay) {
        // New day but didn't beat anything — still need to reset the date
        // and set today's count to this match (it's the first of the day)
        await pool.query(
          'UPDATE records SET today_highest_count = $1, today_date = $2 WHERE id = 1',
          [matchResult.matchCount, today]
        );
      }
    }

    // Read the current global record (whether we just updated it or not)
    const globalRecord = await pool.query(
      'SELECT highest_count, shuffle_a_id, shuffle_b_id, today_highest_count, today_date FROM records WHERE id = 1'
    );
    const global = globalRecord.rows[0];

    // Check if the stored today_date is actually today
    const todayStr = new Date().toISOString().split('T')[0];
    const storedDate = global.today_date.toISOString().split('T')[0];
    const todayCount = storedDate === todayStr ? global.today_highest_count : 0;

    // Build the response
    let result;
    if (!matchResult) {
      result = {
        shuffle: { id: newShuffleId, cards: shuffled, timestamp: new Date().toISOString() },
        match: null,
        factoryCount: countFactoryPositions(shuffled),
        globalHighest: {
          count: 0,
          shuffleA: null,
          shuffleB: null,
        },
        todayHighest: {
          count: 0,
        },
        message: 'First shuffle ever! Nothing to compare against yet.',
      };
    } else {
      result = {
        shuffle: { id: newShuffleId, cards: shuffled, timestamp: new Date().toISOString() },
        match: {
          positions: matchResult.matchCount,
          outOf: 52,
          matchedWithShuffle: matchResult.matchedShuffle.id,
          matchedAt: matchResult.matchedShuffle.created_at,
          matchedPositions: matchResult.matchedPositions,
        },
        factoryCount: countFactoryPositions(shuffled),
        globalHighest: {
          count: global.highest_count,
          shuffleA: global.shuffle_a_id,
          shuffleB: global.shuffle_b_id,
        },
        todayHighest: {
          count: todayCount,
        },
      };
    }

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
