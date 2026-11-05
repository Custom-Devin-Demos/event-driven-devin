/**
 * StreamTV catalog fixtures: titles, live channels, profiles and each
 * profile's recent watch history. In-memory, deterministic, mock data only.
 */

const ART = {
  drama: ['#3B1F6B', '#7B3FE4'],
  thriller: ['#1F2A44', '#3E5C9A'],
  comedy: ['#7A3E0D', '#F0A24B'],
  scifi: ['#0F3B4E', '#2BB3C0'],
  documentary: ['#1F4D2E', '#5EBB6C'],
  kids: ['#8A2B6B', '#FF7AC6'],
  live: ['#4A1030', '#C8355F'],
  romance: ['#5B1F3A', '#E0607E'],
  action: ['#4A1212', '#D9452B'],
};

function series(id, title, genre, year, seasons, rating, runtime) {
  return { id, title, kind: 'series', genre, year, seasons, rating, durationSec: runtime * 60, art: ART[genre] };
}
function movie(id, title, genre, year, rating, runtime) {
  return { id, title, kind: 'movie', genre, year, rating, durationSec: runtime * 60, art: ART[genre] };
}

const TITLES = [
  series('t001', 'Northern Lights', 'drama', 2024, 3, 'TV-14', 52),
  series('t002', 'The Quiet Harbor', 'drama', 2023, 2, 'TV-MA', 48),
  series('t003', 'Orbit Station', 'scifi', 2025, 1, 'TV-14', 55),
  series('t004', 'Hidden Ledger', 'thriller', 2022, 4, 'TV-MA', 46),
  series('t005', 'Saltwater Kitchen', 'documentary', 2024, 2, 'TV-G', 38),
  series('t006', 'Night Dispatch', 'thriller', 2025, 1, 'TV-14', 44),
  series('t007', 'Second Summer', 'romance', 2023, 2, 'TV-PG', 42),
  series('t008', 'Vantage Point', 'thriller', 2021, 5, 'TV-MA', 50),
  series('t009', 'Clockwork City', 'scifi', 2024, 2, 'TV-PG', 47),
  series('t010', 'Paper Lanterns', 'drama', 2022, 3, 'TV-14', 51),
  series('t011', 'Redwood Precinct', 'action', 2025, 1, 'TV-14', 45),
  series('t012', 'The Tidewater Case', 'thriller', 2024, 1, 'TV-MA', 58),
  series('t013', 'Signal Lost', 'scifi', 2023, 2, 'TV-14', 49),
  series('t014', 'Backcountry', 'documentary', 2025, 1, 'TV-PG', 41),
  series('t015', 'Marble & Ash', 'drama', 2021, 4, 'TV-MA', 53),
  series('t016', 'Low Orbit', 'comedy', 2024, 2, 'TV-14', 28),
  series('t017', 'Main Street Mysteries', 'comedy', 2022, 6, 'TV-PG', 43),
  series('t018', 'The Understudy', 'drama', 2025, 1, 'TV-14', 50),
  series('t019', 'Blue Hour', 'romance', 2024, 1, 'TV-14', 46),
  series('t020', 'Ferry Tales', 'comedy', 2023, 3, 'TV-PG', 26),
  movie('t021', 'Last Train to Marrow', 'thriller', 2024, 'PG-13', 118),
  movie('t022', 'Glass Meridian', 'scifi', 2025, 'PG-13', 131),
  movie('t023', 'Kite Season', 'drama', 2023, 'PG', 104),
  movie('t024', 'A Long Way Down the Coast', 'romance', 2022, 'PG-13', 112),
  movie('t025', 'Copper Sky', 'action', 2025, 'PG-13', 126),
  movie('t026', 'The Cartographer', 'drama', 2021, 'R', 139),
  movie('t027', 'Midnight Launch', 'scifi', 2024, 'PG-13', 122),
  movie('t028', 'Slow Burn', 'thriller', 2023, 'R', 108),
  movie('t029', 'Harbor Lights', 'romance', 2024, 'PG', 101),
  movie('t030', 'Driftwood', 'drama', 2022, 'PG-13', 115),
  movie('t031', 'Echo Valley', 'thriller', 2025, 'R', 119),
  movie('t032', 'Starling', 'scifi', 2023, 'PG', 97),
  movie('t033', 'The Weekend House', 'comedy', 2024, 'PG-13', 94),
  movie('t034', 'Red Line', 'action', 2022, 'R', 110),
  movie('t035', 'Two Lanterns', 'drama', 2025, 'PG-13', 127),
  movie('t036', 'Summit Fever', 'documentary', 2024, 'PG', 92),
  movie('t037', 'Afterglow', 'romance', 2023, 'PG-13', 105),
  movie('t038', 'The Quiet Frontier', 'documentary', 2025, 'TV-G', 88),
  movie('t039', 'Wavelength', 'scifi', 2022, 'PG-13', 113),
  movie('t040', 'Hollow Pines', 'thriller', 2024, 'R', 121),
  series('t041', 'Pip & Pocket', 'kids', 2024, 2, 'TV-Y', 12),
  series('t042', 'Rocket Rabbits', 'kids', 2023, 3, 'TV-Y', 22),
  series('t043', 'Dino Daycare', 'kids', 2025, 1, 'TV-Y', 11),
  series('t044', 'The Puzzle Pals', 'kids', 2022, 4, 'TV-Y7', 24),
  series('t045', 'Captain Cloud', 'kids', 2024, 2, 'TV-Y7', 23),
  series('t046', 'Bramble Woods', 'kids', 2023, 2, 'TV-Y', 14),
  series('t047', 'Sprout & Sprocket', 'kids', 2025, 1, 'TV-Y', 12),
  movie('t048', 'Moon Mice', 'kids', 2024, 'G', 84),
  movie('t049', 'Tiny Titans', 'kids', 2023, 'PG', 91),
  movie('t050', 'Doodle Island', 'kids', 2025, 'G', 79),
];

