import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { positionAddon, followCardSize, makeDraggable, setCardHidden } from '../cardPosition.js';
import { backgroundImageStyle, createCard, BoxedList, createRow, createLabel, createIconButton } from '../card.js';
import { deleteOldFiles } from '../utils.js';

// The voice channel of the Discord client over its local RPC server. The voice commands need an OAuth token with the
// rpc scope, which Discord only grants to approved applications. The card authorises as the StreamKit Overlay of
// Discord, like the Discover overlay: the client only accepts its ID from its origin, and its token endpoint
// exchanges the code without a client secret.
const CLIENT_ID = '207646673902501888';
const ORIGIN = 'https://streamkit.discord.com';
const TOKEN_URL = 'https://streamkit.discord.com/overlay/token';
// The client listens on the first free port of these, a second client (PTB, Canary) on the next one.
const FIRST_PORT = 6463;
const LAST_PORT = 6472;

const CHANNEL_EVENTS = ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP'];

// Members shown before and after "Show more", the rest is counted in a last row.
const COLLAPSED_LIMIT = 5;
const EXPANDED_LIMIT = 15;

// A stage channel with hundreds of listeners is larger than the 128 KiB a message may have by default.
const MAX_MESSAGE_SIZE = 8 * 1024 * 1024;
// Something else may listen on one of the ports and never answer, and a session without a keyring may not either. In milliseconds.
const CONNECT_TIMEOUT = 2000;
const READY_TIMEOUT = 5000;
const KEYRING_TIMEOUT = 3000;
// Avatars not downloaded again for this long are deleted, in seconds.
const AVATAR_MAX_AGE = 30 * 24 * 60 * 60;

// How long the card stays connected with the overlay closed, waiting for the user to answer the prompt of Discord.
const AUTHORIZE_TIMEOUT = 120;

const isCancelled = (error) => error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;

const logError = (error) => {
    if (!isCancelled(error)) console.warn(`GameBar: ${error.message}`);
};

const cancelledError = () => new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Disconnected from Discord');

// Runs start(attempt) with a cancellable that is cancelled after the timeout, or with the cancellable given.
const withTimeout = async (cancellable, timeout, start) => {
    const attempt = new Gio.Cancellable();
    const cancelId = cancellable.connect(() => attempt.cancel());
    let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
        timeoutId = 0;
        attempt.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        return await start(attempt);
    } finally {
        if (timeoutId) GLib.Source.remove(timeoutId);
        cancellable.disconnect(cancelId);
    }
};

// The token is kept in the keyring, it allows controlling the Discord client.
let tokenSchema = null;
const getTokenSchema = () => {
    tokenSchema ??= Secret.Schema.new('is.m0.GameBarOverlay.Discord', Secret.SchemaFlags.NONE,
        { client_id: Secret.SchemaAttributeType.STRING });
    return tokenSchema;
};
const TOKEN_ATTRIBUTES = { client_id: CLIENT_ID };

const lookupToken = (cancellable) => new Promise((resolve, reject) => {
    Secret.password_lookup(getTokenSchema(), TOKEN_ATTRIBUTES, cancellable, (source, result) => {
        try {
            resolve(Secret.password_lookup_finish(result));
        } catch (e) {
            reject(e);
        }
    });
});

const storeToken = (token) => new Promise((resolve, reject) => {
    Secret.password_store(getTokenSchema(), TOKEN_ATTRIBUTES, Secret.COLLECTION_DEFAULT,
        'GameBar Overlay: Discord', token, null, (source, result) => {
            try {
                resolve(Secret.password_store_finish(result));
            } catch (e) {
                reject(e);
            }
        });
});

const clearToken = () => new Promise((resolve, reject) => {
    Secret.password_clear(getTokenSchema(), TOKEN_ATTRIBUTES, null, (source, result) => {
        try {
            resolve(Secret.password_clear_finish(result));
        } catch (e) {
            reject(e);
        }
    });
});

