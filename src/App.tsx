import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  googleClientId,
  loadGis,
  loadStoredUser,
  parseCredential,
  storeUser,
  type GoogleUser,
} from "./googleAuth";
import "./App.css";

const serverPath = `${window.location.protocol}//${
  import.meta.env.DEV
    ? `${window.location.hostname}:3000`
    : window.location.host
}`;

// Sends the signed-in user's Google ID token so the server knows who is calling
function authFetch(user: GoogleUser, path: string, init: RequestInit = {}) {
  return fetch(serverPath + path, {
    ...init,
    headers: {
      ...init.headers,
      "Content-Type": "application/json",
      Authorization: `Bearer ${user.credential}`,
    },
  });
}

const DEFAULT_EXPECTED = [20, 17, 14, 11, 9, 7, 4, 3, 2, 1];
const DEFAULT_MULTIPLIER = [1, 2, 3, 4, 5, 7, 13, 18, 28, 60];

function getWeekNumber(epName: string): number | null {
  const match = epName?.match(/Week (\d+)/);
  return match ? Number(match[1]) : null;
}

function formatLeadSeason(lead: string): string {
  const firstName = lead.trim().split(/\s+/)[0] || lead;
  return `${firstName}'s season`;
}

type Episode = {
  id: number;
  show_id: number;
  num: number;
  name: string;
  airdate: string;
  lock_time?: string | null;
  locked?: boolean;
  revealed?: boolean;
};

type Contestant = {
  id: number;
  show_id: number;
  name: string;
  img?: string;
  eliminated_week: number | null;
};

type PickRow = {
  contestant_id: number;
  episode_id: number;
  is_on: boolean;
};

type LeaderboardEntry = {
  uid: string;
  score: number;
  name?: string;
  img?: string;
  weekly_scores?: Record<number, number>;
};

