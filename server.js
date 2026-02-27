require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const crypto = require('crypto');
const { Pool } = require('pg');
const { detectFinds, FACTORY_ORDER } = require('./finds-engine');

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW(),
      last_shuffle_date DATE,
      last_shuffle_id INTEGER,
      current_streak INTEGER DEFAULT 0,
      highest_match INTEGER DEFAULT 0,
      total_shuffles INTEGER DEFAULT 0
    )
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_shuffle_id INTEGER
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS current_streak INTEGER DEFAULT 0
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

// Now imported from finds-engine.js — shared between
// the finds detector (Factory Run) and the factory position counter here.

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

// ============ USER IDENTITY (COAT CHECK) ============

// "Middleware" = code that runs in the middle, between a request
// arriving and your route handling it. Like a receptionist who
// checks your coat check ticket before letting you into the office.
// This runs on EVERY request, automatically.

app.use(async (req, res, next) => {
  try {
    // Step A: Check if they already have a ticket (cookie)
    let userId = req.cookies.shuffled_user;

    if (userId) {
      // They showed a ticket — look them up in the database
      const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (result.rows.length > 0) {
        // Found them! Attach their info to the request
        // so our routes can use it later via req.user
        req.user = result.rows[0];
      } else {
        // They have a ticket, but we can't find them in our records.
        // Maybe the database was reset. Treat them as new.
        userId = null;
      }
    }

    if (!userId) {
      // Step B: New visitor — generate a random ticket
      // crypto.randomBytes(12) creates 12 random bytes,
      // .toString('hex') turns them into a 24-character string.
      // So a full ID looks like: usr_3a9f1c7e2b04d8a56f1e9c72
      userId = 'usr_' + crypto.randomBytes(12).toString('hex');

      // Create their row in the database
      await pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);

      // Send the cookie to their browser.
      // This is literally handing them the coat check ticket.
      res.cookie('shuffled_user', userId, {
        maxAge: 365 * 24 * 60 * 60 * 1000, // Lasts 1 year (in milliseconds)
        httpOnly: true,       // JavaScript on the page can't read it (security)
        secure: true,         // Only sent over HTTPS (Railway uses HTTPS)
        sameSite: 'none',     // Allow the cookie to be sent cross-origin
      });

      // Attach fresh user info so routes can use it immediately
      req.user = { id: userId, highest_match: 0, total_shuffles: 0 };
    }

    // "next()" means "I'm done, pass this request to the next handler."
    // Without this, the request would get stuck here forever.
    next();
  } catch (error) {
    console.error('User identity error:', error);
    // Still let the request through even if the cookie logic fails.
    // Better to serve the page without user data than to show an error.
    next();
  }
});

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
    // ============ ONE-PER-DAY CHECK ============
    // Has this person already shuffled today?
    // Compare their last_shuffle_date against today's date.
    const today = new Date().toISOString().split('T')[0]; // e.g. "2026-02-27"

    if (req.user && req.user.last_shuffle_date) {
      const lastDate = req.user.last_shuffle_date.toISOString().split('T')[0];

      if (lastDate === today) {
        // They already shuffled today! Return their existing shuffle
        // instead of generating a new one.
        const existingShuffle = await pool.query(
          'SELECT id, cards, created_at FROM shuffles WHERE id = $1',
          [req.user.last_shuffle_id]
        );

       if (existingShuffle.rows.length > 0) {
          const stored = existingShuffle.rows[0];
          const storedCards = JSON.parse(stored.cards);

          // Re-compute all the data for this shuffle so the frontend
          // gets the same complete response as the first time.
          const existing = await pool.query('SELECT id, cards, created_at FROM shuffles');
          const otherShuffles = existing.rows.filter(r => r.id !== stored.id);
          let matchResult = null;
          if (otherShuffles.length > 0) {
            matchResult = findClosestMatch(storedCards, otherShuffles);
          }

          const globalRecord = await pool.query(
            'SELECT highest_count, shuffle_a_id, shuffle_b_id, today_highest_count, today_date FROM records WHERE id = 1'
          );
          const global = globalRecord.rows[0];
          const todayCheck = new Date().toISOString().split('T')[0];
          const storedDateCheck = global.today_date.toISOString().split('T')[0];
          const todayCount = storedDateCheck === todayCheck ? global.today_highest_count : 0;

          return res.json({
            alreadyShuffledToday: true,
            shuffle: {
              id: stored.id,
              cards: storedCards,
              timestamp: stored.created_at,
            },
            match: matchResult ? {
              positions: matchResult.matchCount,
              outOf: 52,
              matchedWithShuffle: matchResult.matchedShuffle.id,
              matchedAt: matchResult.matchedShuffle.created_at,
              matchedPositions: matchResult.matchedPositions,
            } : null,
            factoryCount: countFactoryPositions(storedCards),
            finds: detectFinds(storedCards),
            globalHighest: {
              count: global.highest_count,
              shuffleA: global.shuffle_a_id,
              shuffleB: global.shuffle_b_id,
            },
            todayHighest: {
              count: todayCount,
            },
            totalShuffles: existing.rows.length,
            user: {
              yourHighest: req.user.highest_match,
              totalShuffles: req.user.total_shuffles,
              isNewPersonalBest: false,
              streak: req.user.current_streak,
            },
            message: 'You already shuffled today. Come back tomorrow!',
          });
        }
      }
    }
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

    // ============ UPDATE USER STATS ============
    // req.user was attached by the coat check middleware above.
    // Now we know their match count, so we can update their record.

    const matchCount = matchResult ? matchResult.matchCount : 0;
    const isNewPersonalBest = matchCount > req.user.highest_match;

    // Update their row: add 1 to total_shuffles, set today's date,
    // and if this match beat their personal best, update that too.
    // GREATEST(highest_match, $1) means "whichever is bigger, keep that one."
   // Calculate streak: was their last shuffle yesterday?
    let newStreak = 1; // Default: start a new streak
    if (req.user.last_shuffle_date) {
      const lastDate = new Date(req.user.last_shuffle_date);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      // Compare just the date parts (ignore time)
      if (lastDate.toISOString().split('T')[0] === yesterday.toISOString().split('T')[0]) {
        // They shuffled yesterday — streak continues!
        newStreak = req.user.current_streak + 1;
      }
    }

    await pool.query(
      `UPDATE users 
       SET total_shuffles = total_shuffles + 1,
           last_shuffle_date = CURRENT_DATE,
           last_shuffle_id = $3,
           current_streak = $4,
           highest_match = GREATEST(highest_match, $1)
       WHERE id = $2`,
      [matchCount, req.user.id, newShuffleId, newStreak]
    );

    // Build the response
    let result;
    if (!matchResult) {
      result = {
        shuffle: { id: newShuffleId, cards: shuffled, timestamp: new Date().toISOString() },
        match: null,
        factoryCount: countFactoryPositions(shuffled),
        finds: detectFinds(shuffled),
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
        finds: detectFinds(shuffled),
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

    // Attach this user's personal stats.
    // total_shuffles is +1 because we just incremented it above.
    result.user = {
      yourHighest: isNewPersonalBest ? matchCount : req.user.highest_match,
      totalShuffles: req.user.total_shuffles + 1,
      isNewPersonalBest: isNewPersonalBest,
      streak: newStreak,
    };

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