// Connection to the Discord client. onChanged() is called after every change, once per main loop iteration.
// The channel and its members are kept while disconnected, so the card does not flicker when the overlay opens.
class DiscordClient {
    constructor(onChanged) {
        this._onChanged = onChanged;
        // 'unavailable' without a running client, 'unauthorized' until the user allowed the access, 'ready'.
        this.state = 'unavailable';
        // { name, guildName } of the voice channel the user is in, null in none. Calls outside a server have no names.
        this.channel = null;
        this.mute = false;
        this.deaf = false;
        // The voice states of the channel by user id, in the order of Discord.
        this._members = new Map();
        this._speaking = new Set();
        this._guildNames = new Map();

        this._session = null;
        this._cancellable = null;
        this._connection = null;
        this._connectionIds = [];
        this._pending = new Map();
        this._nonce = 0;
        this._token = null;
        this._authorizing = null;
        this._channelId = null;
        this._channelGeneration = 0;
        this._changedId = 0;
    }

    get members() {
        return [...this._members.values()].map(({ nick, user, voice_state: voiceState }) => {
            const deafened = !!(voiceState?.deaf || voiceState?.self_deaf);
            const muted = deafened || !!(voiceState?.mute || voiceState?.self_mute || voiceState?.suppress);
            return {
                id: user.id,
                name: nick || user.global_name || user.username || '',
                // The first frame of an animated avatar, at twice the size for a scaled shell.
                avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : '',
                avatarKey: `${user.id}-${user.avatar}`,
                deafened,
                muted,
                speaking: !muted && this._speaking.has(user.id),
            };
        });
    }

    connect() {
        if (this._cancellable) return;

        const cancellable = this._cancellable = new Gio.Cancellable();
        this._run(cancellable).catch(error => {
            logError(error);
            if (this._cancellable === cancellable) {
                this.disconnect();
                this._setState('unavailable');
            }
        });
    }

    async _run(cancellable) {
        this._session ??= new Soup.Session();
        const connection = await this._open(cancellable);
        if (!connection) {
            this._cancellable = null;
            this._setState('unavailable');
            return;
        }

        connection.max_incoming_payload_size = MAX_MESSAGE_SIZE;
        this._connection = connection;
        this._connectionIds = [
            connection.connect('message', (connection_, type, bytes) => {
                if (type !== Soup.WebsocketDataType.TEXT) return;
                try {
                    this._onMessage(JSON.parse(new TextDecoder().decode(bytes.toArray())));
                } catch (e) {
                    logError(e);
                }
            }),
            // Discord was closed.
            connection.connect('closed', () => {
                if (this._connection !== connection) return;
                this.disconnect();
                this._setState('unavailable');
            }),
        ];
        await withTimeout(cancellable, READY_TIMEOUT, attempt => new Promise((resolve, reject) => {
            this._pending.set('ready', { resolve, reject });
            attempt.connect(() => reject(cancelledError()));
        }));

        // Without an answer of the keyring the card offers to connect, the token then lasts until the shell restarts.
        let token = this._token;
        try {
            token ??= await withTimeout(cancellable, KEYRING_TIMEOUT, attempt => lookupToken(attempt));
        } catch (e) {
            if (cancellable.is_cancelled()) throw e;
            logError(e);
        }
        if (token && await this._authenticate(token)) {
            this._token = token;
            await this._start();
            return;
        }

        this._setState('unauthorized');
        if (token) {
            // The token ran out after a week. Discord gives out a new one without asking, unless the user revoked the access.
            this._token = null;
            clearToken().catch(logError);
            try {
                await this.authorize();
            } catch (e) {
                if (isCancelled(e)) throw e;
                logError(e);
            }
        }
    }

