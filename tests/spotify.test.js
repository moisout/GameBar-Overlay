// Spotify Connect in the Music card, against a server in the place of Spotify: signing in, the player of a playback
// on another device, its controls, the device list and the volume.
const Soup = imports.gi.Soup;
const music = gamebar._music;
const spotify = gamebar._spotify;

const devices = [
    { id: 'phone', name: 'Pixel 9', type: 'Smartphone', is_restricted: false, supports_volume: false, volume_percent: 100 },
    { id: 'speaker', name: 'Living Room', type: 'Speaker', is_restricted: false, supports_volume: true, volume_percent: 40 },
];
const playback = {
    is_playing: true,
    shuffle_state: false,
    progress_ms: 61000,
    device: devices[1],
    item: {
        name: 'Weightless',
        uri: 'spotify:track:weightless',
        duration_ms: 240000,
        artists: [{ name: 'Marconi Union' }],
        album: { images: [] },
    },
    actions: { disallows: { skipping_prev: true } },
};
// What the card sent, as "PUT /v1/me/player/pause".
const requests = [];
const accessToken = 'valid';
// The tracks in the library of the user. Like Spotify, the library tells the state before a change for a few seconds.
const library = new Set();
let libraryShown = new Set();
let libraryChanged = 0;
const LIBRARY_LAG = 1000;
const fullScope = 'user-read-playback-state user-modify-playback-state user-library-read user-library-modify';
// The forms sent to the token endpoint, and what it answers next.
const tokenRequests = [];
let tokenAnswer = null;

const reply = (message, status, data = null) => {
    message.set_status(status, null);
    if (data) message.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(JSON.stringify(data)));
};
const server = new Soup.Server();
server.add_handler(null, (server_, message, path, query) => {
    const method = message.get_method();
    if (path === '/api/token') {
        const form = new TextDecoder().decode(message.get_request_body().flatten().toArray());
        tokenRequests.push(Object.fromEntries(form.split('&').map(pair => pair.split('=').map(decodeURIComponent))));
        reply(message, 200, tokenAnswer);
        tokenAnswer = { access_token: accessToken, expires_in: 3600, refresh_token: 'refresh-2', scope: fullScope };
        return;
    }
    if (message.get_request_headers().get_one('Authorization') !== `Bearer ${accessToken}`) {
        reply(message, 401, { error: { status: 401, message: 'The access token expired' } });
        return;
    }
    if (method !== 'GET') {
        const length = message.get_request_headers().get_one('Content-Length');
        requests.push(`${method} ${path}${query ? `?${Object.entries(query).map(pair => pair.join('=')).join('&')}` : ''}`);
        if (length === null) log(`FAIL ${method} ${path} has no Content-Length`);
    }

    if (method === 'GET' && path === '/v1/me/player') {
        reply(message, 200, playback);
    } else if (method === 'GET' && path === '/v1/me/player/devices') {
        reply(message, 200, { devices });
    } else if (path === '/v1/me/player/pause') {
        playback.is_playing = false;
        reply(message, 204);
    } else if (path === '/v1/me/player/play') {
        playback.is_playing = true;
        reply(message, 204);
    } else if (method === 'GET' && path === '/v1/me/library/contains') {
        if (Date.now() - libraryChanged >= LIBRARY_LAG) libraryShown = new Set(library);
        reply(message, 200, query.uris.split(',').map(uri => libraryShown.has(uri)));
    } else if (path === '/v1/me/library') {
        libraryShown = new Set(library);
        libraryChanged = Date.now();
        query.uris.split(',').forEach(uri => (method === 'PUT' ? library.add(uri) : library.delete(uri)));
        reply(message, 200);
    } else if (path === '/v1/me/player/shuffle') {
        playback.shuffle_state = query.state === 'true';
        reply(message, 204);
    } else if (path === '/v1/me/player/next') {
        playback.item = { ...playback.item, name: 'Next Song', uri: 'spotify:track:next' };
        playback.progress_ms = 0;
        reply(message, 204);
    } else if (path === '/v1/me/player/seek') {
        playback.progress_ms = Number(query.position_ms);
        reply(message, 204);
    } else if (path === '/v1/me/player/volume') {
        playback.device.volume_percent = Number(query.volume_percent);
        reply(message, 204);
    } else if (method === 'PUT' && path === '/v1/me/player') {
        const body = JSON.parse(new TextDecoder().decode(message.get_request_body().flatten().toArray()));
        playback.device = devices.find(device => device.id === body.device_ids[0]);
        reply(message, 204);
    } else {
        reply(message, 404);
    }
});
server.listen_local(18975, Soup.ServerListenOptions.IPV4_ONLY);
spotify._apiUrl = 'http://127.0.0.1:18975/v1';
spotify._accountsUrl = 'http://127.0.0.1:18975';

