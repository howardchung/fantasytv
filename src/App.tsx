import React, { useEffect, useMemo, useState } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { auth, googleProvider } from "./firebase";
import "./App.css";

const serverPath = `${window.location.protocol}//${
  import.meta.env.DEV
    ? `${window.location.hostname}:3000`
    : window.location.host
}`;

// Sends the signed-in user's Firebase ID token so the server knows who is calling
async function authFetch(user: User, path: string, init: RequestInit = {}) {
  const token = await user.getIdToken();
  return fetch(serverPath + path, {
    ...init,
    headers: {
      ...init.headers,
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u);
        setAuthLoading(false);
      }),
    [],
  );
  const signIn = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      console.error("Sign-in failed", e);
    }
  };

  const [contestants, setContestants] = useState([]);
  useEffect(() => {
    async function getData() {
      const response = await fetch(serverPath + "/contestants");
      setContestants(await response.json());
    }
    getData();
  }, []);
  const [contestantStatus, setContestantStatus] = useState([]);
  useEffect(() => {
    async function getData() {
      const response = await fetch(serverPath + "/contestantStatus");
      setContestantStatus(await response.json());
    }
    getData();
  }, []);
  const [episodes, setEpisodes] = useState([]);
  useEffect(() => {
    async function getData() {
      const response = await fetch(serverPath + "/episodes");
      const data = await response.json();
      setEpisodes(data.filter((ep: any) => ep.name.startsWith('"Week')));
    }
    getData();
  }, []);
  const [picks, setPicks] = useState<
    { contestant_id: number; episode_id: Number; is_on: boolean }[]
  >([]);
  useEffect(() => {
    if (!user) {
      setPicks([]);
      return;
    }
    async function getData() {
      const response = await authFetch(user!, "/picks");
      setPicks(await response.json());
    }
    getData();
  }, [user]);
  const [leaderboard, setLeaderboard] = useState<[]>([]);
  useEffect(() => {
    async function getData() {
      const response = await fetch(serverPath + "/leaderboard");
      setLeaderboard(await response.json());
    }
    getData();
  }, []);

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

  const savePicks = async (e: any, epId: number, contId: number) => {
    if (!user) {
      return;
    }
    const checked = e.target.checked;
    const newPicks = [...picks];
    const exists = newPicks.find(
      (p) => p.episode_id === epId && p.contestant_id === contId,
    );
    if (exists) {
      exists.is_on = checked;
    } else {
      newPicks.push({
        episode_id: epId,
        contestant_id: contId,
        is_on: checked,
      });
    }
    setPicks(newPicks);
    // submit to server
    // TODO only send changed pick
    await authFetch(user, "/picks", {
      method: "POST",
      body: JSON.stringify(newPicks),
    });
  };
  const latestEpId = Math.max(
    ...contestantStatus
      .filter((cs: any) => cs.is_on)
      .map((cs: any) => cs.episode_id),
  );
  // TODO ep id may not be sequential. . . use airdate instead
  return (
    <div className="App">
      <header className="auth-bar">
        {authLoading ? null : user ? (
          <>
            {user.photoURL && (
              <img
                className="avatar"
                alt=""
                src={user.photoURL}
                referrerPolicy="no-referrer"
              />
            )}
            <span>{user.displayName || user.email}</span>
            <button onClick={() => signOut(auth)}>Sign out</button>
          </>
        ) : (
          <>
            <span>Sign in to make picks</span>
            <button onClick={signIn}>Sign in with Google</button>
          </>
        )}
      </header>
      <table>
        <tbody>
          <tr>
            <td>Name</td>
            {episodes.map((ep: any) => {
              return (
                <td key={ep.id} style={{ width: 80 }}>
                  <div>{ep.name}</div>
                  <div>{new Date(ep.airdate).toLocaleDateString()}</div>
                </td>
              );
            })}
          </tr>
          {sortedContestants.map((c: any) => {
            const contestantLastEpId = Math.max(
              ...contestantStatus
                .filter((cs: any) => cs.contestant_id === c.id && cs.is_on)
                .map((cs: any) => cs.episode_id),
            );
            const isCurrentlyOn = contestantLastEpId === latestEpId;
            return (
              <tr key={c.id}>
                <td>
                  <img alt={c.name} style={{ width: 25 }} src={c.img} />
                  {c.name}
                </td>
                {episodes.map((ep: any, epIndex: number) => {
                  const res = contestantStatus.find(
                    (cs: any) =>
                      c.id === cs.contestant_id && cs.episode_id === ep.id,
                  ) as any;
                  let backgroundColor = res?.is_on
                    ? "green"
                    : isCurrentlyOn
                      ? "gray"
                      : "red";
                  const isChecked = picks.some(
                    (p: any) =>
                      p.episode_id === ep.id &&
                      p.contestant_id === c.id &&
                      p.is_on,
                  );
                  const advanced = ep.id < contestantLastEpId;
                  return (
                    <td style={{ backgroundColor }} key={ep.id}>
                      {user &&
                        (ep.id <= contestantLastEpId ||
                          isCurrentlyOn ||
                          isChecked) && (
                        <input
                          onChange={(e) => savePicks(e, ep.id, c.id)}
                          type="checkbox"
                          checked={isChecked}
                        ></input>
                      )}
                      {advanced && "→"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div>{JSON.stringify(leaderboard)}</div>
    </div>
  );
}

function getCurrentDate() {
  return new Date();
}

export default App;
