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
// ============ FIND RARITY LOOKUP ============
// Maps each find ID to its rarity tier.
// Used by the achievement engine to check rarity-based achievements
// (like "first Rare find" or "finds from all 6 tiers").

const FIND_RARITY = {
  'pair': 'Common', 'suited-3': 'Common', 'blackjack': 'Common', 'run-3': 'Common',
  'three-pairs': 'Uncommon', 'suited-blackjack': 'Uncommon', 'colour-6': 'Uncommon',
  'suited-4': 'Uncommon', 'triple': 'Uncommon', 'mirror': 'Uncommon', 'run-4': 'Uncommon',
  'alternating-7': 'Rare', 'two-pair': 'Rare', 'colour-8': 'Rare', 'suited-5': 'Rare',
  'alternating-10': 'Rare', 'perfect-blackjack': 'Rare', 'straight': 'Rare', 'ace-high': 'Rare',
  'colour-10': 'Very Rare', 'full-house': 'Very Rare', 'suited-6': 'Very Rare',
  'two-triples': 'Very Rare', 'ascending-top-5': 'Very Rare', 'quad': 'Very Rare',
  'run-6': 'Very Rare', 'suited-7': 'Very Rare', 'run-7': 'Very Rare',
  'dead-mans-hand': 'Extraordinary', 'suited-8': 'Extraordinary', 'straight-flush': 'Extraordinary',
  'two-quads': 'Extraordinary', 'solitaire-5': 'Extraordinary', 'factory-run': 'Extraordinary',
  'royal-flush': 'Legendary',
};

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
   // --- New columns on shuffles table ---
  await pool.query(`ALTER TABLE shuffles ADD COLUMN IF NOT EXISTS country TEXT`);
  await pool.query(`ALTER TABLE shuffles ADD COLUMN IF NOT EXISTS city TEXT`);
  await pool.query(`ALTER TABLE shuffles ADD COLUMN IF NOT EXISTS local_hour INTEGER`);
  await pool.query(`ALTER TABLE shuffles ADD COLUMN IF NOT EXISTS user_id TEXT`);
  await pool.query(`ALTER TABLE shuffles ADD COLUMN IF NOT EXISTS match_count INTEGER`);

  // --- New column on users table ---
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_shuffle_date DATE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_match_count INTEGER`);

  // --- User Finds: "User X discovered find Y on shuffle Z" ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_finds (
      user_id TEXT REFERENCES users(id),
      find_id TEXT NOT NULL,
      first_shuffle_id INTEGER REFERENCES shuffles(id),
      discovered_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, find_id)
    )
  `);

  // --- User Achievements: "User X unlocked achievement Y on shuffle Z" ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_achievements (
      user_id TEXT REFERENCES users(id),
      achievement_id TEXT NOT NULL,
      shuffle_id INTEGER REFERENCES shuffles(id),
      unlocked_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, achievement_id)
    )
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

// ============ IP GEOLOCATION ============
// Looks up a user's country and city from their IP address.
// Uses ip-api.com — free, no API key needed.
// Like checking the postmark on an envelope to see where it came from.

