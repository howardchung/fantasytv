import React, { useEffect, useMemo, useState } from 'react';
import './App.css';
import axios from 'axios';
import { next } from 'cheerio/lib/api/traversing';

const serverPath = process.env.REACT_APP_SERVER_PATH ?? 'https://vivacious-underwear-newt.cyclic.app';

function App() {
  const [contestants, setContestants] = useState([]);
  useEffect(() => {
    async function getData() {
      const response = await axios.get(serverPath + '/contestants');
      setContestants(response.data);
    }
    getData();
  }, []);
  const [contestantStatus, setContestantStatus] = useState([]);
  useEffect(() => {
    async function getData() {
      const response = await axios.get(serverPath + '/contestantStatus');
      setContestantStatus(response.data);
    }
    getData();
  }, []);
  const [episodes, setEpisodes] = useState([]);
  useEffect(() => {
    async function getData() {
      const response = await axios.get(serverPath + '/episodes');
      setEpisodes(response.data.filter((ep: any) => ep.name.startsWith('"Week')));
    }
    getData();
  }, []);
  const [picks, setPicks] = useState<{contestant_id: number, episode_id: Number, is_on: boolean}[]>([]);
  useEffect(() => {
    async function getData() {
      const response = await axios.get(serverPath + '/picks');
      setPicks(response.data);
    }
    getData();
  }, []);
  const [leaderboard, setLeaderboard] = useState<[]>([]);
  useEffect(() => {
    async function getData() {
      const response = await axios.get(serverPath + '/leaderboard');
      setLeaderboard(response.data);
    }
    getData();
  }, []);

  const sortedContestants = useMemo(() => [...contestants].sort((a: any, b: any) => {
    const aCount = contestantStatus.filter((cs: any) => cs.contestant_id === a.id && cs.is_on).length;
    const bCount = contestantStatus.filter((cs: any) => cs.contestant_id === b.id && cs.is_on).length;
    if (bCount === aCount) {
      return a.name?.localeCompare(b.name);
    }
    return bCount - aCount;
  }), [contestants, contestantStatus]);

  const savePicks = async (e: any, epId: number, contId: number) => {
    const checked = e.target.checked;
    const newPicks = [...picks];
    const exists = newPicks.find(p => p.episode_id === epId && p.contestant_id === contId);
    if (exists) {
      exists.is_on = checked;
    } else {
       newPicks.push({ episode_id: epId, contestant_id: contId, is_on: checked});
    }
    setPicks(newPicks);
    // submit to server
    // TODO only send changed pick
    await axios.post(serverPath + '/picks', newPicks);
  };
  const latestEpId = Math.max(...contestantStatus.filter((cs: any) => cs.is_on).map((cs: any) => cs.episode_id));
  // TODO ep id may not be sequential. . . use airdate instead
  return (
    <div className="App">
      <table>
          <tbody>
        <tr>
          <td>Name</td>
          {episodes.map((ep: any) => {
            return <td key={ep.id} style={{ width: 80}}>
              <div>{ep.name}</div>
              <div>{new Date(ep.airdate).toLocaleDateString()}</div>
            </td>
          })}
        </tr>
        {sortedContestants.map((c: any) => {
          const contestantLastEpId = Math.max(...contestantStatus.filter((cs: any) => cs.contestant_id === c.id && cs.is_on).map((cs: any) => cs.episode_id));
          const isCurrentlyOn = contestantLastEpId === latestEpId;
          return <tr key={c.id}>
            <td>
              <img alt={c.name} style={{ width: 25 }} src={c.img} />{c.name}
            </td>
            {episodes.map((ep: any, epIndex: number) => {
              const res = contestantStatus.find((cs: any) => c.id === cs.contestant_id && cs.episode_id === ep.id) as any;
              let backgroundColor = res?.is_on ? 'green' : (isCurrentlyOn ? 'gray' : 'red');
              const isChecked = picks.some((p: any) => p.episode_id === ep.id && p.contestant_id === c.id && p.is_on);
              const advanced = ep.id < contestantLastEpId;
              return <td style={{ backgroundColor }} key={ep.id}>
                {(ep.id <= contestantLastEpId || isCurrentlyOn || isChecked) && <input onChange={(e) => savePicks(e, ep.id, c.id)} type="checkbox" checked={isChecked}></input>}
                {advanced && '→'}
              </td>
            })}
          </tr>
        })}
        </tbody>
      </table>
      <div>{JSON.stringify(leaderboard)}</div>
    </div>
  );
}

function getCurrentDate () {
  return new Date();
}

export default App;