const TITLE_BY_ID = new Map(TITLES.map((t) => [t.id, t]));

const LIVE_CHANNELS = [
  { id: 'ch101', number: 101, name: 'StreamTV News 24', program: 'Evening Report', genre: 'live', startedMinAgo: 18, runtimeMin: 60 },
  { id: 'ch104', number: 104, name: 'Kitchen Live', program: 'Weeknight Dinners', genre: 'live', startedMinAgo: 7, runtimeMin: 30 },
  { id: 'ch108', number: 108, name: 'Sports Desk', program: 'Late Highlights', genre: 'live', startedMinAgo: 41, runtimeMin: 60 },
  { id: 'ch112', number: 112, name: 'Classic Cinema', program: 'The Cartographer', genre: 'live', startedMinAgo: 66, runtimeMin: 140 },
  { id: 'ch117', number: 117, name: 'Nature HD', program: 'Coastlines: Pacific', genre: 'live', startedMinAgo: 22, runtimeMin: 50 },
  { id: 'ch121', number: 121, name: 'Quiz Hour', program: 'Quiz Hour: Finals Week', genre: 'live', startedMinAgo: 3, runtimeMin: 30 },
  { id: 'ch126', number: 126, name: 'Weather Now', program: 'Overnight Outlook', genre: 'live', startedMinAgo: 12, runtimeMin: 15 },
  { id: 'ch133', number: 133, name: 'Comedy Reruns', program: 'Main Street Mysteries S3 E7', genre: 'live', startedMinAgo: 29, runtimeMin: 45 },
  { id: 'ch140', number: 140, name: 'Kids Zone', program: 'Rocket Rabbits S2 E4', genre: 'live', startedMinAgo: 9, runtimeMin: 22 },
  { id: 'ch145', number: 145, name: 'Documentary Now', program: 'Summit Fever', genre: 'live', startedMinAgo: 50, runtimeMin: 95 },
];

const PROFILES = [
  { id: 'p-maya', name: 'Maya', avatar: 'M', color: '#904FF7', kidsOnly: false },
  { id: 'p-jordan', name: 'Jordan', avatar: 'J', color: '#2BB3C0', kidsOnly: false },
  { id: 'p-sam', name: 'Sam', avatar: 'S', color: '#F0A24B', kidsOnly: false },
];

const PROFILE_BY_ID = new Map(PROFILES.map((p) => [p.id, p]));

/**
 * Recent watch history per profile, most recent first. Each entry is one
 * title the profile opened in the last 90 days; `fraction` is how far through
 * the title (or its latest episode) the profile got. Entries past 0.95 are
 * finished and only surface as "next episode" candidates.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildHistory(seed, titleIds, count) {
  const rand = mulberry32(seed);
  const pool = titleIds.slice();
  const out = [];
  let minutesAgo = 35;
  while (out.length < count && pool.length) {
    const idx = Math.floor(rand() * pool.length);
    const [titleId] = pool.splice(idx, 1);
    const title = TITLE_BY_ID.get(titleId);
    const roll = rand();
    const fraction = roll < 0.3 ? 0.96 + rand() * 0.04 : 0.04 + rand() * 0.88;
    const entry = {
      titleId,
      fraction: Number(fraction.toFixed(3)),
      lastWatchedAt: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
    };
    if (title.kind === 'series') {
      entry.season = 1 + Math.floor(rand() * title.seasons);
      entry.episode = 1 + Math.floor(rand() * 10);
    }
    out.push(entry);
    minutesAgo += 90 + Math.floor(rand() * 2600);
  }
  return out;
}

const ALL_IDS = TITLES.map((t) => t.id);
const GROWN_UP_IDS = TITLES.filter((t) => t.genre !== 'kids').map((t) => t.id);

const WATCH_HISTORY = {
  'p-maya': buildHistory(1101, GROWN_UP_IDS, 38),
  'p-jordan': buildHistory(2202, GROWN_UP_IDS, 36),
  'p-sam': buildHistory(3303, ALL_IDS, 42),
};

const TRENDING_IDS = ['t003', 't011', 't022', 't006', 't025', 't018', 't031', 't012', 't035', 't016', 't038', 't001'];
const NEW_RELEASE_IDS = ['t043', 't047', 't022', 't025', 't031', 't035', 't038', 't050', 't014', 't018'];

module.exports = {
  TITLES,
  TITLE_BY_ID,
  LIVE_CHANNELS,
  PROFILES,
  PROFILE_BY_ID,
  WATCH_HISTORY,
  TRENDING_IDS,
  NEW_RELEASE_IDS,
};