async function lookupLocation(ip) {
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city`);
    const data = await response.json();
    if (data.status === 'success') {
      return { country: data.country, city: data.city };
    }
    return { country: null, city: null };
  } catch (error) {
    console.error('Geolocation lookup failed:', error);
    return { country: null, city: null };
  }
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
// ============ ACHIEVEMENT ENGINE ============
// After each shuffle, check which achievements the user has just earned.
// Like a trophy inspector — runs through every possible achievement,
// checks the conditions, and hands out any trophies that are newly earned.
//
// Wrapped in try/catch so a bug here can NEVER break someone's shuffle.
// If something goes wrong, we just skip achievements and log the error.
//
// GROUP C achievements (Encore, Imprint, retroactive notifications)
// are triggered by different events and aren't checked here.

async function checkAchievements(userId, shuffleId, ctx) {
  try {
    // ---- GATHER DATA ----
    // Run a few database queries to get the full picture before checking.

    // Which achievements do they already have?
    const existingAch = await pool.query(
      'SELECT achievement_id FROM user_achievements WHERE user_id = $1',
      [userId]
    );
    const alreadyUnlocked = new Set(existingAch.rows.map(r => r.achievement_id));

    // How many unique finds do they have now? (Including any just added)
    const findsCountResult = await pool.query(
      'SELECT COUNT(*) FROM user_finds WHERE user_id = $1',
      [userId]
    );
    const totalUniqueFinds = parseInt(findsCountResult.rows[0].count);

    // Their recent shuffles (for pattern achievements like Hat Trick)
    const recentResult = await pool.query(
      'SELECT match_count, local_hour, created_at FROM shuffles WHERE user_id = $1 ORDER BY created_at DESC LIMIT 7',
      [userId]
    );
    const recentShuffles = recentResult.rows;

    // Every distinct match count they've ever had (for Full Spectrum)
    const distinctResult = await pool.query(
      'SELECT DISTINCT match_count FROM shuffles WHERE user_id = $1',
      [userId]
    );
    const distinctMatchCounts = new Set(distinctResult.rows.map(r => r.match_count));

    // ---- HELPER FUNCTION ----
    // award() adds an achievement to the "newly unlocked" list,
    // but only if they don't already have it. Like a bouncer
    // checking the guest list — no duplicates allowed.
    const newlyUnlocked = [];
    function award(id) {
      if (!alreadyUnlocked.has(id)) {
        newlyUnlocked.push(id);
      }
    }

    // ---- RARITY ANALYSIS ----
    // Figure out which rarity tiers the user had BEFORE this shuffle,
    // and which new ones they just discovered. Needed for
    // first-discovery-by-rarity and connoisseur achievements.
    const previousRarities = new Set();
    for (const findId of ctx.alreadyFound) {
      if (FIND_RARITY[findId]) previousRarities.add(FIND_RARITY[findId]);
    }
    const newRarities = new Set();
    for (const findId of ctx.newFindIds) {
      if (FIND_RARITY[findId]) newRarities.add(FIND_RARITY[findId]);
    }
    const allLifetimeRarities = new Set([...previousRarities, ...newRarities]);

    // Rarity tiers found in THIS shuffle specifically
    const thisShuffleRarities = new Set();
    for (const find of ctx.finds) {
      thisShuffleRarities.add(find.rarity);
    }

    // ========== STREAKS (6) ==========
    if (ctx.totalShuffles >= 1) award('first-step');
    if (ctx.streak >= 7) award('week-walker');
    if (ctx.streak >= 14) award('fortnight');
    if (ctx.streak >= 30) award('month-maven');
    if (ctx.streak >= 90) award('quarter-quest');
    if (ctx.streak >= 365) award('long-walk');

    // ========== SHUFFLE TOTALS (4) ==========
    if (ctx.totalShuffles >= 10) award('double-digits');
    if (ctx.totalShuffles >= 50) award('half-century');
    if (ctx.totalShuffles >= 100) award('century-club');
    if (ctx.totalShuffles >= 365) award('full-orbit');

    // ========== MATCH MILESTONES (4) ==========
    if (ctx.matchCount >= 5) award('close-call');
    if (ctx.matchCount >= 7) award('lucky-seven');
    if (ctx.matchCount >= 8) award('near-miss');
    if (ctx.matchCount >= 9) award('the-impossible');

    // ========== MATCH EXPERIENCES (4) ==========
    if (ctx.matchCount === 0) award('ghost-town');
    // Twins: same match count as yesterday
    if (ctx.lastMatchCount != null && ctx.matchCount === ctx.lastMatchCount) {
      award('twins');
    }
    // The Other Half: GROUP C (needs retroactive notification system)
    // Full Spectrum: seen every tier from Ghost (0) through Singularity (9)
    const spectrumTiers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    if (spectrumTiers.every(n => distinctMatchCounts.has(n))) {
      award('full-spectrum');
    }

    // ========== COLLECTION PROGRESS (3) ==========
    if (totalUniqueFinds >= 5) award('curious');
    if (totalUniqueFinds >= 15) award('explorer');
    if (totalUniqueFinds >= 25) award('cataloguer');

    // ========== FIRST DISCOVERY BY RARITY (4) ==========
    // "First Rare find" means: this shuffle contains a Rare find,
    // AND the user had never found anything Rare before.
    if (newRarities.has('Rare') && !previousRarities.has('Rare')) award('something-rare');
    if (newRarities.has('Very Rare') && !previousRarities.has('Very Rare')) award('against-odds');
    if (newRarities.has('Extraordinary') && !previousRarities.has('Extraordinary')) award('one-in-a-million');
    if (newRarities.has('Legendary') && !previousRarities.has('Legendary')) award('royal-witness');

    // ========== FACTORY POSITION (5) ==========
    if (ctx.factoryCount === 0) award('blank-slate');
    if (ctx.factoryCount >= 2) award('deja-vu');
    if (ctx.factoryCount >= 3) award('homing-instinct');
    if (ctx.factoryCount >= 4) award('deck-remembers');
    if (ctx.factoryCount >= 5) award('total-recall');

    // ========== RETROACTIVE (4) — GROUP C ==========
    // Rising Star, Sleeper Hit, Late Bloomer, The Climber
    // These need the retroactive notification system — built later.

    // ========== FUN & PERSONALITY (7) ==========
    // Night Owl: shuffle between midnight and 4am local time
    if (ctx.localHour != null && ctx.localHour >= 0 && ctx.localHour < 4) award('night-owl');
    // Early Bird: shuffle between 4am and 7am local time
    if (ctx.localHour != null && ctx.localHour >= 4 && ctx.localHour < 7) award('early-bird');
    // Night and Day: earn both Night Owl and Early Bird
    // Check both already-unlocked AND just-unlocked-this-shuffle
    if ((alreadyUnlocked.has('night-owl') || newlyUnlocked.includes('night-owl')) &&
        (alreadyUnlocked.has('early-bird') || newlyUnlocked.includes('early-bird'))) {
      award('night-and-day');
    }
    // Weekender: shuffle both Saturday and Sunday the same weekend
    // Uses UTC day — may be slightly off for distant timezones
    if (recentShuffles.length >= 2) {
      const latestDate = new Date(recentShuffles[0].created_at);
      const latestDay = latestDate.getUTCDay(); // 0=Sun, 6=Sat
      if (latestDay === 0 || latestDay === 6) {
        const targetDay = latestDay === 0 ? 6 : 0; // Sun looks for Sat, Sat looks for Sun
        const hasOtherDay = recentShuffles.slice(1).some(s => {
          const d = new Date(s.created_at);
          const dayDiff = Math.abs(latestDate - d) / (1000 * 60 * 60 * 24);
          return d.getUTCDay() === targetDay && dayDiff <= 2;
        });
        if (hasOtherDay) award('weekender');
      }
    }
    // Monday Motivation: shuffle on a Monday
    if (new Date().getUTCDay() === 1) award('monday-motivation');
    // Creature of Habit: shuffle within the same hour, 7 days running
    if (recentShuffles.length >= 7 && ctx.localHour != null) {
      const lastSeven = recentShuffles.slice(0, 7);
      const allSameHour = lastSeven.every(s => s.local_hour === ctx.localHour);
      if (allSameHour) {
        // Also verify they're on 7 consecutive days
        let consecutive = true;
        for (let i = 0; i < 6; i++) {
          const a = new Date(lastSeven[i].created_at);
          const b = new Date(lastSeven[i + 1].created_at);
          const dayDiff = Math.round((a - b) / (1000 * 60 * 60 * 24));
          if (dayDiff !== 1) { consecutive = false; break; }
        }
        if (consecutive) award('creature-of-habit');
      }
    }
    // Comeback Kid: shuffle again after 7+ days away
    if (ctx.lastShuffleDate) {
      const last = new Date(ctx.lastShuffleDate);
      const now = new Date();
      const daysSince = Math.floor((now - last) / (1000 * 60 * 60 * 24));
      if (daysSince >= 7) award('comeback-kid');
    }

    // ========== PER-SHUFFLE MOMENTS (3) ==========
    if (ctx.finds.length >= 8) award('jackpot');
    if (ctx.matchCount === 0 && ctx.factoryCount === 0) award('phantom');
    if (ctx.newFindIds.length >= 3) award('new-horizons');

    // ========== VARIETY (3) ==========
    // Variety Pack: finds from 4+ rarity tiers in one shuffle
    if (thisShuffleRarities.size >= 4) award('variety-pack');
    // Hat Trick: same match count three days in a row
    if (recentShuffles.length >= 3) {
      const lastThree = recentShuffles.slice(0, 3).map(s => s.match_count);
      if (lastThree[0] === lastThree[1] && lastThree[1] === lastThree[2]) {
        award('hat-trick');
      }
    }
    // Connoisseur: finds from all 6 rarity tiers across lifetime
    if (allLifetimeRarities.size >= 6) award('connoisseur');

    // ========== LIFETIME (2) ==========
    // Anniversary: shuffle on the one-year anniversary of your first shuffle
    if (ctx.firstShuffleDate) {
      const first = new Date(ctx.firstShuffleDate);
      const now = new Date();
      if (first.getUTCMonth() === now.getUTCMonth() &&
          first.getUTCDate() === now.getUTCDate() &&
          now.getUTCFullYear() > first.getUTCFullYear()) {
        award('anniversary');
      }
    }
    // Daily Crown: have the highest match of the day
    if (ctx.matchCount > 0 && ctx.matchCount >= ctx.todayHighest) {
      award('daily-crown');
    }

    // ========== KEEPSAKES (2) — GROUP C ==========
    // Encore (watch replay) and Imprint (save shuffle)
    // Triggered by frontend actions, not by shuffling.

    // ========== THE FINAL CARD (1) ==========
    if (totalUniqueFinds >= 35) award('completionist');

    // ---- SAVE NEW ACHIEVEMENTS ----
    for (const id of newlyUnlocked) {
      await pool.query(
        `INSERT INTO user_achievements (user_id, achievement_id, shuffle_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, achievement_id) DO NOTHING`,
        [userId, id, shuffleId]
      );
    }

    return newlyUnlocked;
  } catch (error) {
    console.error('Achievement check error:', error);
    return []; // Never break the shuffle
  }
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
              isTodaysLeader: matchResult && matchResult.matchCount >= todayCount && matchResult.matchCount > 0,
              streak: req.user.current_streak,
            },
            message: 'You already shuffled today. Come back tomorrow!',
          });
        }
      }
    }
       // Look up where this person is shuffling from.
    // x-forwarded-for is the real IP — Railway sits in front of your server
    // (like a receptionist), so the original IP gets passed along in this header.
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const location = await lookupLocation(ip);
    // Read the user's local hour (0-23), sent by the browser.
    // parseInt turns the text "14" into the number 14.
    // If the frontend didn't send it, we get null — no big deal.
    const localHour = req.query.localHour != null ? parseInt(req.query.localHour) : null;
    const localDay = req.query.localDay != null ? parseInt(req.query.localDay) : null;
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
      'INSERT INTO shuffles (cards, country, city, local_hour, user_id, match_count) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [JSON.stringify(shuffled), location.country, location.city, localHour, req.user.id, matchResult ? matchResult.matchCount : 0]
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

    // ============ TRACK FINDS ============
    // Which finds did this shuffle contain, and has this user seen them before?
    const finds = detectFinds(shuffled);

    // Get all find IDs this user has previously discovered.
    // This is like checking a stamp collection — which stamps do they already have?
    const existingFinds = await pool.query(
      'SELECT find_id FROM user_finds WHERE user_id = $1',
      [req.user.id]
    );
    const alreadyFound = new Set(existingFinds.rows.map(r => r.find_id));

    // Mark each find as new or not, and save the new ones
    const newFindIds = [];
    for (const find of finds) {
      if (alreadyFound.has(find.id)) {
        find.isNew = false;
      } else {
        find.isNew = true;
        newFindIds.push(find.id);
      }
    }

    // Save any new discoveries to the database.
    // Each INSERT uses ON CONFLICT DO NOTHING as a safety net —
    // if somehow the same find gets inserted twice, it just ignores the duplicate.
    for (const findId of newFindIds) {
      await pool.query(
        `INSERT INTO user_finds (user_id, find_id, first_shuffle_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, find_id) DO NOTHING`,
        [req.user.id, findId, newShuffleId]
      );
    }
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
           highest_match = GREATEST(highest_match, $1),
           first_shuffle_date = COALESCE(first_shuffle_date, CURRENT_DATE),
           last_match_count = $5
       WHERE id = $2`,
      [matchCount, req.user.id, newShuffleId, newStreak, matchCount]
    );
    // ============ CHECK ACHIEVEMENTS ============
    const newAchievements = await checkAchievements(req.user.id, newShuffleId, {
      matchCount,
      streak: newStreak,
      totalShuffles: req.user.total_shuffles + 1,
      finds,
      newFindIds,
      alreadyFound,
      factoryCount: countFactoryPositions(shuffled),
      localHour,
      lastMatchCount: req.user.last_match_count,
      lastShuffleDate: req.user.last_shuffle_date,
      firstShuffleDate: req.user.first_shuffle_date || new Date(),
      todayHighest: todayCount,
    });

    // Build the response
    let result;
    if (!matchResult) {
      result = {
        shuffle: { id: newShuffleId, cards: shuffled, timestamp: new Date().toISOString() },
        match: null,
        factoryCount: countFactoryPositions(shuffled),
        finds: finds,
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
        finds: finds,
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
    result.newAchievements = newAchievements;

    // Attach this user's personal stats.
    // total_shuffles is +1 because we just incremented it above.
    result.user = {
      yourHighest: isNewPersonalBest ? matchCount : req.user.highest_match,
      totalShuffles: req.user.total_shuffles + 1,
      isNewPersonalBest: isNewPersonalBest,
      isTodaysLeader: matchCount >= todayCount && matchCount > 0,
      streak: newStreak,
      totalFinds: alreadyFound.size + newFindIds.length,
    };

    res.json(result);
  } catch (error) {
    console.error('Shuffle error:', error);
    res.status(500).json({ error: 'Something went wrong generating your shuffle.' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    // Total shuffles ever
    const count = await pool.query('SELECT COUNT(*) FROM shuffles');
    const total = parseInt(count.rows[0].count);

    // Global and today's highest from the records table
    const recordResult = await pool.query(
      'SELECT highest_count, today_highest_count, today_date FROM records WHERE id = 1'
    );
    const record = recordResult.rows[0];

    // Check if today_date is actually today
    const today = new Date().toISOString().split('T')[0];
    const storedDate = record.today_date.toISOString().split('T')[0];
    const todayHighest = storedDate === today ? record.today_highest_count : 0;

    // Count how many shuffles happened today
    const todayCount = await pool.query(
      "SELECT COUNT(*) FROM shuffles WHERE created_at::date = CURRENT_DATE"
    );
    const todayShuffles = parseInt(todayCount.rows[0].count);

    res.json({
      totalShuffles: total,
      globalHighest: record.highest_count,
      todayHighest: todayHighest,
      todayShuffles: todayShuffles,
      user: req.user ? await (async () => {
      const findsResult = await pool.query(
        'SELECT find_id FROM user_finds WHERE user_id = $1',
        [req.user.id]
      );
      const achievementsResult = await pool.query(
        'SELECT achievement_id FROM user_achievements WHERE user_id = $1',
        [req.user.id]
      );
      return {
        yourHighest: req.user.highest_match,
        streak: req.user.current_streak,
        totalShuffles: req.user.total_shuffles,
        discoveredFinds: findsResult.rows.map(r => r.find_id),
        unlockedAchievements: achievementsResult.rows.map(r => r.achievement_id),
      };
    })() : null,
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