    async _open(cancellable) {
        for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
            const message = Soup.Message.new('GET', `ws://127.0.0.1:${port}/?v=1&client_id=${CLIENT_ID}`);
            try {
                return await withTimeout(cancellable, CONNECT_TIMEOUT, attempt => new Promise((resolve, reject) => {
                    this._session.websocket_connect_async(message, ORIGIN, [], GLib.PRIORITY_DEFAULT, attempt, (session, result) => {
                        try {
                            resolve(session.websocket_connect_finish(result));
                        } catch (e) {
                            reject(e);
                        }
                    });
                }));
            } catch (e) {
                if (cancellable.is_cancelled()) throw e;
            }
        }
        return null;
    }

    _send(cmd, args = {}, evt = undefined) {
        return new Promise((resolve, reject) => {
            if (this._connection?.get_state() !== Soup.WebsocketState.OPEN) {
                reject(cancelledError());
                return;
            }
            const nonce = `${++this._nonce}`;
            this._pending.set(nonce, { resolve, reject });
            this._connection.send_text(JSON.stringify({ cmd, args, evt, nonce }));
        });
    }

    _onMessage({ cmd, evt, data, nonce }) {
        const request = this._pending.get(nonce);
        if (request) {
            this._pending.delete(nonce);
            if (evt === 'ERROR') {
                request.reject(new Error(`Discord: ${cmd}: ${data?.message}`));
            } else {
                request.resolve(data);
            }
            return;
        }
        if (cmd !== 'DISPATCH') return;

        switch (evt) {
        case 'READY':
            this._pending.get('ready')?.resolve();
            this._pending.delete('ready');
            break;
        case 'VOICE_CHANNEL_SELECT':
            this._refreshChannel().catch(logError);
            break;
        case 'VOICE_SETTINGS_UPDATE':
            this._setVoiceSettings(data);
            break;
        case 'VOICE_STATE_CREATE':
        case 'VOICE_STATE_UPDATE':
            this._members.set(data.user.id, data);
            this._queueChanged();
            break;
        case 'VOICE_STATE_DELETE':
            this._members.delete(data.user.id);
            this._speaking.delete(data.user.id);
            this._queueChanged();
            break;
        case 'SPEAKING_START':
            this._speaking.add(data.user_id);
            this._queueChanged();
            break;
        case 'SPEAKING_STOP':
            this._speaking.delete(data.user_id);
            this._queueChanged();
            break;
        }
    }

    async _authenticate(token) {
        try {
            await this._send('AUTHENTICATE', { access_token: token });
            return true;
        } catch (e) {
            if (isCancelled(e)) throw e;
            return false;
        }
    }

    // Asks Discord for the access, which shows a prompt in its window the first time.
    authorize() {
        this._authorizing ??= this._authorize().finally(() => {
            this._authorizing = null;
        });
        return this._authorizing;
    }

    async _authorize() {
        const { code } = await this._send('AUTHORIZE', { client_id: CLIENT_ID, scopes: ['rpc'], prompt: 'none' });
        const token = await this._fetchToken(code, this._cancellable);
        if (!await this._authenticate(token)) throw new Error('Discord did not accept the new token');

        this._token = token;
        storeToken(token).catch(logError);
        await this._start();
    }

    _fetchToken(code, cancellable) {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('POST', TOKEN_URL);
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify({ code }))));
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const token = JSON.parse(new TextDecoder().decode(bytes.toArray())).access_token;
                    if (message.get_status() !== Soup.Status.OK || typeof token !== 'string') {
                        throw new Error(`Discord gave no token (HTTP ${message.get_status()})`);
                    }
                    resolve(token);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _start() {
        await Promise.all(['VOICE_CHANNEL_SELECT', 'VOICE_SETTINGS_UPDATE'].map(evt => this._send('SUBSCRIBE', {}, evt)));
        this._setVoiceSettings(await this._send('GET_VOICE_SETTINGS'));
        await this._refreshChannel();
        this._setState('ready');
    }

    async _refreshChannel() {
        const generation = ++this._channelGeneration;
        const channel = await this._send('GET_SELECTED_VOICE_CHANNEL');
        // The channel changed again while waiting.
        if (generation !== this._channelGeneration) return;

        const previousId = this._channelId;
        if (previousId && previousId !== channel?.id) {
            CHANNEL_EVENTS.forEach(evt => this._send('UNSUBSCRIBE', { channel_id: previousId }, evt).catch(logError));
        }

        this._channelId = channel?.id ?? null;
        this._members = new Map((channel?.voice_states ?? []).map(state => [state.user.id, state]));
        this._speaking.clear();
        this.channel = channel ? { name: channel.name ?? '', guildName: this._guildNames.get(channel.guild_id) ?? '' } : null;
        this._queueChanged();
        if (!channel) return;

        if (previousId !== channel.id) {
            await Promise.all(CHANNEL_EVENTS.map(evt => this._send('SUBSCRIBE', { channel_id: channel.id }, evt)));
        }
        if (channel.guild_id && !this._guildNames.has(channel.guild_id)) {
            const guild = await this._send('GET_GUILD', { guild_id: channel.guild_id });
            this._guildNames.set(channel.guild_id, guild.name ?? '');
            if (generation === this._channelGeneration) {
                this.channel.guildName = guild.name ?? '';
                this._queueChanged();
            }
        }
    }

    _setVoiceSettings({ mute, deaf }) {
        this.mute = !!mute;
        this.deaf = !!deaf;
        this._queueChanged();
    }

    _setState(state) {
        this.state = state;
        this._queueChanged();
    }

    // Unmuting while deafened also undeafens, like the button of Discord.
    toggleMute() {
        this._send('SET_VOICE_SETTINGS', this.deaf ? { mute: false, deaf: false } : { mute: !this.mute })
            .then(settings => this._setVoiceSettings(settings))
            .catch(logError);
    }

    toggleDeaf() {
        this._send('SET_VOICE_SETTINGS', { deaf: !this.deaf })
            .then(settings => this._setVoiceSettings(settings))
            .catch(logError);
    }

    leaveChannel() {
        this._send('SELECT_VOICE_CHANNEL', { channel_id: null })
            .then(() => this._refreshChannel())
            .catch(logError);
    }

    _queueChanged() {
        if (this._changedId) return;
        this._changedId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._changedId = 0;
            this._onChanged();
            return GLib.SOURCE_REMOVE;
        });
    }

    disconnect() {
        if (!this._cancellable) return;

        this._cancellable.cancel();
        this._cancellable = null;

        const connection = this._connection;
        this._connection = null;
        if (connection) {
            this._connectionIds.forEach(id => connection.disconnect(id));
            this._connectionIds = [];
            if (connection.get_state() === Soup.WebsocketState.OPEN) {
                connection.close(Soup.WebsocketCloseCode.NORMAL, null);
            }
        }

        const pending = [...this._pending.values()];
        this._pending.clear();
        pending.forEach(request => request.reject(cancelledError()));

        this._channelId = null;
        this._channelGeneration++;
        // Nobody is shown speaking with what was true when the overlay closed.
        this._speaking.clear();
        this._queueChanged();
    }

    destroy() {
        this.disconnect();
        if (this._changedId) {
            GLib.Source.remove(this._changedId);
            this._changedId = 0;
        }
        this._session?.abort();
        this._session = null;
    }
}

