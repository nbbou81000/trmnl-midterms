// US Midterms 2026 — TRMNL data builder
// Fetches the public AP-sourced results JSON published by The New York Times,
// reduces it to compact files: data/us.json + one file per state (data/ca.json ...).
// Usage:  node scripts/build.mjs            (live)
//         node scripts/build.mjs --demo 0.6 (simulated night, 0..1 progress, for previews)
import fs from "node:fs";
import path from "node:path";

const DATE = "2026-11-03";
const BASE = `https://static01.nyt.com/elections-assets/pages/data/${DATE}/results-`;
const OUT = path.resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "data");
const DEMO = process.argv.includes("--demo") ? Number(process.argv[process.argv.indexOf("--demo") + 1] || 0.6) : null;
const LOCAL = process.argv.includes("--local") ? process.argv[process.argv.indexOf("--local") + 1] : null;

// Governors NOT on the ballot in 2026 (held through the night): 6 D, 8 R
const GOV_HOLD = { D: 6, R: 8, I: 0 };

const STATE_NAMES = { AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",DC:"District of Columbia" };

const RATING = { "tossup": "Toss-up", "lean-dem": "Lean D", "lean-rep": "Lean R", "likely-dem": "Likely D", "likely-rep": "Likely R", "solid-dem": "Solid D", "solid-rep": "Solid R" };
const RATING_FR = { "tossup": "Indécis", "lean-dem": "Penche D", "lean-rep": "Penche R", "likely-dem": "Probable D", "likely-rep": "Probable R", "solid-dem": "Sûr D", "solid-rep": "Sûr R" };
const RATING_ES = { "tossup": "Reñida", "lean-dem": "Inclina D", "lean-rep": "Inclina R", "likely-dem": "Probable D", "likely-rep": "Probable R", "solid-dem": "Segura D", "solid-rep": "Segura R" };
const RANK = { "tossup": 0, "lean-dem": 1, "lean-rep": 1, "likely-dem": 2, "likely-rep": 2, "solid-dem": 3, "solid-rep": 3 };

async function getJSON(office) {
  if (LOCAL) return JSON.parse(fs.readFileSync(path.join(LOCAL, `${office}.json`), "utf8"));
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${BASE}${office}.json?t=${Date.now()}`, { headers: { "User-Agent": "trmnl-midterms (GitHub Actions)" } });
      if (!res.ok) throw new Error(`${office}: HTTP ${res.status}`);
      return await res.json();
    } catch (e) { err = e; await new Promise(r => setTimeout(r, 3000)); }
  }
  throw err;
}

const party = p => {
  const id = (p && (p.nyt_id || p.party_id || p)) || "";
  if (id === "DEM" || id === "democrat") return "D";
  if (id === "GOP" || id === "republican") return "R";
  if (id === "IND" || id === "OTH" || id === "independent") return "I";
  return "O";
};
const round1 = x => Math.round(x * 10) / 10;
const cleanName = m => (m.last_name || m.first_name || "").replace(/\s+Jr\.?$/, "");

// ---------- demo simulation (mutates raw NYT objects) ----------
function seeded(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function simulate(raw, progress) {
  const rnd = seeded(20261103);
  const order = {};
  raw.senate.pollClosingTimes.forEach(p => order[p.reporting_unit.state_postal] = Date.parse(p.poll_closing_time));
  const first = Math.min(...Object.values(order)), last = Math.max(...Object.values(order));
  const now = first + progress * (last + 3 * 3600e3 - first);
  raw.__now = now;
  const lean = { "solid-dem": 0.66, "likely-dem": 0.57, "lean-dem": 0.53, "tossup": 0.5, "lean-rep": 0.47, "likely-rep": 0.43, "solid-rep": 0.34 };
  for (const office of ["senate", "house", "governor"]) {
    for (const r of raw[office].races) {
      const tru = r.top_reporting_unit;
      const close = order[tru.state_postal] ?? first;
      const hrs = (now - close) / 3600e3;
      let eevp = hrs <= 0 ? 0 : Math.min(99, Math.round(100 * (1 - Math.exp(-hrs / 1.6)) * (0.85 + 0.15 * rnd())));
      if (tru.state_postal === "US") eevp = Math.round(progress * 82);
      const base = lean[r.rating] ?? (r.rating === null ? 0.45 : 0.5);
      const dshare = Math.min(0.85, Math.max(0.15, base + (rnd() - 0.5) * 0.08));
      const meta = r.candidate_metadata;
      const exp = tru.total_expected_vote || 100000;
      const counted = Math.round(exp * eevp / 100);
      const cands = tru.candidates;
      let others = cands.filter(c => !["D", "R"].includes(party(meta[c.nyt_id]?.party)));
      for (const c of cands) {
        const p = party(meta[c.nyt_id]?.party);
        let share = p === "D" ? dshare * 0.97 : p === "R" ? (1 - dshare) * 0.97 : 0.03 / Math.max(1, others.length);
        if (!cands.some(x => party(meta[x.nyt_id]?.party) === "D") && p === "I") share = dshare * 0.97;
        c.votes = { total: Math.round(counted * share) };
      }
      tru.eevp = eevp; tru.total_votes = cands.reduce((a, c) => a + c.votes.total, 0);
      const sorted = [...cands].sort((a, b) => b.votes.total - a.votes.total);
      const margin = sorted.length > 1 && tru.total_votes ? (sorted[0].votes.total - sorted[1].votes.total) / tru.total_votes : 1;
      const callable = r.uncontested || (eevp > 0 && (margin > 0.12 || (eevp > 60 && margin > 0.05) || (eevp > 85 && margin > 0.02)));
      if (callable && sorted.length && tru.state_postal !== "US") {
        r.outcome.won = [sorted[0].nyt_id];
        r.outcome.winner_accepted_at = [new Date(close + (hrs * 0.6 + rnd() * 0.3) * 3600e3).toISOString()];
        r.race_call_status = "called";
        const wp = party(meta[sorted[0].nyt_id]?.party);
        if ((r.rating === "tossup" || r.rating?.startsWith("lean")) && rnd() < 0.45) r.outcome.gained = wp === "D" ? "DEM" : "GOP";
      } else if (eevp > 0) r.race_call_status = "too_close";
    }
  }
}

// ---------- reduce ----------
function reduceRace(r, nowMs) {
  const tru = r.top_reporting_unit || {};
  const meta = r.candidate_metadata || {};
  const total = tru.total_votes || 0;
  const cands = (tru.candidates || []).map(c => {
    const m = meta[c.nyt_id] || {};
    return { id: c.nyt_id, n: cleanName(m), p: party(m.party), v: c.votes?.total || 0, inc: !!m.incumbent, o: m.order ?? 99 };
  }).sort((a, b) => (b.v - a.v) || (a.o - b.o));
  cands.forEach(c => c.pct = total ? round1(100 * c.v / total) : 0);
  const won = r.outcome?.won || [];
  const winner = cands.find(c => won.includes(c.id));
  const leader = total > 0 ? cands[0] : null;
  // left side = best Dem (or Ind), right side = best Rep; fallback to top two
  let a = cands.find(c => c.p === "D") || cands.find(c => c.p === "I");
  let b = cands.find(c => c.p === "R");
  if (!a || !b) { [a, b] = [cands[0], cands.find(c => c !== cands[0])]; }
  const st = tru.state_postal;
  const office = r.office_id;
  let lbl = st;
  if (office === "H") lbl = `${st}-${String(r.seat_number || "").padStart(2, "0")}`;
  const gained = r.outcome?.gained;
  const calledAt = (r.outcome?.winner_accepted_at || [])[0] || null;
  const status = winner ? "called" : (total > 0 ? "lead" : "wait");
  return {
    o: office, st, lbl, nm: STATE_NAMES[st] || tru.name || st,
    sp: /S_W|Special/.test(r.nyt_id + r.type) ? 1 : 0,
    rt: RATING[r.rating || r.general_rating] || "", rtfr: RATING_FR[r.rating || r.general_rating] || "", rtes: RATING_ES[r.rating || r.general_rating] || "",
    rk: RANK[r.rating || r.general_rating] ?? 4,
    a: a ? { n: a.n, p: a.p, pct: a.pct, inc: a.inc ? 1 : 0 } : null,
    b: b ? { n: b.n, p: b.p, pct: b.pct, inc: b.inc ? 1 : 0 } : null,
    s: status,
    w: winner ? winner.p : (leader ? leader.p : ""),
    wn: winner ? winner.n : (leader ? leader.n : ""),
    mg: leader && cands[1] ? round1(cands[0].pct - cands[1].pct) : 0,
    in: Math.round(tru.eevp || 0),
    f: gained ? 1 : 0,
    ts: calledAt ? Math.floor(Date.parse(calledAt) / 1000) : 0,
    unc: r.uncontested ? 1 : 0,
  };
}

function tally(races) {
  const t = { won: { D: 0, R: 0, I: 0, O: 0 }, lead: { D: 0, R: 0, I: 0, O: 0 }, flips: { D: 0, R: 0, I: 0, O: 0 }, called: 0 };
  for (const x of races) {
    if (x.s === "called") { t.called++; t.won[x.w]++; if (x.f) t.flips[x.w]++; }
    else if (x.s === "lead" && x.w) t.lead[x.w]++;
  }
  return t;
}

const pick = x => ({ o: x.o, lbl: x.lbl, nm: x.nm, sp: x.sp, rt: x.rt, rtfr: x.rtfr, rtes: x.rtes, a: x.a, b: x.b, s: x.s, w: x.w, wn: x.wn, mg: x.mg, in: x.in, f: x.f });

async function main() {
  const raw = { senate: await getJSON("senate"), house: await getJSON("house"), governor: await getJSON("governor") };
  if (DEMO !== null) simulate(raw, DEMO);
  const nowMs = raw.__now || Date.now();

  const S = raw.senate.races.map(r => reduceRace(r, nowMs));
  const Hall = raw.house.races.map(r => reduceRace(r, nowMs));
  const H = Hall.filter(x => x.st !== "US");
  const PV = Hall.find(x => x.st === "US");
  const G = raw.governor.races.map(r => reduceRace(r, nowMs));
  // at-large districts
  const perState = {};
  H.forEach(x => perState[x.st] = (perState[x.st] || 0) + 1);
  H.forEach(x => { if (perState[x.st] === 1) x.lbl = `${x.st}-AL`; });

  const pc = raw.senate.partyControlData?.results?.[0]?.offices || {};
  const sHold = pc.S?.party_balance || {};
  const hold = k => (sHold[k]?.no_election || 0);
  const ts = tally(S), th = tally(H), tg = tally(G);

  const senate = {
    d: hold("DEM") + ts.won.D, r: hold("GOP") + ts.won.R, i: hold("OTH") + ts.won.I + ts.won.O,
    hold_d: hold("DEM"), hold_r: hold("GOP"),
    called: ts.called, total: S.length, need_d: 51, need_r: 50,
    lead_d: ts.lead.D + ts.lead.I, lead_r: ts.lead.R, flip_d: ts.flips.D + ts.flips.I, flip_r: ts.flips.R,
  };
  senate.pending = 100 - senate.d - senate.r - senate.i;
  senate.ctrl = senate.d + senate.i >= 51 ? "D" : senate.r >= 50 ? "R" : "";
  senate.proj_d = senate.d + senate.i + senate.lead_d; senate.proj_r = senate.r + senate.lead_r;

  const house = {
    d: th.won.D, r: th.won.R, i: th.won.I + th.won.O, called: th.called, total: 435, need: 218,
    lead_d: th.lead.D, lead_r: th.lead.R, flip_d: th.flips.D, flip_r: th.flips.R,
  };
  house.pending = 435 - house.d - house.r - house.i;
  house.ctrl = house.d >= 218 ? "D" : house.r >= 218 ? "R" : "";
  house.proj_d = house.d + house.lead_d; house.proj_r = house.r + house.lead_r;
  if (PV) {
    const dv = PV.a?.p === "D" ? PV.a.pct : PV.b?.pct, rv = PV.b?.p === "R" ? PV.b.pct : PV.a?.pct;
    house.pv_d = dv || 0; house.pv_r = rv || 0; house.pv_in = PV.in;
  }

  const gov = {
    d: GOV_HOLD.D + tg.won.D, r: GOV_HOLD.R + tg.won.R, i: tg.won.I + tg.won.O,
    won_d: tg.won.D, won_r: tg.won.R, called: tg.called, total: G.length,
    lead_d: tg.lead.D + tg.lead.I, lead_r: tg.lead.R, flip_d: tg.flips.D + tg.flips.I, flip_r: tg.flips.R,
  };
  gov.pending = 50 - gov.d - gov.r - gov.i;

  // poll closings
  const closings = raw.senate.pollClosingTimes.map(p => ({ st: p.reporting_unit.state_postal, t: Date.parse(p.poll_closing_time) }));
  const closed = closings.filter(c => c.t <= nowMs).length;
  const future = closings.filter(c => c.t > nowMs).sort((a, b) => a.t - b.t);
  const nextT = future.length ? future[0].t : 0;
  const polls = {
    closed, total: closings.length,
    next_ts: nextT ? Math.floor(nextT / 1000) : 0,
    next_st: future.filter(c => c.t === nextT).map(c => c.st).sort().join(" "),
    next_n: future.filter(c => c.t === nextT).length,
    first_ts: Math.floor(Math.min(...closings.map(c => c.t)) / 1000),
  };
  const anyVotes = [...S, ...H, ...G].some(x => x.s !== "wait");
  const phase = !anyVotes && closed === 0 ? "pre" : (ts.called === S.length && th.called >= 425 && tg.called === G.length ? "done" : "live");

  // lists
  const byState = (a, b) => a.st.localeCompare(b.st) || a.sp - b.sp;
  const sortKey = (a, b) => (a.rk - b.rk) || byState(a, b);
  const battle = [...S.filter(x => x.rk <= 1 || x.rt === ""), ...G.filter(x => x.rk <= 1), ...H.filter(x => x.rk === 0)]
    .sort((a, b) => ({ S: 0, G: 1, H: 2 }[a.o] - { S: 0, G: 1, H: 2 }[b.o]) || sortKey(a, b));
  const calls = [...S, ...G, ...H].filter(x => x.s === "called" && !x.unc).sort((a, b) => b.ts - a.ts || a.o.localeCompare(b.o)).slice(0, 12);
  const flips = [...S, ...G, ...H].filter(x => x.s === "called" && x.f).sort((a, b) => b.ts - a.ts).slice(0, 12);

  const common = {
    v: 1, source: "AP via The New York Times", demo: DEMO !== null ? 1 : 0,
    updated_ts: Math.floor(nowMs / 1000), phase, polls, senate, house, gov,
    senate_races: [...S].sort((a, b) => sortKey(a, b)).map(pick),
    gov_races: [...G].sort((a, b) => sortKey(a, b)).map(pick),
    house_key: H.filter(x => x.rk <= 1).sort(sortKey).map(pick),
    battle: battle.map(pick),
    calls: calls.map(x => ({ ...pick(x), ts: x.ts })),
    flips: flips.map(pick),
  };
  common.n_battle = common.battle.length;

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "us.json"), JSON.stringify({ ...common, focus: null }));
  for (const st of Object.keys(STATE_NAMES)) {
    if (st === "DC") continue;
    const hs = H.filter(x => x.st === st).sort((a, b) => a.lbl.localeCompare(b.lbl));
    const th2 = tally(hs);
    const focus = {
      st, nm: STATE_NAMES[st],
      senate: S.filter(x => x.st === st).sort(byState).map(pick),
      gov: G.filter(x => x.st === st).map(pick),
      house: { total: hs.length, d: th2.won.D, r: th2.won.R, i: th2.won.I + th2.won.O, lead_d: th2.lead.D, lead_r: th2.lead.R, called: th2.called, flip_d: th2.flips.D, flip_r: th2.flips.R },
      house_races: hs.map(pick),
      closes_ts: Math.floor((closings.find(c => c.st === st)?.t || 0) / 1000),
    };
    fs.writeFileSync(path.join(OUT, `${st.toLowerCase()}.json`), JSON.stringify({ ...common, focus }));
  }
  const size = fs.statSync(path.join(OUT, "us.json")).size;
  console.log(`OK ${new Date(nowMs).toISOString()} phase=${phase} S ${senate.d}-${senate.r} (${ts.called}/35) H ${house.d}-${house.r} (${th.called}/435) G ${gov.d}-${gov.r} | us.json ${size} B`);
}

main().catch(e => { console.error(e); process.exit(1); });
