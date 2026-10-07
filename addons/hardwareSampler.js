import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { readFile, getGpuDriver, listGpus, findFirstHwmon } from '../utils.js';

// Import GTop conditionally
let GTop = null;
try {
    GTop = (await import('gi://GTop')).default;
} catch (e) {
    // GTop is not available, it is already null
}

// Number of usage samples in a sparkline, one per second.
export const HISTORY_LENGTH = 30;

const NO_GPU_READING = { usage: null, temperature: null, vram: null };

// A number read from sysfs or a tool, null without one.
export const toNumber = (text) => {
    const number = Number(text);
    return typeof text === 'string' && text.trim() !== '' && Number.isFinite(number) ? number : null;
};

const pushSample = (history, value) => {
    history.push(Math.max(0, Math.min(value, 100)));
    if (history.length > HISTORY_LENGTH) history.shift();
};

// The CPU and GPU usage for the sparklines of the Hardware cards, one sample a second. Unless it is turned off, the
// usage is sampled while the overlay is closed too, so the sparklines are filled when it opens. In the background only the usage is read, which
// is a read of /proc/stat and of one sysfs file or a line of nvidia-smi: nothing that draws, nothing in the way of a
// game. The temperature and the VRAM are only read while a card is shown.
export class HardwareSampler {
    constructor() {
        this.cpuHistory = [];
        this.gpuHistory = [];
        this.cpuUsage = null;
        this.gpu = NO_GPU_READING;

        this._background = false;
        this._cpuEnabled = false;
        this._gpuEnabled = false;
        this._gpuDevice = null;
        // The shown cards, which get every sample.
        this._watchers = new Map();
        this._nextWatchId = 1;
        this._timeoutId = 0;
        // The last CPU times and a spare to read into, a sample allocates nothing.
        this._cpuTimes = null;
        this._spareCpuTimes = null;
        // Whether the GPU was sampled at the last sample, its history has a gap otherwise.
        this._gpuSampling = false;
        this._nvidiaProcess = null;
        this._nvidiaMissing = false;
        this._nvidiaReading = NO_GPU_READING;
        this._cancellable = null;
        this._destroyed = false;
    }

    get cpuAvailable() {
        return GTop !== null;
    }

    get gpuDevice() {
        return this._gpuDevice;
    }

    updateSettings(settings) {
        this._stop();

        this._background = settings.get_boolean('hardware-background-sampling');
        this._cpuEnabled = settings.get_boolean('cpu-monitoring') && GTop !== null;
        this._gpuEnabled = settings.get_boolean('gpu-monitoring');
        // The selected GPU, or the first one if it does not exist.
        const gpus = listGpus().map(([id]) => id);
        const selected = settings.get_string('gpu-device');
        this._gpuDevice = this._gpuEnabled ? (gpus.includes(selected) ? selected : gpus[0] ?? null) : null;
        this._gpuDriver = this._gpuDevice ? getGpuDriver(this._gpuDevice) : null;
        this._gpuPath = this._gpuDevice ? `/sys/class/drm/${this._gpuDevice}/device` : null;
        // Integrated Intel GPUs have no sensor.
        this._gpuHwmonPath = this._gpuDevice ? findFirstHwmon(this._gpuDevice) : null;
        // Only amdgpu has the usage in sysfs and nvidia-smi tells it, Intel and nouveau have neither.
        this._gpuHasUsage = this._gpuDriver === 'amdgpu' || this._gpuDriver === 'nvidia';
        this._nvidiaMissing = false;

        this.gpuHistory.length = 0;
        this.gpu = NO_GPU_READING;
        this._start();
    }

    // Calls back after every sample until unwatch(). A GPU that is not sampled in the background is read right away.
    watch(callback) {
        const id = this._nextWatchId++;
        this._watchers.set(id, callback);
        if (this._watchers.size === 1) {
            this._start();
            this._sampleGpu(true);
        }
        return id;
    }

    unwatch(id) {
        this._watchers.delete(id);
        // Without a shown card the timer only runs for what is sampled in the background.
        this._start();
    }

    // The timer runs while a card is shown, and while there is something to sample in the background.
    _start() {
        if (this._destroyed) return;

        const needed = this._watchers.size > 0 || (this._background && (this._cpuEnabled || this._gpuDevice !== null));
        if (needed && !this._timeoutId) {
            // A sparkline with a gap would be misleading, it starts anew.
            this.cpuHistory.length = 0;
            this.cpuUsage = null;
            this._cpuTimes = null;
            this._sampleCpu();
            // Seconds, so the wakeups of the shell are bundled.
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._sample();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!needed) {
            this._stop();
        }
    }

