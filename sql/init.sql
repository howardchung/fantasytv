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
    show_id int REFERENCES show(id),
    num int,
    name text,
    airdate timestamp with time zone
);
CREATE UNIQUE INDEX on episode(show_id, num);

CREATE TABLE contestant(
    id serial PRIMARY KEY,
    show_id int REFERENCES show(id),
    name text,
    img text
);
CREATE UNIQUE INDEX on contestant(show_id, name);

CREATE TABLE contestant_status(
    episode_id REFERENCES episode(id),
    contestant_id REFERENCES contestant(id),
    is_on boolean,
    PRIMARY KEY(episode_id, contestant_id)
);

CREATE TABLE pick(
    uid text,
    episode_id int,
    contestant_id int,
    is_on boolean,
    PRIMARY KEY (episode_id, uid, contestant_id)
);

CREATE TABLE raw_contestant_status(
    show_id int REFERENCES show(id),
    name text,
    episode int,
    is_on boolean,
    PRIMARY KEY(show_id, name, episode)
);

CREATE TABLE score(
    show_id int REFERENCES show(id),
    uid text,
    score int,
    PRIMARY KEY(show_id, uid)
);