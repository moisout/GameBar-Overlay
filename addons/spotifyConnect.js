import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { withTimeout, SPOTIFY_REDIRECT_PORT, SPOTIFY_REDIRECT_URI } from '../utils.js';

// The playback of a Spotify account over the Web API, on whichever device it plays: a phone, a speaker or this
// computer. Spotify only gives the extension access as an app the user registered, its client ID is a setting.
// Signing in is the authorization code flow with PKCE, which needs no client secret.
const API_URL = 'https://api.spotify.com/v1';
const ACCOUNTS_URL = 'https://accounts.spotify.com';
// Liking a track needs the library scopes, which a sign-in from before they were asked for does not have.
const LIBRARY_SCOPES = ['user-library-read', 'user-library-modify'];
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', ...LIBRARY_SCOPES].join(' ');

// The Web API does not announce changes, the playback is asked for this often while a card shows it. In milliseconds.
const POLL_INTERVAL = 3000;
// The devices, and whether the track is liked, are asked for with every poll while the device list is open, otherwise
// with every fifth. Whether a new track is liked is asked for right away.
const DEVICES_POLLS = 5;
// Spotify still reports the old state right after a command.
const COMMAND_SETTLE = 700;
// The volume slider sends its last value after this long without a change.
const VOLUME_DELAY = 250;
// A session without a keyring may never answer. In milliseconds.
const KEYRING_TIMEOUT = 3000;
// How long the card waits for the user to sign in in the browser, in seconds.
const AUTHORIZE_TIMEOUT = 300;
// After a like the library is asked for right away and again this long after, in case Spotify still told the old
// state. In milliseconds.
const SAVED_RECHECK = 2000;
// The access token is renewed this long before it runs out, in seconds.
const TOKEN_MARGIN = 60;

// Soup has no name for it.
const STATUS_TOO_MANY_REQUESTS = 429;

const DEVICE_ICONS = {
    Computer: 'computer-symbolic',
    Smartphone: 'phone-symbolic',
    Tablet: 'phone-symbolic',
    TV: 'tv-symbolic',
    STB: 'tv-symbolic',
    CastVideo: 'tv-symbolic',
    GameConsole: 'input-gaming-symbolic',
};
const DEFAULT_DEVICE_ICON = 'audio-speakers-symbolic';

const isCancelled = (error) => error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;

const logError = (error) => {
    if (!isCancelled(error)) console.warn(`GameBar: Spotify: ${error.message}`);
};