await openOverlay();
check(spotify.state === 'unconfigured' && !music._connectList.actor.visible && !music._deviceList.actor.visible,
    'without a client ID the card has nothing of Spotify');

settings.set_string('spotify-client-id', 'test-client');
await sleep(4500);
check(spotify.state === 'signed-out', `no token is found in the session without a keyring (${spotify.state})`);
check(music._connectList.actor.visible, 'the card offers to connect');
await shot('spotify-signed-out', music._addonContainer);

// Signing in is in the browser, which Spotify sends back to the card with a code. The scenario is the browser.
let authorizeUrl = null;
spotify._openBrowser = () => {
    authorizeUrl = spotify._authorizeUrl;
};
const get = url => new Promise(resolve => {
    const message = Soup.Message.new('GET', url);
    new Soup.Session().send_and_read_async(message, 0, null, (session, result) => {
        session.send_and_read_finish(result);
        resolve(message.get_status());
    });
});
let refused = false;
spotify.authorize().catch(() => {
    refused = true;
});
const asked = Object.fromEntries(authorizeUrl.split('?')[1].split('&').map(pair => pair.split('=').map(decodeURIComponent)));
check(authorizeUrl.startsWith('http://127.0.0.1:18975/authorize?') && asked.client_id === 'test-client' &&
    asked.redirect_uri === 'http://127.0.0.1:18974/callback' && asked.code_challenge_method === 'S256',
    'the browser is sent to Spotify with the client ID and the redirect URI');
const refusedStatus = await get('http://127.0.0.1:18974/callback?code=stolen&state=wrong');
await sleep(300);
check(refusedStatus === 400 && refused && spotify.state === 'signed-out', 'a code with another state is refused');

// The first try ended, the next one has a state and a verifier of its own. The access token Spotify gives out is
// one it no longer takes, so the card has to renew it.
tokenAnswer = { access_token: 'expired', expires_in: 3600, refresh_token: 'refresh-1', scope: fullScope };
spotify.authorize().catch(e => log(`FAIL signing in: ${e.message}`));
const state = decodeURIComponent(authorizeUrl.match(/state=([^&]+)/)[1]);
check(await get(`http://127.0.0.1:18974/callback?code=the-code&state=${encodeURIComponent(state)}`) === 200,
    'the code of Spotify is taken');
await sleep(1500);
check(tokenRequests[0]?.code === 'the-code' && tokenRequests[0]?.code_verifier?.length === 64 &&
    tokenRequests[0]?.client_id === 'test-client', 'and exchanged for a token with the code verifier');
check(tokenRequests[1]?.grant_type === 'refresh_token' && tokenRequests[1]?.refresh_token === 'refresh-1' &&
    spotify._refreshToken === 'refresh-2', 'a refused access token is renewed');
check(spotify.ready && music._shownPlayer === spotify, 'the playback on another device is the shown player');
check(!music._connectList.actor.visible, 'the offer to connect is gone');
check(music._titleLabel.text === 'Weightless' && music._subtitleLabel.text === 'Marconi Union · Spotify',
    `the card shows the track (${music._titleLabel.text}, ${music._subtitleLabel.text})`);
check(music._elapsedLabel.text.startsWith('1:0') && music._lengthLabel.text === '4:00',
    `and its position (${music._elapsedLabel.text} of ${music._lengthLabel.text})`);
check(!music._previousButton.reactive && music._nextButton.reactive, 'a button Spotify disallows is greyed out');
check(music._deviceList.actor.visible && music._deviceRow._valueLabel.text === 'Living Room', 'the device row names the device');
check(music._volumeRow.visible && Math.abs(music._volumeSlider.value - 0.4) < 0.01, 'with its volume');
await shot('spotify-playing', music._addonContainer);

