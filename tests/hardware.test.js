// The usage is sampled while the overlay is closed, the sparklines are filled when it opens.
const monitor = gamebar._systemMonitor;
const sampler = gamebar._hardwareSampler;
await sleep(5500);
check(!gamebar._overlay.visible && sampler.cpuHistory.length >= 4,
    `the CPU usage is sampled while the overlay is closed (${sampler.cpuHistory.length} samples)`);
const gpuInBackground = sampler._gpuHasUsage && sampler._canSampleGpuInBackground();
check(!gpuInBackground || sampler.gpuHistory.length >= 4,
    `the GPU usage too, where reading it cannot keep it awake (${sampler.gpuDevice} ${sampler._gpuDriver}, ` +
    `${gpuInBackground ? sampler.gpuHistory.length + ' samples' : 'not in the background'})`);
check(sampler.gpu.temperature === null && sampler.gpu.vram === null, 'and only the usage of the GPU');

// A background sample takes a fraction of a millisecond of the shell.
const start = now();
for (let i = 0; i < 100; i++) {
    sampler._sampleCpu();
    sampler._sampleGpu(false);
}
const perSample = (now() - start) / 100;
check(perSample < 500, `a background sample takes ${Math.round(perSample)} µs`);

await openOverlay();
check(monitor._cpuRow.sparkline._values.length >= 4, `the CPU sparkline is filled when the overlay opens (${monitor._cpuRow.sparkline._values.length})`);
check(sampler.gpu.usage === null || sampler.gpu.temperature !== null || !sampler._gpuHwmonPath,
    'the GPU temperature is read while the card is shown');

// The level bars of the Hardware card are filled to their percentage.
await sleep(1500);
const bar = monitor._memoryRow.level;
const fraction = bar._fill.width / bar.actor.width;
const shown = parseInt(monitor._memoryRow.usage.text) / 100;
check(bar.actor.width > 50 && Math.abs(fraction - shown) < 0.02, `the memory bar is filled to its percentage (${bar._fill.width} of ${bar.actor.width} px, ${monitor._memoryRow.usage.text})`);
check(bar._fill.height === bar.actor.height && bar.actor.height > 0, `and as high as the bar (${bar.actor.height} px)`);
await shot('hardware', monitor._addonContainer);
await shot('battery', gamebar._battery._addonContainer);

// A GPU that powers down when idle, a laptop GPU, is only read while the card is shown.
sampler._canSampleGpuInBackground = () => false;
gamebar._closeOverlay();
await closed();
await sleep(2500);
check(sampler.gpuHistory.length === 0 && sampler.gpu.usage === null, 'a GPU that may power down is not read while the overlay is closed');
await openOverlay();
await sleep(2500);
check(sampler.gpu.usage !== null && sampler.gpuHistory.length >= 2, `it is read while the card is shown (${sampler.gpuHistory.length} samples)`);
delete sampler._canSampleGpuInBackground;

// Turned off, nothing is sampled while the overlay is closed and the sparklines start when it opens.
settings.set_boolean('hardware-background-sampling', false);
gamebar._closeOverlay();
await closed();
await sleep(2500);
check(sampler._timeoutId === 0 && sampler.cpuHistory.length === 0 && sampler.gpuHistory.length === 0,
    'turned off, nothing is sampled while the overlay is closed');
await openOverlay();
await sleep(2500);
check(sampler.cpuHistory.length >= 2 && sampler.gpuHistory.length >= 2,
    `and the usage is sampled while the card is shown (${sampler.cpuHistory.length} CPU, ${sampler.gpuHistory.length} GPU samples)`);
gamebar._closeOverlay();
await closed();
await sleep(1500);
check(sampler._timeoutId === 0, 'and stops when the overlay closes');
settings.reset('hardware-background-sampling');
await sleep(2500);
check(sampler.cpuHistory.length >= 1, 'turned on again, it samples in the background');