function getLeagueIdFromUrl(): number | null {
  const raw = new URLSearchParams(window.location.search).get("league");
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

type ShowOption = {
  id: number;
  name: string;
  season: number | null;
  lead?: string | null;
  poster?: string | null;
  default_league_id: number | null;
  has_episodes?: boolean;
  latest_airdate?: string | null;
};

function App() {
  const [leagueId, setLeagueId] = useState<number | null>(getLeagueIdFromUrl);
  useEffect(() => {
    const onPopState = () => setLeagueId(getLeagueIdFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const leagueQuery = leagueId !== null ? `?league=${leagueId}` : "";
  const [shows, setShows] = useState<ShowOption[]>([]);
  useEffect(() => {
    async function getData() {
      const response = await fetch(serverPath + "/shows");
      if (response.ok) {
        const list: ShowOption[] = await response.json();
        setShows(list);
        const defaultShow = list.find((s) => s.default_league_id !== null);
        if (defaultShow?.default_league_id != null) {
          setLeagueId((prev) => prev ?? defaultShow.default_league_id);
        }
      }
    }
    getData();
  }, []);
  const selectLeague = (nextId: number) => {
    setLeagueId(nextId);
    setSelectedEpId(null);
    const url = new URL(window.location.href);
    url.searchParams.set("league", String(nextId));
    window.history.pushState({}, "", url);
  };
  const isTestMode = useMemo(
    () => new URLSearchParams(window.location.search).has("test"),
    [],
  );
  const [user, setUser] = useState<GoogleUser | null>(() =>
    new URLSearchParams(window.location.search).has("test")
      ? {
          credential: "test-alice",
          name: "Alice",
          email: "alice@example.com",
          picture: "",
          exp: Date.now() + 24 * 3600_000,
        }
      : loadStoredUser(),
  );
  const updateUser = (u: GoogleUser | null) => {
    if (!isTestMode) {
      storeUser(u);
    }
    setUser(u);
  };
  const [gisReady, setGisReady] = useState(false);
  const signInButton = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isTestMode) {
      return;
    }
    if (!googleClientId) {
      console.error("VITE_GOOGLE_CLIENT_ID is not set");
      return;
    }
    loadGis()
      .then(() => {
        google.accounts.id.initialize({
          client_id: googleClientId,
          auto_select: true,
          callback: (resp) => updateUser(parseCredential(resp.credential)),
        });
        setGisReady(true);
      })
      .catch((e) => console.error(e));
  }, []);
  useEffect(() => {
    if (!gisReady || user) {
      return;
    }
    if (signInButton.current) {
      google.accounts.id.renderButton(signInButton.current, {
        type: "standard",
        theme: "outline",
        size: "medium",
      });
    }
    // One Tap, which signs returning users back in automatically
    google.accounts.id.prompt();
  }, [gisReady, user]);
  // Google ID tokens can't be refreshed, so sign out when it expires
  useEffect(() => {
    if (!user) {
      return;
    }
    const timer = setTimeout(() => updateUser(null), user.exp - Date.now());
    return () => clearTimeout(timer);
  }, [user]);
  const signOut = () => {
    if (gisReady) {
      google.accounts.id.disableAutoSelect();
    }
    updateUser(null);
  };

  const [contestants, setContestants] = useState<Contestant[]>([]);
  const [contestantStatus, setContestantStatus] = useState([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [weekConfig, setWeekConfig] = useState<{
    expected: number[];
    multiplier: number[];
  }>({ expected: DEFAULT_EXPECTED, multiplier: DEFAULT_MULTIPLIER });
  const [picks, setPicks] = useState<PickRow[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [selectedEpId, setSelectedEpId] = useState<number | null>(null);

  const refreshLeaderboard = async () => {
    if (!leagueQuery) {
      return;
    }
    const response = await fetch(serverPath + "/leaderboard" + leagueQuery);
    if (response.ok) {
      setLeaderboard(await response.json());
    }
  };

  // Reload all league-scoped data when the selected league changes
  useEffect(() => {
    if (!leagueQuery) {
      return;
    }
    let cancelled = false;
    setContestants([]);
    setContestantStatus([]);
    setEpisodes([]);
    setSelectedEpId(null);
    setLeaderboard([]);

    async function loadLeagueData() {
      const [contRes, statusRes, epRes, configRes, lbRes] = await Promise.all([
        fetch(serverPath + "/contestants" + leagueQuery),
        fetch(serverPath + "/contestantStatus" + leagueQuery),
        fetch(serverPath + "/episodes" + leagueQuery),
        fetch(serverPath + "/config" + leagueQuery).catch(() => null),
        fetch(serverPath + "/leaderboard" + leagueQuery),
      ]);
      if (cancelled) {
        return;
      }
      const [contData, statusData, epData, configData, lbData] =
        await Promise.all([
          contRes.ok ? contRes.json() : [],
          statusRes.ok ? statusRes.json() : [],
          epRes.ok ? epRes.json() : [],
          configRes && configRes.ok ? configRes.json() : null,
          lbRes.ok ? lbRes.json() : [],
        ]);
      if (cancelled) {
        return;
      }
      const weekEps = (epData as Episode[])
        .filter((ep) => getWeekNumber(ep.name) !== null)
        .sort((a, b) => a.num - b.num);
      setContestants(contData);
      setContestantStatus(statusData);
      setEpisodes(weekEps);
      setSelectedEpId(weekEps[0]?.id ?? null);
      if (configData) {
        setWeekConfig(configData);
      }
      setLeaderboard(lbData);
    }

    loadLeagueData();
    return () => {
      cancelled = true;
    };
  }, [leagueQuery]);

  useEffect(() => {
    if (!leagueQuery) {
      setPicks([]);
      return;
    }
    let cancelled = false;
    setPicks([]);
    async function getData() {
      const response = user
        ? await authFetch(user, "/picks" + leagueQuery)
        : await fetch(serverPath + "/picks" + leagueQuery);
      if (cancelled) {
        return;
      }
      if (response.status === 401) {
        if (user && !isTestMode) {
          updateUser(null);
        }
        return;
      }
      if (response.ok) {
        setPicks(await response.json());
      }
    }
    getData();
    return () => {
      cancelled = true;
    };
  }, [user, leagueQuery]);

  const availableEpisodes = useMemo(
    () =>
      episodes.filter(
        (_ep, idx) => idx === 0 || Boolean(episodes[idx - 1].revealed),
      ),
    [episodes],
  );
  const selectedEpisode = useMemo(
    () => availableEpisodes.find((ep) => ep.id === selectedEpId) ?? null,
    [availableEpisodes, selectedEpId],
  );
  const selectedWeekNum = selectedEpisode
    ? getWeekNumber(selectedEpisode.name)
    : null;
  const maxPicksForWeek =
    selectedWeekNum !== null
      ? (weekConfig.expected[selectedWeekNum - 1] ?? 0)
      : 0;
  const weekMultiplier =
    selectedWeekNum !== null
      ? (weekConfig.multiplier[selectedWeekNum - 1] ?? 1)
      : 1;

  // Contestants not yet eliminated before the selected week
  const availableContestants = useMemo(() => {
    if (selectedWeekNum === null) {
      return [];
    }
    return [...contestants]
      .filter(
        (c) =>
          c.eliminated_week === null ||
          c.eliminated_week === undefined ||
          c.eliminated_week >= selectedWeekNum,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [contestants, selectedWeekNum]);

  const [draftIds, setDraftIds] = useState<Set<number>>(new Set());
  const [saveState, setSaveState] = useState<{
    saving: boolean;
    message: string | null;
    error: string | null;
  }>({ saving: false, message: null, error: null });

  // Sync draft selection with saved picks whenever the user switches weeks or loads picks
  useEffect(() => {
    if (selectedEpId === null) {
      setDraftIds(new Set());
      return;
    }
    const saved = new Set(
      picks
        .filter((p) => p.episode_id === selectedEpId && p.is_on)
        .map((p) => p.contestant_id),
    );
    setDraftIds(saved);
    setSaveState({ saving: false, message: null, error: null });
  }, [selectedEpId, picks]);

  const savedForSelectedWeek = useMemo(() => {
    if (selectedEpId === null) {
      return new Set<number>();
    }
    return new Set(
      picks
        .filter((p) => p.episode_id === selectedEpId && p.is_on)
        .map((p) => p.contestant_id),
    );
  }, [picks, selectedEpId]);

  const hasUnsavedChanges = useMemo(() => {
    if (draftIds.size !== savedForSelectedWeek.size) {
      return true;
    }
    for (const id of draftIds) {
      if (!savedForSelectedWeek.has(id)) {
        return true;
      }
    }
    return false;
  }, [draftIds, savedForSelectedWeek]);

  const toggleDraftPick = (contestantId: number) => {
    if (!user) {
      return;
    }
    setSaveState((prev) => ({ ...prev, message: null, error: null }));
    setDraftIds((prev) => {
      const next = new Set(prev);
      if (next.has(contestantId)) {
        next.delete(contestantId);
      } else if (next.size < maxPicksForWeek) {
        next.add(contestantId);
      }
      return next;
    });
  };

  const saveWeekPicks = async () => {
    if (!user || selectedEpId === null) {
      return;
    }
    setSaveState({ saving: true, message: null, error: null });
    const payload = availableContestants.map((c) => ({
      episode_id: selectedEpId,
      contestant_id: c.id,
      is_on: draftIds.has(c.id),
    }));
    try {
      const response = await authFetch(user, "/picks" + leagueQuery, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (response.status === 401) {
        if (!isTestMode) {
          updateUser(null);
        }
        return;
      }
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        setSaveState({
          saving: false,
          message: null,
          error: err.error || "Failed to save picks",
        });
        return;
      }
      const updatedPicks: PickRow[] = await response.json();
      setPicks(updatedPicks);
      await refreshLeaderboard();
      setSaveState({ saving: false, message: "Picks saved!", error: null });
    } catch (e) {
      setSaveState({
        saving: false,
        message: null,
        error: "Network error while saving picks",
      });
    }
  };

  const sortedContestants = useMemo(
    () =>
      [...contestants].sort((a: any, b: any) => {
        const aCount = contestantStatus.filter(
          (cs: any) => cs.contestant_id === a.id && cs.is_on,
        ).length;
        const bCount = contestantStatus.filter(
          (cs: any) => cs.contestant_id === b.id && cs.is_on,
        ).length;
        if (bCount === aCount) {
          return a.name?.localeCompare(b.name);
        }
        return bCount - aCount;
      }),
    [contestants, contestantStatus],
  );

  const latestEpId = Math.max(
    ...contestantStatus
      .filter((cs: any) => cs.is_on)
      .map((cs: any) => cs.episode_id),
  );
  // TODO ep id may not be sequential. . . use airdate instead
  return (
    <div className="App">
      <header className="auth-bar">
        <div className="header-left">
          {shows.length > 0 && (
            <label className="league-selector">
              <span>Show:</span>
              <select
                value={leagueId ?? ""}
                onChange={(e) => selectLeague(Number(e.target.value))}
              >
                {shows.map((s) => {
                  const year = s.latest_airdate
                    ? new Date(s.latest_airdate).getUTCFullYear()
                    : null;
                  return (
                    <option
                      key={s.id}
                      value={s.default_league_id ?? ""}
                      disabled={s.default_league_id === null}
                    >
                      {s.name}
                      {s.season ? ` Season ${s.season}` : ""}
                      {year ? ` (${year})` : ""}
                      {s.lead ? ` · ${formatLeadSeason(s.lead)}` : ""}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
        </div>
        <div className="auth-controls">
          {user ? (
            <>
              {user.picture && (
                <img
                  className="avatar"
                  alt=""
                  src={user.picture}
                  referrerPolicy="no-referrer"
                />
              )}
              <span>{user.name || user.email}</span>
              <button onClick={signOut}>Sign out</button>
            </>
          ) : (
            <div ref={signInButton} />
          )}
        </div>
      </header>
      <section className="picking-panel">
        {(() => {
          const selectedShow = shows.find(
            (s) => s.default_league_id === leagueId,
          );
          if (!selectedShow?.poster) {
            return null;
          }
          return (
            <div className="season-banner">
              <img
                className="season-poster"
                src={selectedShow.poster}
                alt={`${selectedShow.name || "Season"} ${selectedShow.season ?? ""} poster`}
              />
              <div className="season-banner-info">
                <div className="season-banner-title">
                  {selectedShow.name}
                  {selectedShow.season ? ` · Season ${selectedShow.season}` : ""}
                </div>
                {selectedShow.lead && (
                  <div className="season-banner-lead">
                    {formatLeadSeason(selectedShow.lead)}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
        <div className="week-tabs">
          {availableEpisodes.map((ep) => {
            const wNum = getWeekNumber(ep.name);
            const limit = wNum !== null ? (weekConfig.expected[wNum - 1] ?? 0) : 0;
            const mult = wNum !== null ? (weekConfig.multiplier[wNum - 1] ?? 1) : 1;
            const savedCount = picks.filter(
              (p) => p.episode_id === ep.id && p.is_on,
            ).length;
            const isSelected = ep.id === selectedEpId;
            return (
              <button
                key={ep.id}
                className={`week-tab ${isSelected ? "active" : ""}`}
                onClick={() => setSelectedEpId(ep.id)}
              >
                <div className="week-tab-title">
                  Week {wNum} {ep.locked ? "🔒" : ""}
                </div>
                <div className="week-tab-meta">
                  {user ? `${savedCount}/${limit}` : `${limit} picks`} · {mult}pt
                </div>
              </button>
            );
          })}
        </div>
        {selectedEpisode && (
          <div className="picking-body">
            <div className="picking-header">
              <div>
                <h2>{selectedEpisode.name.replace(/^"|"$/g, "")}</h2>
                <div className="picking-subtitle">
                  {new Date(selectedEpisode.airdate).toLocaleDateString()} ·{" "}
                  {availableContestants.length} contestants available · Pick{" "}
                  {maxPicksForWeek} ({weekMultiplier}{" "}
                  {weekMultiplier === 1 ? "pt" : "pts"} each) ·{" "}
                  {selectedEpisode.locked
                    ? "Locked (8:00 PM PT on airdate)"
                    : "Locks at 8:00 PM PT on airdate"}
                </div>
              </div>
              {user ? (
                <div className="picking-actions">
                  <span className="pick-counter">
                    Selected: {draftIds.size} / {maxPicksForWeek}
                  </span>
                  <button
                    className="save-picks-btn"
                    onClick={saveWeekPicks}
                    disabled={
                      Boolean(selectedEpisode.locked) ||
                      saveState.saving ||
                      !hasUnsavedChanges
                    }
                  >
                    {selectedEpisode.locked
                      ? "Locked"
                      : saveState.saving
                        ? "Saving..."
                        : "Save Picks"}
                  </button>
                </div>
              ) : (
                <div className="picking-signin-note">
                  Sign in above to select and save your picks.
                </div>
              )}
            </div>
            {saveState.error && (
              <div className="pick-feedback error">{saveState.error}</div>
            )}
            {saveState.message && (
              <div className="pick-feedback success">{saveState.message}</div>
            )}
            {(user || picks.length > 0) && (
              <div className="saved-picks-summary">
                <strong>Your saved picks ({savedForSelectedWeek.size}):</strong>{" "}
                {savedForSelectedWeek.size > 0
                  ? availableContestants
                      .filter((c) => savedForSelectedWeek.has(c.id))
                      .map((c) => c.name)
                      .join(", ")
                  : "None for this week."}
              </div>
            )}
            <div className="contestant-grid">
              {availableContestants.map((c) => {
                const isSelected = draftIds.has(c.id);
                const isDisabled =
                  !user ||
                  Boolean(selectedEpisode.locked) ||
                  (!isSelected && draftIds.size >= maxPicksForWeek);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`contestant-card ${isSelected ? "selected" : ""}`}
                    disabled={isDisabled}
                    onClick={() => toggleDraftPick(c.id)}
                  >
                    {c.img && (
                      <img
                        className="contestant-avatar"
                        alt={c.name}
                        src={c.img}
                      />
                    )}
                    <span className="contestant-name">{c.name}</span>
                    {isSelected && <span className="contestant-check">✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>
      <section className="episodes-panel">
        <div className="episodes-header">
          <h2>Episodes</h2>
          <div className="episodes-legend">
            <span className="legend-item">
              <span className="legend-swatch safe" /> Safe (Correct pick)
            </span>
            <span className="legend-item">
              <span className="legend-swatch eliminated" /> Eliminated
            </span>
            <span className="legend-item">
              <span className="legend-swatch out" /> Already out
            </span>
            {user && (
              <span className="legend-item">
                <span className="legend-pick">✓</span> Your pick
              </span>
            )}
          </div>
        </div>
        <div className="episodes-table-wrap">
          <table className="episodes-table">
            <thead>
              <tr>
                <th className="episodes-contestant-col">Contestant</th>
                {episodes.map((ep) => {
                  const wNum = getWeekNumber(ep.name);
                  return (
                    <th key={ep.id} className="episodes-week-col">
                      <div>Week {wNum}</div>
                      <div className="episodes-airdate">
                        {new Date(ep.airdate).toLocaleDateString()}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedContestants.map((c, rowIdx) => {
                return (
                  <tr key={c.id}>
                    <td className="episodes-contestant-cell">
                      {c.img && (
                        <img
                          className="contestant-avatar"
                          alt={c.name}
                          src={c.img}
                        />
                      )}
                      <span>{c.name}</span>
                    </td>
                    {episodes.map((ep) => {
                      const wNum = getWeekNumber(ep.name) ?? 0;
                      const isRevealed = Boolean(ep.revealed);
                      const isAlreadyOut =
                        isRevealed &&
                        c.eliminated_week !== null &&
                        c.eliminated_week < wNum;
                      const isEliminatedThisWeek =
                        isRevealed && c.eliminated_week === wNum;
                      const isSafe =
                        isRevealed && !isAlreadyOut && !isEliminatedThisWeek;
                      const statusClass = !isRevealed
                        ? "cell-pending"
                        : isAlreadyOut
                          ? "cell-out"
                          : isEliminatedThisWeek
                            ? "cell-eliminated"
                            : "cell-safe";
                      const isPicked = picks.some(
                        (p) =>
                          p.episode_id === ep.id &&
                          p.contestant_id === c.id &&
                          p.is_on,
                      );
                      const weekLimit =
                        wNum >= 1 ? (weekConfig.expected[wNum - 1] ?? 0) : 0;
                      const isCutoff =
                        weekLimit > 0 && rowIdx === weekLimit - 1;
                      const weekMult =
                        wNum >= 1 ? (weekConfig.multiplier[wNum - 1] ?? 1) : 0;
                      const points = isPicked && isSafe ? weekMult : 0;
                      return (
                        <td
                          key={ep.id}
                          className={`episodes-status-cell ${statusClass} ${
                            isPicked ? "cell-picked" : ""
                          } ${isCutoff ? "cell-cutoff" : ""}`}
                        >
                          {!isRevealed ? (
                            isPicked ? (
                              <span className="pending-pick" title="Your pick">
                                ✓
                              </span>
                            ) : null
                          ) : !isAlreadyOut && isPicked ? (
                            <span
                              className={`pick-badge ${
                                isSafe ? "correct" : "wrong"
                              }`}
                              title={
                                isSafe
                                  ? `Correct pick (+${points} pts)`
                                  : "Incorrect pick (0 pts)"
                              }
                            >
                              {points}
                            </span>
                          ) : (
                            <span className="missed-points">0</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="leaderboard-panel">
        <h2>Standings</h2>
        {leaderboard.length === 0 ? (
          <div className="leaderboard-empty">No player scores yet.</div>
        ) : (
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Player</th>
                {episodes.map((ep) => (
                  <th key={ep.id} className="leaderboard-week">
                    W{getWeekNumber(ep.name)}
                  </th>
                ))}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const sorted = [...leaderboard].sort(
                  (a, b) =>
                    b.score - a.score ||
                    (a.name || a.uid).localeCompare(b.name || b.uid),
                );
                let rank = 1;
                return sorted.map((entry, idx) => {
                  if (idx > 0 && entry.score < sorted[idx - 1].score) {
                    rank = idx + 1;
                  }
                  return (
                    <tr key={entry.uid}>
                      <td className="leaderboard-rank">#{rank}</td>
                      <td className="leaderboard-player">
                        {entry.img && (
                          <img
                            className="leaderboard-avatar"
                            alt=""
                            src={entry.img}
                            referrerPolicy="no-referrer"
                          />
                        )}
                        <span>{entry.name || entry.uid}</span>
                      </td>
                      {episodes.map((ep) => (
                        <td key={ep.id} className="leaderboard-week">
                          {entry.weekly_scores?.[ep.id] ?? 0}
                        </td>
                      ))}
                      <td className="leaderboard-score">{entry.score}</td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function getCurrentDate() {
  return new Date();
}

export default App;