// Downloads the avatars of the members to the cache, the stylesheet can only show local files.
class AvatarCache {
    constructor() {
        this._directory = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gamebar-overlay@m0.is', 'avatars']);
        this._session = null;
        this._cancellable = new Gio.Cancellable();
        // The callbacks waiting for a download, by its path.
        this._loading = new Map();
        deleteOldFiles(this._directory, AVATAR_MAX_AGE);
    }

    // callback(path) once the avatar is there, never without one.
    load(url, key, callback) {
        const path = GLib.build_filenamev([this._directory, `${key}.png`]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            callback(path);
            return;
        }
        if (this._loading.has(path)) {
            this._loading.get(path).push(callback);
            return;
        }
        this._loading.set(path, [callback]);

        this._session ??= new Soup.Session();
        const message = Soup.Message.new('GET', url);
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
            const callbacks = this._loading.get(path) ?? [];
            this._loading.delete(path);
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.get_status() !== Soup.Status.OK) return;

                GLib.mkdir_with_parents(this._directory, 0o700);
                Gio.File.new_for_path(path).replace_contents_bytes_async(bytes, null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable, (file, writeResult) => {
                        try {
                            file.replace_contents_finish(writeResult);
                            callbacks.forEach(loaded => loaded(path));
                        } catch (e) {
                            logError(e);
                        }
                    });
            } catch (e) {
                logError(e);
            }
        });
    }

    destroy() {
        this._cancellable.cancel();
        this._loading.clear();
        this._session?.abort();
        this._session = null;
    }
}

