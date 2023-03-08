import React, { useEffect, useState } from 'react';
import './App.css';
import axios from 'axios';

function App() {
  const [contestantStatus, setContestantStatus] = useState([]);
  useEffect(() => {
    async function getData() {
      const response = await axios.get('/contestantStatus');
      setContestantStatus(response.data);
    }
    getData();
  }, []);
  const [episodes, setEpisodes] = useState([]);
  useEffect(() => {
    async function getData() {
      const response = await axios.get('/episodes');
      setEpisodes(response.data);
    }
    getData();
  }, []);
  return (
    <div className="App">
      {JSON.stringify(episodes)}
      {JSON.stringify(contestantStatus)}
    </div>
  );
}

export default App;
