// The Discord card without a keyring: it offers to connect if the Discord client runs. Nothing is clicked,
// the buttons of the card would act on the real client.
const discord = gamebar._discord;
await openOverlay();
await sleep(4500);
const state = discord._client.state;
check(['unauthorized', 'unavailable'].includes(state), `no token is found in the session without a keyring (${state})`);
check(discord._connectButton.visible === (state === 'unauthorized'), 'the Connect button is shown when the client runs');
check(discord._messageLabel.text !== '', `the card says why (${discord._messageLabel.text})`);
await shot('discord', discord._addonContainer);
gamebar._closeOverlay();
await closed();
check(discord._client._connection === null, 'closing the overlay disconnects');