check(music._likeButton.visible && music._likeButton.reactive && !spotify.saved, 'the track is not liked yet');
await shot('spotify-not-liked', music._progressRow, 4);
await click(music._likeButton);
check(!spotify.saved, 'the click alone does not show it as liked');
await sleep(500);
check(requests.includes('PUT /v1/me/library?uris=spotify:track:weightless') && library.has('spotify:track:weightless'),
    'liking adds the track to the Liked Songs');
check(!spotify.saved && music._likeButton.reactive, 'Spotify still tells it is not liked right after');
await sleep(2500);
check(spotify.saved && music._likeButton.has_style_class_name('gamebar-icon-button-on'), 'and is asked again, then it is');
check(music._shuffleButton.visible && !spotify.shuffle, 'shuffle is off');
await click(music._shuffleButton);
await sleep(1500);
check(requests.includes('PUT /v1/me/player/shuffle?state=true') && spotify.shuffle &&
    music._shuffleButton.has_style_class_name('gamebar-icon-button-on'), 'the shuffle button turns shuffle on');
await shot('spotify-liked', music._addonContainer);
await sleep(1000);
await click(music._likeButton);
await sleep(3000);
check(requests.includes('DELETE /v1/me/library?uris=spotify:track:weightless') && !library.has('spotify:track:weightless') &&
    !spotify.saved, 'a second click removes it');
await click(music._shuffleButton);
await sleep(1500);
check(requests.includes('PUT /v1/me/player/shuffle?state=false') && !spotify.shuffle, 'and turns shuffle off');

// Liked on the phone meanwhile, long enough ago for the library to tell it.
library.add('spotify:track:next');
libraryChanged = 0;
await click(music._playPauseButton);
check(spotify.status === 'Paused', 'pause shows right away');
await sleep(1500);
check(requests.includes('PUT /v1/me/player/pause') && spotify.status === 'Paused', 'and is sent to Spotify');
await click(music._playPauseButton);
await click(music._nextButton);
await sleep(1500);
check(requests.includes('PUT /v1/me/player/play') && requests.includes('POST /v1/me/player/next'), 'play and next are sent');
check(music._titleLabel.text === 'Next Song', `the next track is shown (${music._titleLabel.text})`);
check(spotify.saved, 'whether the new track is liked is asked for');

await click(music._slider);
await sleep(1500);
const seek = requests.find(request => request.startsWith('PUT /v1/me/player/seek?position_ms='));
check(!!seek && Math.abs(Number(seek.split('=')[1]) - 120000) < 10000, `a click on the slider seeks (${seek})`);

await click(music._volumeSlider);
await sleep(1500);
const volume = requests.filter(request => request.startsWith('PUT /v1/me/player/volume?volume_percent='));
check(volume.length === 1 && Math.abs(Number(volume[0].split('=')[1]) - 50) < 5, `the volume slider sets the volume (${volume})`);

await click(music._deviceRow._button);
await sleep(600);
check(music._deviceRow.expanded && music._deviceRow._choices.get_n_children() === 4, 'the device row opens the list of the devices');
await shot('spotify-devices', music._addonContainer);
await click(music._deviceRow._choices.get_child_at_index(1));
await sleep(1500);
check(requests.includes('PUT /v1/me/player') && playback.device.id === 'phone', 'a device of the list takes over the playback');
check(music._deviceRow._valueLabel.text === 'Pixel 9' && !music._deviceRow.expanded, 'the device row names it and the list closes');
check(!music._volumeRow.visible, 'a device without a volume has no volume row');

// A sign-in from before liking was there.
spotify._scopes = ['user-read-playback-state', 'user-modify-playback-state'];
spotify._queueChanged();
await sleep(300);
check(music._connectList.actor.visible && music._connectLabel.text === 'Connect again to like tracks' &&
    !music._likeButton.visible && music._shuffleButton.visible, 'without the library scopes the card offers to connect again');
spotify._scopes = fullScope.split(' ');
spotify._queueChanged();
await sleep(300);

const polls = () => spotify._pollCount;
gamebar._closeOverlay();
await closed();
const pollsClosed = polls();
await sleep(4000);
check(polls() === pollsClosed && spotify._pollId === 0, 'nothing is asked while the overlay is closed');

await openOverlay();
settings.set_string('spotify-client-id', '');
await sleep(500);
check(spotify.state === 'unconfigured' && !music._deviceList.actor.visible && music._emptyList.actor.visible,
    'clearing the client ID signs out');
server.disconnect();
