CREATE TABLE show(
    id serial PRIMARY KEY,
    name text,
    season int,
    start_date timestamp with time zone,
    end_date timestamp with time zone,
    UNIQUE(name, season)
);

CREATE TABLE episode(
    id serial PRIMARY KEY,
    show_id int REFERENCES show(id) ON DELETE CASCADE,
    num int,
    name text,
    airdate timestamp with time zone
);
CREATE UNIQUE INDEX on episode(show_id, num);

CREATE TABLE contestant(
    id serial PRIMARY KEY,
    show_id int REFERENCES show(id)  ON DELETE CASCADE,
    name text,
    img text,
    eliminated_week int -- NULL for the winner
);
CREATE UNIQUE INDEX on contestant(show_id, name);

-- CREATE TABLE contestant_status(
--     episode_id REFERENCES episode(id) ON DELETE CASCADE,
--     contestant_id REFERENCES contestant(id)  ON DELETE CASCADE,
--     is_on boolean,
--     PRIMARY KEY(episode_id, contestant_id)
-- );

CREATE TABLE raw_contestant_status(
    show_id int REFERENCES show(id) ON DELETE CASCADE,
    name text,
    episode int,
    is_on boolean,
    PRIMARY KEY(show_id, name, episode)
);

CREATE TABLE account(
    uid text PRIMARY KEY,
    name text,
    email text,
    img text
);

CREATE TABLE league(
    id serial PRIMARY KEY,
    show_id int REFERENCES show(id),
    admin_uids text[]
);

CREATE TABLE league_unlocks(
    league_id int REFERENCES league(id),
    episode_id int REFERENCES episode(id),
    unlocked boolean,
    PRIMARY KEY(league_id, episode_id)
);

CREATE TABLE league_account(
    league_id int REFERENCES league(id) ON DELETE CASCADE,
    uid text,
    score int,
    PRIMARY KEY(league_id, uid)
);

CREATE TABLE pick(
    league_id int REFERENCES league(id) ON DELETE CASCADE,
    episode_id int REFERENCES episode(id),
    uid text REFERENCES account(uid),
    contestant_id int,
    is_on boolean,
    PRIMARY KEY (league_id, episode_id, uid, contestant_id)
);