const cancelledError = () => GLib.Error.new_literal(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Disconnected from Spotify');

// The refresh token is kept in the keyring, it allows controlling the playback of the account.
let tokenSchema = null;
const getTokenSchema = () => {
    tokenSchema ??= Secret.Schema.new('is.m0.GameBarOverlay.Spotify', Secret.SchemaFlags.NONE,
        { client_id: Secret.SchemaAttributeType.STRING });
    return tokenSchema;
};

const lookupToken = (clientId, cancellable) => new Promise((resolve, reject) => {
    Secret.password_lookup(getTokenSchema(), { client_id: clientId }, cancellable, (source, result) => {
        try {
            resolve(Secret.password_lookup_finish(result));
        } catch (e) {
            reject(e);
        }
    });
});

const storeToken = (clientId, token) => new Promise((resolve, reject) => {
    Secret.password_store(getTokenSchema(), { client_id: clientId }, Secret.COLLECTION_DEFAULT,
        'GameBar Overlay: Spotify', token, null, (source, result) => {
            try {
                resolve(Secret.password_store_finish(result));
            } catch (e) {
                reject(e);
            }
        });
});

const clearToken = (clientId) => new Promise((resolve, reject) => {
    Secret.password_clear(getTokenSchema(), { client_id: clientId }, null, (source, result) => {
        try {
            resolve(Secret.password_clear_finish(result));
        } catch (e) {
            reject(e);
        }
    });
});

const encodeQuery = (query) => Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');

const base64Url = (bytes) => GLib.base64_encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 64 characters from the random numbers of the kernel, for the code verifier and the state of signing in.
const randomString = () => {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    try {
        return base64Url(stream.read_bytes(48, null).toArray());
    } finally {
        stream.close(null);
    }
};

const sha256 = (text) => {
    const hex = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
    return Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
};

// The page the browser shows once Spotify sent it back.
const callbackPage = (text) => new TextEncoder().encode(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>GameBar Overlay</title></head>
<body style="font-family: sans-serif; text-align: center; margin-top: 20vh;"><p>${text}</p></body></html>`);

const toDevice = (device, active) => ({
    id: device.id ?? '',
    name: device.name || _('Device'),
    iconName: DEVICE_ICONS[device.type] ?? DEFAULT_DEVICE_ICON,
    active,
    // 0 to 1, null for a device whose volume Spotify cannot set, like most phones.
    volume: device.supports_volume !== false && typeof device.volume_percent === 'number' ? device.volume_percent / 100 : null,
});

// The Spotify account of the user. It is at the same time the player the Music card shows for it, with the properties
// and methods of its MPRIS players and the devices on top. 'changed' is emitted after every change, once per main
// loop iteration. One instance serves the card and its pinned copies: a refresh token is only good for one request,
// and the Web API limits the requests of an app.
export class SpotifyConnect extends Signals.EventEmitter {
    constructor() {
        super();
        // The id of the player in the Music card.
        this.id = 'spotify-connect';
        this.clientId = '';
        // 'unconfigured' without a client ID, 'loading' until the keyring answered, 'signed-out', 'ready'.
        this.state = 'unconfigured';
        // When it last started playing, the card shows the player that played last.
        this.lastActive = 0;

        // Scenarios of tests/ point these to a server of their own.
        this._apiUrl = API_URL;
        this._accountsUrl = ACCOUNTS_URL;

        this._session = null;
        this._cancellable = new Gio.Cancellable();
        this._refreshToken = null;
        this._accessToken = null;
        this._accessExpires = 0;
        this._refreshing = null;
        this._loading = null;
        this._authorizing = null;
        this._authorizeUrl = null;

        // The playback state as Spotify sent it, null without an active device, and when it was read.
        this._playback = null;
        this._playbackTime = 0;
        this._devices = [];
        // Counted up by every command, the answer to a poll sent before it is out of date.
        this._generation = 0;
        // Spotify refused a command because the account has no Premium.
        this._premiumRequired = false;
        // The scopes Spotify granted, null until it told them.
        this._scopes = null;
        // Whether the track or episode with this URI is in the library of the user, as Spotify last told it.
        this._savedUri = null;
        this._saved = false;
        // Counted up by every like, the answer to a question asked before it is out of date.
        this._savedGeneration = 0;
        // A like is on its way, the button waits for it.
        this._savedPending = false;
        this._savedCheckId = 0;

        // Who shows the playback, and whether with its device list open.
        this._watchers = new Map();
        this._pollId = 0;
        this._polling = false;
        this._pollCount = 0;
        this._volumeId = 0;
        this._changedId = 0;
        this._lastError = null;
    }

    updateSettings(settings) {
        const clientId = settings.get_string('spotify-client-id').trim();
        if (clientId === this.clientId) return;

        // The token belongs to the app with the old client ID, clearing the client ID signs out.
        if (this.clientId) clearToken(this.clientId).catch(logError);
        this._reset();
        this.clientId = clientId;
        this._setState(clientId ? 'loading' : 'unconfigured');
        this._start();
    }

    // Forgets the account, and gives up what is on its way.
    _reset() {
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        this._refreshToken = null;
        this._accessToken = null;
        this._loading = null;
        this._playback = null;
        this._devices = [];
        this._premiumRequired = false;
        this._scopes = null;
        this._savedUri = null;
        this._savedPending = false;
        this._savedGeneration++;
        this._lastError = null;
        this._generation++;
        if (this._savedCheckId) {
            GLib.Source.remove(this._savedCheckId);
            this._savedCheckId = 0;
        }
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }
        if (this._volumeId) {
            GLib.Source.remove(this._volumeId);
            this._volumeId = 0;
        }
    }

    // The playback is only asked for while somebody watches it. devices: with the device list open.
    watch(owner, devices = false) {
        const known = this._watchers.get(owner);
        if (known === devices) return;
        this._watchers.set(owner, devices);
        // What it shows is as old as the last poll.
        if (known === undefined || devices) this._pollCount = 0;
        this._start(true);
    }

    unwatch(owner) {
        this._watchers.delete(owner);
        if (this._watchers.size === 0 && this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }
    }

    // now: ask right away, instead of with the next poll.
    _start(now = false) {
        if (this._watchers.size === 0) return;

        if (this.state === 'loading') {
            // The keyring is first asked when a card is shown, not when the session starts.
            this._loading ??= this._load(this._cancellable);
        } else if (this.state === 'ready' && !this._polling && (now || !this._pollId)) {
            this._schedulePoll(0);
        }
    }

    async _load(cancellable) {
        let token = null;
        try {
            token = await withTimeout(cancellable, KEYRING_TIMEOUT, attempt => lookupToken(this.clientId, attempt));
        } catch (e) {
            // Without an answer of the keyring the card offers to connect, the token then lasts until the shell restarts.
            if (!cancellable.is_cancelled()) logError(e);
        }
        // The client ID changed, or the user signed in while the keyring did not answer.
        if (cancellable.is_cancelled() || this.state !== 'loading') return;

        this._refreshToken = token;
        this._setState(token ? 'ready' : 'signed-out');
    }

    _setState(state) {
        this.state = state;
        this._queueChanged();
        this._start();
    }

    _queueChanged() {
        if (this._changedId) return;
        this._changedId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._changedId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    // The same error of every poll is only logged once, like while the network is down.
    _logOnce(error) {
        if (isCancelled(error) || error.message === this._lastError) return;
        this._lastError = error.message;
        logError(error);
    }

    _send(message, cancellable) {
        this._session ??= new Soup.Session();
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                try {
                    resolve(session.send_and_read_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    // The answers of Spotify are JSON or empty.
    _parse(bytes) {
        const text = new TextDecoder().decode(bytes.toArray());
        try {
            return text ? JSON.parse(text) : null;
        } catch (e) {
            return null;
        }
    }

    // Signing in

    // Opens the page of Spotify that asks for the access in the browser, and waits for it to come back.
    // Called again while waiting it opens the page again.
    authorize() {
        if (this._authorizing) {
            this._openBrowser();
            return this._authorizing;
        }
        this._authorizing = this._authorize(this._cancellable).finally(() => {
            this._authorizing = null;
            this._authorizeUrl = null;
        });
        return this._authorizing;
    }

    _openBrowser() {
        if (!this._authorizeUrl) return;
        try {
            Gio.AppInfo.launch_default_for_uri(this._authorizeUrl, global.create_app_launch_context(0, -1));
        } catch (e) {
            logError(e);
        }
    }

    async _authorize(cancellable) {
        const clientId = this.clientId;
        const verifier = randomString();
        const state = randomString();
        this._authorizeUrl = `${this._accountsUrl}/authorize?${encodeQuery({
            client_id: clientId,
            response_type: 'code',
            redirect_uri: SPOTIFY_REDIRECT_URI,
            state,
            scope: SCOPES,
            code_challenge_method: 'S256',
            code_challenge: base64Url(sha256(verifier)),
        })}`;

        const code = await this._waitForCode(state, cancellable);
        const { status, data } = await this._postToken({
            grant_type: 'authorization_code',
            code,
            redirect_uri: SPOTIFY_REDIRECT_URI,
            client_id: clientId,
            code_verifier: verifier,
        }, cancellable);
        if (status !== Soup.Status.OK || typeof data?.refresh_token !== 'string') {
            throw new Error(`No token (HTTP ${status} ${data?.error_description ?? data?.error ?? ''})`);
        }
        this._setTokens(data);
    }

    // Spotify sends the browser to the redirect URI with the code, a server on this computer takes it.
    _waitForCode(state, cancellable) {
        const server = new Soup.Server();
        let timeoutId = 0;
        let cancelId = 0;

        return new Promise((resolve, reject) => {
            server.add_handler('/callback', (server_, message, path, query) => {
                const granted = query?.state === state && typeof query?.code === 'string';
                message.set_status(granted ? Soup.Status.OK : Soup.Status.BAD_REQUEST, null);
                message.set_response('text/html; charset=utf-8', Soup.MemoryUse.COPY, callbackPage(granted
                    ? _('GameBar Overlay is connected to Spotify. You can close this page.')
                    : _('Spotify did not give GameBar Overlay access.')));
                // The page is sent before the server goes away.
                message.connect('finished', () => server.disconnect());
                if (granted) {
                    resolve(query.code);
                } else {
                    reject(new Error(`Not authorized (${query?.error ?? 'no code'})`));
                }
            });
            server.listen_local(SPOTIFY_REDIRECT_PORT, Soup.ServerListenOptions.IPV4_ONLY);

            timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, AUTHORIZE_TIMEOUT, () => {
                timeoutId = 0;
                server.disconnect();
                reject(new Error('Nobody signed in'));
                return GLib.SOURCE_REMOVE;
            });
            cancelId = cancellable.connect(() => {
                server.disconnect();
                reject(cancelledError());
            });
            this._openBrowser();
        }).finally(() => {
            if (timeoutId) GLib.Source.remove(timeoutId);
            if (cancelId) cancellable.disconnect(cancelId);
        });
    }

    async _postToken(parameters, cancellable) {
        const message = Soup.Message.new('POST', `${this._accountsUrl}/api/token`);
        message.set_request_body_from_bytes('application/x-www-form-urlencoded',
            new GLib.Bytes(new TextEncoder().encode(encodeQuery(parameters))));
        const bytes = await this._send(message, cancellable);
        return { status: message.get_status(), data: this._parse(bytes) };
    }

    _setTokens({ access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken, scope }) {
        this._accessToken = accessToken;
        if (typeof scope === 'string') this._scopes = scope.split(' ');
        this._accessExpires = GLib.get_monotonic_time() + (expiresIn - TOKEN_MARGIN) * GLib.USEC_PER_SEC;
        // Spotify gives out a new refresh token with most access tokens, the old one is then used up.
        if (refreshToken && refreshToken !== this._refreshToken) {
            this._refreshToken = refreshToken;
            storeToken(this.clientId, refreshToken).catch(logError);
        }
        if (this.state !== 'ready') this._setState('ready');
    }

    _getAccessToken() {
        if (this._accessToken && GLib.get_monotonic_time() < this._accessExpires) return Promise.resolve(this._accessToken);

        this._refreshing ??= this._refresh(this._cancellable).finally(() => {
            this._refreshing = null;
        });
        return this._refreshing;
    }

    async _refresh(cancellable) {
        const { status, data } = await this._postToken({
            grant_type: 'refresh_token',
            refresh_token: this._refreshToken,
            client_id: this.clientId,
        }, cancellable);
        if (status === Soup.Status.BAD_REQUEST && data?.error === 'invalid_grant') {
            // The user took the access away, or the token was used up elsewhere. The card offers to connect again.
            this._signOut();
            throw new Error('The access was revoked');
        }
        if (status !== Soup.Status.OK || typeof data?.access_token !== 'string') {
            throw new Error(`No token (HTTP ${status} ${data?.error_description ?? data?.error ?? ''})`);
        }
        this._setTokens(data);
        return this._accessToken;
    }

    _signOut() {
        const clientId = this.clientId;
        this._reset();
        clearToken(clientId).catch(logError);
        this._setState('signed-out');
    }

    // The Web API

    // Resolves with the status and the parsed body. Rejects without an answer and when Spotify asks to slow down,
    // then with the seconds to wait as retryAfter.
    async _request(method, path, { query = null, body = null } = {}, retry = true) {
        const cancellable = this._cancellable;
        const token = await this._getAccessToken();
        const message = Soup.Message.new(method, `${this._apiUrl}${path}${query ? `?${encodeQuery(query)}` : ''}`);
        message.get_request_headers().append('Authorization', `Bearer ${token}`);
        if (body) {
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        } else if (method !== 'GET') {
            // Spotify wants a length, also of no body.
            message.set_request_body_from_bytes(null, new GLib.Bytes(new Uint8Array(0)));
        }

        const bytes = await this._send(message, cancellable);
        /** @type {number} */
        const status = message.get_status();
        // The access token ran out early.
        if (status === Soup.Status.UNAUTHORIZED && retry) {
            this._accessToken = null;
            return this._request(method, path, { query, body }, false);
        }
        if (status === STATUS_TOO_MANY_REQUESTS) {
            const error = new Error('Too many requests');
            error['retryAfter'] = Number(message.get_response_headers().get_one('Retry-After')) || 0;
            throw error;
        }
        return { status, data: this._parse(bytes) };
    }

    _schedulePoll(delay) {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }
        if (this.state !== 'ready' || this._watchers.size === 0) return;

        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._pollId = 0;
            this._polling = true;
            let next = POLL_INTERVAL;
            this._poll().then(() => {
                this._lastError = null;
            }).catch(error => {
                this._logOnce(error);
                next = Math.max(next, (error.retryAfter ?? 0) * 1000);
            }).finally(() => {
                this._polling = false;
                // A command may have asked for an earlier poll meanwhile.
                if (!this._pollId) this._schedulePoll(next);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    async _poll() {
        const generation = this._generation;
        const devicesWanted = [...this._watchers.values()].includes(true) || this._pollCount % DEVICES_POLLS === 0;
        this._pollCount++;

        // Podcasts are only told with their type.
        const [playback, devices] = await Promise.all([
            this._request('GET', '/me/player', { query: { additional_types: 'episode' } }),
            devicesWanted ? this._request('GET', '/me/player/devices') : null,
        ]);
        // A command was sent meanwhile, the answers still tell the state before it.
        if (generation !== this._generation) return;

        if (playback.status === Soup.Status.OK || playback.status === Soup.Status.NO_CONTENT) {
            const wasPlaying = this.ready && this._playback.is_playing;
            // 204 without an active device.
            this._playback = playback.data;
            this._playbackTime = GLib.get_monotonic_time();
            if (this.ready && this._playback.is_playing && !wasPlaying) this.lastActive = this._playbackTime;
        } else {
            throw new Error(`HTTP ${playback.status} ${playback.data?.error?.message ?? ''}`);
        }
        if (devices?.status === Soup.Status.OK && Array.isArray(devices.data?.devices)) {
            this._devices = devices.data.devices;
        }
        this._queueChanged();

        const uri = this._libraryUri;
        if (uri && this._hasLibraryScopes && !this._savedPending && (uri !== this._savedUri || devicesWanted)) {
            await this._checkSaved(uri);
        }
    }

    // Asks Spotify whether the track or episode is in the library.
    async _checkSaved(uri) {
        const generation = this._savedGeneration;
        const contains = await this._request('GET', '/me/library/contains', { query: { uris: uri } });
        // A like was sent meanwhile, or another track plays.
        if (generation !== this._savedGeneration || uri !== this._libraryUri) return;
        if (contains.status !== Soup.Status.OK || !Array.isArray(contains.data)) {
            throw new Error(`/me/library/contains: HTTP ${contains.status} ${contains.data?.error?.message ?? ''}`);
        }

        this._savedUri = uri;
        this._saved = contains.data[0] === true;
        this._queueChanged();
    }

    // Sends a command. apply() changes the state to what the command will make of it, the card shows it right away.
    _command(method, path, options = {}, apply = null) {
        this._generation++;
        apply?.();
        this._queueChanged();

        this._request(method, path, options).then(({ status, data }) => {
            if (status < 400) return;
            if (data?.error?.reason === 'PREMIUM_REQUIRED') this._premiumRequired = true;
            throw new Error(`${path}: HTTP ${status} ${data?.error?.message ?? ''}`);
        }).catch(logError).finally(() => {
            this._schedulePoll(COMMAND_SETTLE);
        });
    }

    // The player of the Music card

    // Whether there is a track to show. Spotify forgets the playback a while after it was paused.
    get ready() {
        return this.state === 'ready' && !!this._playback?.item;
    }

    get status() {
        return this._playback.is_playing ? 'Playing' : 'Paused';
    }

    get title() {
        return this._playback.item.name || _('Unknown title');
    }

    // The show of a podcast episode takes the place of the artists.
    get artists() {
        const { artists, show } = this._playback.item;
        const names = Array.isArray(artists) ? artists.map(artist => artist.name) : [show?.name];
        return names.filter(name => typeof name === 'string' && name);
    }

    // The smallest cover that is still sharp at the size of the card on a scaled shell.
    get coverUrl() {
        const { album, images } = this._playback.item;
        const covers = (album?.images ?? images ?? []).filter(image => typeof image?.url === 'string');
        const sharp = covers.filter(image => image.width >= 128).sort((a, b) => a.width - b.width);
        return (sharp[0] ?? covers[0])?.url ?? '';
    }

    // In microseconds like the times of MPRIS.
    get length() {
        const length = Number(this._playback.item.duration_ms) * 1000;
        return Number.isFinite(length) && length > 0 ? length : 0;
    }

    get appName() {
        return 'Spotify';
    }

    // Spotify tells what it does not allow, like skipping during an ad. A restricted device takes no commands at all.
    _allows(action) {
        return !this._premiumRequired && !this._playback.device?.is_restricted && !this._playback.actions?.disallows?.[action];
    }

    get canGoNext() {
        return this._allows('skipping_next');
    }

    get canGoPrevious() {
        return this._allows('skipping_prev');
    }

    get canPlayPause() {
        return this._allows(this._playback.is_playing ? 'pausing' : 'resuming');
    }

    get canSeek() {
        return this._allows('seeking') && this.length > 0;
    }

    // The current position in microseconds, counted on from the last poll while playing.
    get position() {
        let position = Number(this._playback.progress_ms) * 1000 || 0;
        if (this._playback.is_playing) position += GLib.get_monotonic_time() - this._playbackTime;
        return this.length > 0 ? Math.min(Math.max(position, 0), this.length) : Math.max(position, 0);
    }

    _setPosition(position) {
        this._playback.progress_ms = position / 1000;
        this._playbackTime = GLib.get_monotonic_time();
    }

    // The next poll brings it.
    refreshPosition() {
        this._start(true);
    }

    playPause() {
        if (!this.ready) return;
        const playing = this._playback.is_playing;
        this._command('PUT', playing ? '/me/player/pause' : '/me/player/play', {}, () => {
            this._setPosition(this.position);
            this._playback.is_playing = !playing;
            if (!playing) this.lastActive = this._playbackTime;
        });
    }

    next() {
        this._command('POST', '/me/player/next');
    }

    previous() {
        this._command('POST', '/me/player/previous');
    }

    seek(position) {
        if (!this.ready) return;
        this._command('PUT', '/me/player/seek', { query: { position_ms: Math.round(position / 1000) } },
            () => this._setPosition(position));
    }

    get shuffle() {
        return !!this._playback.shuffle_state;
    }

    get canShuffle() {
        return this._allows('toggling_shuffle');
    }

    // Smart shuffle cannot be turned on over the Web API, turning shuffle off ends it too.
    toggleShuffle() {
        if (!this.ready) return;
        const shuffle = this.shuffle;
        this._command('PUT', '/me/player/shuffle', { query: { state: String(!shuffle) } }, () => {
            this._playback.shuffle_state = !shuffle;
            this._playback.smart_shuffle = false;
        });
    }

    // Liking

    get _hasLibraryScopes() {
        return !this._scopes || LIBRARY_SCOPES.every(scope => this._scopes.includes(scope));
    }

    // Signed in before liking was there, the card offers to connect again.
    get needsReconnect() {
        return this.state === 'ready' && !this._hasLibraryScopes;
    }

    // The URI of the track or episode, null for a local file, which cannot be in the library.
    get _libraryUri() {
        const uri = this._playback?.item?.uri;
        return typeof uri === 'string' && /^spotify:(track|episode):/.test(uri) ? uri : null;
    }

    get isEpisode() {
        return this._libraryUri?.startsWith('spotify:episode:') ?? false;
    }

    // Liked tracks are the Liked Songs of the user, liked episodes Your Episodes.
    get saved() {
        return this._savedUri !== null && this._savedUri === this._libraryUri && this._saved;
    }

    // Only once it is known whether the track is liked, and not while a like is on its way. Liking needs no Premium.
    get canSave() {
        return this._hasLibraryScopes && !this._savedPending && this._savedUri !== null && this._savedUri === this._libraryUri;
    }

    // The card shows what Spotify tells after the like, not what the click should have made of it.
    toggleSaved() {
        if (!this.ready || !this.canSave) return;
        const uri = this._savedUri;
        this._savedGeneration++;
        this._savedPending = true;
        if (this._savedCheckId) {
            GLib.Source.remove(this._savedCheckId);
            this._savedCheckId = 0;
        }
        this._queueChanged();

        this._request(this._saved ? 'DELETE' : 'PUT', '/me/library', { query: { uris: uri } }).then(({ status, data }) => {
            if (status >= 400) throw new Error(`/me/library: HTTP ${status} ${data?.error?.message ?? ''}`);
        }).catch(logError).then(() => this._checkSaved(uri)).catch(logError).finally(() => {
            this._savedPending = false;
            this._queueChanged();
            this._savedCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVED_RECHECK, () => {
                this._savedCheckId = 0;
                if (!this._savedPending && this._watchers.size > 0) this._checkSaved(uri).catch(logError);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // The devices

    // The device that plays: { id, name, iconName, active, volume }.
    get device() {
        return toDevice(this._playback.device ?? {}, true);
    }

    // The devices of the account that are switched on, in the order of Spotify. A device that takes no commands
    // cannot be played on from here.
    get devices() {
        const activeId = this._playback.device?.id;
        const devices = this._devices.filter(device => !device.is_restricted || device.id === activeId)
            .map(device => toDevice(device, device.id === activeId));
        // The list is older than the playback, the device may be new.
        return devices.some(device => device.active) ? devices : [this.device, ...devices];
    }

    // Moves the playback to another device, playing or paused as it is.
    transfer(deviceId) {
        const device = this._devices.find(other => other.id === deviceId);
        if (!this.ready || !device || deviceId === this._playback.device?.id) return;

        this._command('PUT', '/me/player', { body: { device_ids: [deviceId] } }, () => {
            this._playback.device = device;
        });
    }

    // volume: 0 to 1. The slider calls this for every step, the last value of a moment is sent.
    setVolume(volume) {
        const percent = Math.round(Math.max(0, Math.min(volume, 1)) * 100);
        const device = this._playback?.device;
        if (!device || device.volume_percent === percent) return;

        // Polls that are answered until it is sent still tell the old volume.
        this._generation++;
        device.volume_percent = percent;
        this._queueChanged();

        if (this._volumeId) GLib.Source.remove(this._volumeId);
        this._volumeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VOLUME_DELAY, () => {
            this._volumeId = 0;
            this._command('PUT', '/me/player/volume', { query: { volume_percent: percent } });
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._reset();
        this._watchers.clear();
        if (this._changedId) {
            GLib.Source.remove(this._changedId);
            this._changedId = 0;
        }
        this._session?.abort();
        this._session = null;
        this.disconnectAll();
    }
}