const setStyleClass = (actor, styleClass, enabled) => {
    if (enabled) {
        actor.add_style_class_name(styleClass);
    } else {
        actor.remove_style_class_name(styleClass);
    }
};

// The voice channel of Discord: its members, who is speaking, and mute, deafen and disconnect.
export class Discord {
    // runWithOverlayClosed(callback) closes the overlay first, the prompt of Discord is in its window behind it.
    constructor(overlay, primaryMonitor, runWithOverlayClosed) {
        this._overlay = overlay;
        this._primaryMonitor = primaryMonitor;
        this._runWithOverlayClosed = runWithOverlayClosed;
        this._addonContainer = null;
        this._authorizeTimeoutId = 0;
        this._expanded = false;
        this._avatars = new AvatarCache();
        this._client = new DiscordClient(() => this._sync());
        this._createDiscordWidget();
    }

    _createDiscordWidget() {
        this._addonContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout()
        });

        const { card, body } = createCard(_('Discord'), 'gamebar-discord-card', () => setCardHidden('discord', true));

        // The channel in bold and its server in grey.
        this._title = new St.BoxLayout({ style_class: 'gamebar-group-title gamebar-group-title-first' });
        this._channelLabel = createLabel('');
        this._guildLabel = createLabel('', 'gamebar-discord-guild');
        this._title.add_child(this._channelLabel);
        this._title.add_child(this._guildLabel);
        body.add_child(this._title);

        // Without a voice channel the card says why, like the Battery card without a battery.
        this._messageList = new BoxedList();
        const messageRow = createRow();
        this._messageLabel = createLabel('', 'gamebar-dim', { x_expand: true });
        messageRow.add_child(this._messageLabel);
        this._connectButton = new St.Button({
            style_class: 'gamebar-row-action',
            label: _('Connect'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._connectButton.connect('clicked', () => this._authorize());
        messageRow.add_child(this._connectButton);
        this._messageList.addRow(messageRow);
        body.add_child(this._messageList.actor);

        this._memberList = new BoxedList();
        this._memberRows = new Map();
        this._memberKey = null;
        body.add_child(this._memberList.actor);

        this._controls = new St.BoxLayout({
            style_class: 'gamebar-discord-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._muteButton = createIconButton('audio-input-microphone-symbolic', 'gamebar-call-button');
        this._muteButton.connect('clicked', () => this._client.toggleMute());
        this._deafenButton = createIconButton('audio-headphones-symbolic', 'gamebar-call-button');
        this._deafenButton.connect('clicked', () => this._client.toggleDeaf());
        this._leaveButton = createIconButton('', 'gamebar-call-button gamebar-call-button-destructive');
        // The receiver of Adwaita. Other icon themes colour call-stop red, which does not show on the red button.
        this._leaveButton.child.gicon = Gio.FileIcon.new(
            Gio.File.new_for_uri(import.meta.url).resolve_relative_path('../../icons/gamebar-call-end-symbolic.svg'));
        this._leaveButton.accessible_name = _('Disconnect');
        this._leaveButton.connect('clicked', () => this._client.leaveChannel());
        [this._muteButton, this._deafenButton, this._leaveButton].forEach(button => this._controls.add_child(button));
        body.add_child(this._controls);

        this._sync();

        this._addonContainer.add_child(card);
        this._overlay.add_child(this._addonContainer);
        makeDraggable(this._addonContainer, 'discord');

        followCardSize(this._addonContainer, () => this.set_addon_position());

        // Only connected while the card is on screen. Opening the overlay starts with the short member list again.
        this._overlay.connectObject('notify::visible', () => {
            if (!this._overlay.visible) {
                this._expanded = false;
                this._sync();
            }
            this._syncConnection();
        }, this._addonContainer);
        this._addonContainer.connect('notify::visible', () => this._syncConnection());
        this._syncConnection();
    }

    _syncConnection() {
        if (!this._client) return;

        if (this._overlay.visible && this._addonContainer?.visible) {
            this._client.connect();
        } else if (!this._authorizeTimeoutId) {
            this._client.disconnect();
        }
    }

    // The prompt is in the window of Discord, so the overlay closes and the card stays connected until it is answered.
    _authorize() {
        if (this._authorizeTimeoutId) return;

        this._authorizeTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, AUTHORIZE_TIMEOUT, () => {
            this._authorizeTimeoutId = 0;
            this._syncConnection();
            return GLib.SOURCE_REMOVE;
        });
        this._runWithOverlayClosed(() => {
            this._client?.authorize().catch(logError).finally(() => this._stopAuthorizing());
        });
    }

    _stopAuthorizing() {
        if (this._authorizeTimeoutId) {
            GLib.Source.remove(this._authorizeTimeoutId);
            this._authorizeTimeoutId = 0;
        }
        this._syncConnection();
    }

    _sync() {
        if (!this._addonContainer) return;

        const { state, mute, deaf } = this._client;
        const ready = state === 'ready';
        const channel = ready ? this._client.channel : null;

        this._title.visible = !!channel;
        this._channelLabel.text = channel?.name || _('Voice call');
        this._guildLabel.text = channel?.guildName ? ` · ${channel.guildName}` : '';

        this._messageList.actor.visible = !channel;
        if (state === 'unavailable') {
            this._messageLabel.text = _('Discord is not running');
        } else if (state === 'unauthorized') {
            this._messageLabel.text = _('Not connected');
        } else {
            this._messageLabel.text = _('Not in a voice channel');
        }
        this._connectButton.visible = state === 'unauthorized';

        this._memberList.actor.visible = !!channel;
        this._syncMembers(channel ? this._client.members : []);

        // Discord also offers mute and deafen outside a call.
        this._controls.visible = ready;
        this._leaveButton.visible = !!channel;

        // A deafened user is muted too.
        const muted = mute || deaf;
        this._muteButton.child.icon_name = muted ? 'microphone-disabled-symbolic' : 'audio-input-microphone-symbolic';
        this._muteButton.accessible_name = muted ? _('Unmute') : _('Mute');
        setStyleClass(this._muteButton, 'gamebar-dim', muted);
        // Adwaita has no crossed out headphones.
        this._deafenButton.child.icon_name = deaf ? 'audio-volume-muted-symbolic' : 'audio-headphones-symbolic';
        this._deafenButton.accessible_name = deaf ? _('Undeafen') : _('Deafen');
        setStyleClass(this._deafenButton, 'gamebar-dim', deaf);
    }

    _syncMembers(members) {
        const limit = this._expanded ? EXPANDED_LIMIT : COLLAPSED_LIMIT;
        // A single member more takes the place of the row that would stand for it.
        const shown = members.length === limit + 1 ? members : members.slice(0, limit);
        const hiddenCount = members.length - shown.length;

        // Only rebuilt when the rows change, not every time somebody starts or stops speaking.
        const key = JSON.stringify([shown.map(member => [member.id, member.name, member.avatarKey]), hiddenCount, this._expanded]);
        if (key !== this._memberKey) {
            this._memberKey = key;
            this._memberList.clear();
            this._memberRows.clear();
            shown.forEach(member => this._memberList.addRow(this._createMemberRow(member)));

            if (hiddenCount > 0 && !this._expanded) {
                const row = createRow();
                row.add_child(createLabel(_('Show more'), '', { x_expand: true }));
                row.add_child(new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 16, style_class: 'gamebar-dim' }));
                const button = new St.Button({
                    style_class: 'gamebar-row-button gamebar-discord-more-row',
                    child: row,
                    x_expand: true,
                });
                button.connect('clicked', () => {
                    this._expanded = true;
                    this._sync();
                });
                this._memberList.addRow(button);
            } else if (hiddenCount > 0) {
                const row = createRow();
                row.add_child(createLabel(_('+%d more').format(hiddenCount), 'gamebar-dim', { x_expand: true }));
                this._memberList.addRow(row);
            }
        }

        shown.forEach(({ id, speaking, muted, deafened }) => {
            const { ring, nameLabel, mutedIcon, deafenedIcon } = this._memberRows.get(id);
            setStyleClass(ring, 'gamebar-discord-avatar-ring-speaking', speaking);
            setStyleClass(nameLabel, 'gamebar-dim', muted);
            mutedIcon.visible = muted;
            deafenedIcon.visible = deafened;
        });
    }

    // Avatar, name and the icons of the state on the right.
    _createMemberRow({ id, name, avatarUrl, avatarKey }) {
        const row = createRow();

        // Until the avatar is there, and for members without one, the first letter of the name.
        const initial = new St.Label({ text: [...name][0]?.toUpperCase() ?? '' });
        const avatar = new St.Bin({
            style_class: 'gamebar-discord-avatar',
            y_align: Clutter.ActorAlign.CENTER,
            child: initial,
        });
        if (avatarUrl) {
            let destroyed = false;
            avatar.connect('destroy', () => {
                destroyed = true;
            });
            this._avatars.load(avatarUrl, avatarKey, path => {
                if (destroyed) return;
                avatar.style = backgroundImageStyle(path);
                initial.hide();
            });
        }
        // The ring of a speaking member is the border of a bin around the avatar, St clips a box-shadow outside of it.
        const ring = new St.Bin({
            style_class: 'gamebar-discord-avatar-ring',
            y_align: Clutter.ActorAlign.CENTER,
            child: avatar,
        });
        row.add_child(ring);

        const nameLabel = createLabel(name, '', { x_expand: true });
        row.add_child(nameLabel);
        const status = new St.BoxLayout({ style_class: 'gamebar-discord-status gamebar-dim', y_align: Clutter.ActorAlign.CENTER });
        const mutedIcon = new St.Icon({ icon_name: 'microphone-disabled-symbolic', icon_size: 16 });
        const deafenedIcon = new St.Icon({ icon_name: 'audio-volume-muted-symbolic', icon_size: 16 });
        status.add_child(mutedIcon);
        status.add_child(deafenedIcon);
        row.add_child(status);

        this._memberRows.set(id, { ring, nameLabel, mutedIcon, deafenedIcon });
        return row;
    }

    set_addon_position() {
        positionAddon(this._primaryMonitor, this._addonContainer, 'discord');
    }

    _destroyWidget() {
        // Also disconnects from the overlay.
        const container = this._addonContainer;
        this._addonContainer = null;
        container?.destroy();
        this._memberRows?.clear();
    }

    destroy() {
        if (this._authorizeTimeoutId) {
            GLib.Source.remove(this._authorizeTimeoutId);
            this._authorizeTimeoutId = 0;
        }
        this._destroyWidget();
        this._client?.destroy();
        this._client = null;
        this._avatars?.destroy();
        this._avatars = null;
    }
}