    _stop() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._stopNvidia();
        this._gpuSampling = false;
    }

    _sample() {
        // An exception would end the timer, and the sparklines would stand still.
        try {
            this._sampleCpu();
            this._sampleGpu(false);
        } catch (e) {
            console.warn(`GameBar: ${e.message}`);
        }
        this._watchers.forEach(callback => callback());
    }

    // The share of the time the CPUs were busy since the last sample, null for the first one.
    _sampleCpu() {
        if (!this._cpuEnabled) return;

        const times = this._spareCpuTimes ?? new GTop.glibtop_cpu();
        GTop.glibtop_get_cpu(times);
        const previous = this._cpuTimes;
        this._spareCpuTimes = previous;
        this._cpuTimes = times;
        if (!previous) return;

        const busy = (times.user - previous.user) + (times.sys - previous.sys) + (times.nice - previous.nice);
        this.cpuUsage = Math.round(busy / Math.max(times.total - previous.total, 1) * 100);
        pushSample(this.cpuHistory, this.cpuUsage);
    }

    // A GPU that may power down when it is idle, a laptop GPU, is only read while a card is shown: reading it every
    // second would wake it or keep it from powering down. Its sparkline starts when the card is shown.
    _canSampleGpuInBackground() {
        return readFile(`${this._gpuPath}/power/control`) !== 'auto';
    }

    // first is the read when a card is shown, which leaves the history alone if the GPU is sampled in the background.
    _sampleGpu(first) {
        if (!this._gpuDevice) return;

        const watched = this._watchers.size > 0;
        const sampling = watched || (this._background && this._gpuHasUsage && this._canSampleGpuInBackground());
        // A sparkline with a gap would be misleading, it starts anew when the GPU is read again.
        if (!sampling) {
            this._stopNvidia();
            this._gpuSampling = false;
            this.gpu = NO_GPU_READING;
            this.gpuHistory.length = 0;
            return;
        }

        if (!this._gpuSampling) this.gpuHistory.length = 0;
        const continuing = this._gpuSampling;
        this._gpuSampling = true;

        this.gpu = this._readGpu(watched);
        if (this.gpu.usage !== null && !(first && continuing)) pushSample(this.gpuHistory, this.gpu.usage);
    }

    // Usage in percent, temperature in millidegrees Celsius and VRAM in use in bytes, null for what the driver does not
    // tell. Without details only the usage.
    _readGpu(details) {
        if (this._gpuDriver === 'nvidia') {
            this._startNvidia();
            const reading = this._nvidiaReading;
            return details ? reading : { ...NO_GPU_READING, usage: reading.usage };
        }

        const amd = this._gpuDriver === 'amdgpu';
        return {
            usage: amd ? toNumber(readFile(`${this._gpuPath}/gpu_busy_percent`)) : null,
            temperature: details && this._gpuHwmonPath ? toNumber(readFile(`${this._gpuHwmonPath}/temp1_input`)) : null,
            vram: details && amd ? toNumber(readFile(`${this._gpuPath}/mem_info_vram_used`)) : null,
        };
    }

    // nvidia-smi takes too long to wait for it in the shell, and starting it every second costs more than the reading.
    // One nvidia-smi prints a line a second, the GPU row shows the last one.
    _startNvidia() {
        if (this._nvidiaProcess || this._nvidiaMissing) return;

        let process;
        try {
            process = Gio.Subprocess.new(
                ['nvidia-smi', '--query-gpu=utilization.gpu,temperature.gpu,memory.used', '--format=csv,noheader,nounits',
                    '--id=0', '--loop=1'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._nvidiaMissing = true;
            return;
        }

        this._nvidiaProcess = process;
        this._cancellable = new Gio.Cancellable();
        const stream = new Gio.DataInputStream({ base_stream: process.get_stdout_pipe() });
        const cancellable = this._cancellable;
        const readLine = () => stream.read_line_async(GLib.PRIORITY_LOW, cancellable, (source, result) => {
            let line;
            try {
                [line] = source.read_line_finish_utf8(result);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) console.warn(`GameBar: ${e.message}`);
                return;
            }

            // nvidia-smi ended: no driver or no GPU. It is not started again until the settings change.
            if (line === null) {
                if (this._nvidiaProcess === process) {
                    this._nvidiaProcess = null;
                    this._nvidiaMissing = true;
                    this._nvidiaReading = NO_GPU_READING;
                }
                return;
            }

            // The memory is in MiB.
            const [usage, temperature, memory] = line.split(',').map(toNumber);
            this._nvidiaReading = {
                usage: usage ?? null,
                temperature: typeof temperature === 'number' ? temperature * 1000 : null,
                vram: typeof memory === 'number' ? memory * 1024 ** 2 : null,
            };
            readLine();
        });
        readLine();
    }

    _stopNvidia() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._nvidiaProcess?.force_exit();
        this._nvidiaProcess = null;
        this._nvidiaReading = NO_GPU_READING;
    }

    destroy() {
        this._destroyed = true;
        this._stop();
        this._watchers.clear();
    }
}
