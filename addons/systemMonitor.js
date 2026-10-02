import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { positionAddon, followCardSize, makeDraggable, setCardHidden } from '../cardPosition.js';
import { vertical, createCard, BoxedList, createRow, createLabel, LevelBar } from '../card.js';
import { readFile, getGpuDriver, listGpus, findCpuHwmon, findFirstHwmon, celsiusToFahrenheit } from '../utils.js';

const NO_GPU_READING = { usage: null, temperature: null, vram: null };

// A number read from sysfs or a tool, null without one.
const toNumber = (text) => {
    const number = Number(text);
    return typeof text === 'string' && text.trim() !== '' && Number.isFinite(number) ? number : null;
};

// Import GTop conditionally
let GTop = null;
try {
    GTop = await import('gi://GTop');
} catch (e) {
    // GTop is not available, it is already null
}

// Number of usage samples in a sparkline, one per second.
const HISTORY_LENGTH = 30;

// Line chart of the latest usage percentages, drawn in the colour of the stylesheet (the accent colour).
class Sparkline {
    constructor() {
        this._values = [];
        this.actor = new St.DrawingArea({
            style_class: 'gamebar-sparkline',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.connect('repaint', () => this._draw());
    }

    push(value) {
        const percent = parseFloat(value);
        if (!Number.isFinite(percent)) {
            return;
        }

        this._values.push(Math.max(0, Math.min(percent, 100)));
        if (this._values.length > HISTORY_LENGTH) {
            this._values.shift();
        }
        this.actor.queue_repaint();
    }

    clear() {
        this._values = [];
        this.actor.queue_repaint();
    }

    _draw() {
        const cr = this.actor.get_context();
        const [width, height] = this.actor.get_surface_size();
        const lineWidth = 2 * St.ThemeContext.get_for_stage(global.stage).scale_factor;

        if (this._values.length > 1) {
            const color = this.actor.get_theme_node().get_foreground_color();
            cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
            cr.setLineWidth(lineWidth);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.setLineCap(Cairo.LineCap.ROUND);

            // The newest value is at the right edge, the line grows in from there.
            const step = (width - lineWidth) / (HISTORY_LENGTH - 1);
            const offset = HISTORY_LENGTH - this._values.length;
            this._values.forEach((value, index) => {
                const x = lineWidth / 2 + (offset + index) * step;
                const y = lineWidth / 2 + (height - lineWidth) * (1 - value / 100);
                if (index === 0) {
                    cr.moveTo(x, y);
                } else {
                    cr.lineTo(x, y);
                }
            });
            cr.stroke();
        }

        cr.$dispose();
    }
}

// Formats a value of a size: one decimal below 100, none above.
const formatNumber = (value) => value < 100 ? value.toFixed(1) : Math.round(value).toString();

// "18.4 of 31.2 GiB", both in the unit of the total. Memory uses binary units and disks decimal ones, like GNOME Settings.
const formatUsage = (used, total, binary) => {
    const base = binary ? 1024 : 1000;
    const units = binary ? ['B', 'KiB', 'MiB', 'GiB', 'TiB'] : ['B', 'kB', 'MB', 'GB', 'TB'];
    const exponent = Math.max(0, Math.min(Math.floor(Math.log(total) / Math.log(base)), units.length - 1));
    const scale = base ** exponent;
    return _('%s of %s').format(formatNumber(used / scale), `${formatNumber(total / scale)} ${units[exponent]}`);
};

// "12.4 MB/s"
const formatRate = (bytesPerSecond) => {
    const units = ['B/s', 'kB/s', 'MB/s', 'GB/s'];
    const exponent = bytesPerSecond < 1 ? 0 : Math.min(Math.floor(Math.log(bytesPerSecond) / Math.log(1000)), units.length - 1);
    const value = bytesPerSecond / 1000 ** exponent;
    return `${exponent === 0 ? Math.round(value) : formatNumber(value)} ${units[exponent]}`;
};

export class SystemMonitor {
    constructor(overlay, monitor) {
        this._overlay = overlay;
        this._monitor = monitor;
        
        this._cpuRow = null;
        this._cpuHwmonPath = null;

        this._gpuRow = null;
        this._gpuMonitoring = null;
        this._gpuDevice = null;

        this._cpuMonitoring = true;
        this._memoryMonitoring = true;
        this._diskMonitoring = true;
        this._networkMonitoring = true;

        this._memoryRow = null;
        this._diskRow = null;
        this._networkRow = null;
        this._prevNetwork = null;
        
        this._timeoutId = null;
        this._addonContainer = null;
        this._visibilityChangedId = null;
        this._prevCpu = null;
        this._gtopAvailable = GTop !== null;
        this._tempUnit = 'C'; // Default to Celsius
    }

    _createMonitorWidget() {
        if (this._gtopAvailable) {
            this._prevCpu = new GTop.default.glibtop_cpu();
        }
        this._cpuHwmonPath = findCpuHwmon();
        this._cancellable = new Gio.Cancellable();
        this._nvidiaProcess = null;
        this._nvidiaMissing = false;
        this._findGpu();

        // Without any row there is no card. A hidden card would not finish the exit animation the overlay waits for.
        if (!this._cpuMonitoring && !this._gpuMonitoring && !this._memoryMonitoring && !this._diskMonitoring && !this._networkMonitoring) {
            return;
        }

        this._addonContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout()
        });

        const { card, body } = createCard(_('Hardware'), 'gamebar-hardware-card', () => setCardHidden('system-monitor', true));
        const list = new BoxedList();
        body.add_child(list.actor);

        // Without GTop there is no usage to chart, the row only explains what is missing.
        if (this._cpuMonitoring) {
            this._cpuRow = this._createStatRow(_('CPU'), this._gtopAvailable ? 'sparkline' : null);
            list.addRow(this._cpuRow.actor);
        }

        // Add the GPU row if GPU monitoring is enabled.
        if (this._gpuMonitoring) {
            this._gpuRow = this._createStatRow(_('GPU'), 'sparkline');
            list.addRow(this._gpuRow.actor);
        }

        if (this._memoryMonitoring) {
            this._memoryRow = this._createStatRow(_('Memory'), 'level');
            list.addRow(this._memoryRow.actor);
        }

        if (this._diskMonitoring) {
            this._diskRow = this._createStatRow(_('Disk'), 'level');
            list.addRow(this._diskRow.actor);
        }

        if (this._networkMonitoring) {
            this._networkRow = this._createNetworkRow();
            list.addRow(this._networkRow.actor);
        }

        // Add the card to the addon container
        this._addonContainer.add_child(card);

        // Add the addon container to the overlay
        this._overlay.add_child(this._addonContainer);
        makeDraggable(this._addonContainer, 'system-monitor');

followCardSize(this._addonContainer, () => this.set_addon_position());

        // Connect to overlay visibility changes
        this._visibilityChangedId = this._overlay.connect('notify::visible', () => {
            if (this._overlay.visible) {
                this._startMonitor();
            } else {
                this._stopMonitor();
            }
        });

        // Initial update if overlay is visible
        if (this._overlay.visible) {
            this._startMonitor();
        }
    }

  // Row with the name and details, a sparkline or level bar of the usage and the current usage.
  // Without a graph the row only shows the name and details.
  _createStatRow(name, graph) {
    const showUsage = graph !== null;
    const row = createRow('gamebar-stat-row');

    const info = new St.BoxLayout({
      ...vertical(),
      style_class: showUsage ? 'gamebar-stat-info' : '',
      x_expand: !showUsage,
      y_align: Clutter.ActorAlign.CENTER,
    });
    info.add_child(createLabel(name));

    const subtitle = createLabel('', 'gamebar-subtitle gamebar-numeric');
    info.add_child(subtitle);
    row.add_child(info);

    if (!showUsage) {
      // Long hints wrap instead of being cut off.
      subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
      subtitle.clutter_text.line_wrap = true;
      return { actor: row, subtitle, sparkline: null, level: null, usage: null };
    }

    const sparkline = graph === 'sparkline' ? new Sparkline() : null;
    const level = graph === 'level' ? new LevelBar() : null;
    row.add_child((sparkline ?? level).actor);

    const usage = createLabel('', 'gamebar-stat-usage gamebar-numeric');
    row.add_child(usage);

    return { actor: row, subtitle, sparkline, level, usage };
  }

  // Row with the download and upload rate.
  _createNetworkRow() {
    const row = createRow('gamebar-stat-row');
    row.add_child(createLabel(_('Network'), '', { x_expand: true }));

    const addRate = (iconName) => {
      const box = new St.BoxLayout({
        style_class: 'gamebar-network-rate',
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
      });
      box.add_child(new St.Icon({ icon_name: iconName, icon_size: 16 }));
      const label = createLabel('-', 'gamebar-numeric');
      box.add_child(label);
      // A fixed width keeps the arrows in place while the rates change.
      row.add_child(new St.Bin({ style_class: 'gamebar-network-rate-bin', child: box }));
      return label;
    };

    return { actor: row, download: addRate('go-down-symbolic'), upload: addRate('go-up-symbolic') };
  }

  _startMonitor() {
    // A sparkline with a gap from the time the overlay was closed would be misleading.
    this._cpuRow?.sparkline?.clear();
    this._gpuRow?.sparkline?.clear();
    this._prevNetwork = null;

    // An exception in the timer would end it, and the card would stand still.
    const update = () => {
      try {
        this._updateMonitor();
      } catch (e) {
        console.warn(`GameBar: ${e.message}`);
      }
    };
    update();

    // Start the timer only if it's not already running
    if (!this._timeoutId) {
      this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        update();
        return GLib.SOURCE_CONTINUE;
      });
    }
  }

  _stopMonitor() {
    // Remove the timeout if it exists
    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = null;
    }
  }

  set_addon_position() {
    positionAddon(this._monitor, this._addonContainer, 'system-monitor');
  }

  _getCpuUsage() {
    if (!this._gtopAvailable){
      return '-';
    }

    const cpu = new GTop.default.glibtop_cpu();
    GTop.default.glibtop_get_cpu(cpu);

    const total = cpu.total - this._prevCpu.total;
    const user = cpu.user - this._prevCpu.user;
    const sys = cpu.sys - this._prevCpu.sys;
    const nice = cpu.nice - this._prevCpu.nice;

    this._prevCpu = cpu;

    return Math.round((user + sys + nice) / Math.max(total, 1.0) * 100);
  }

  // Millidegrees Celsius as "45 °C" or "113 °F", null without a reading.
  _formatTemperature(millidegrees) {
    if (millidegrees === null) return null;
    const celsius = Math.round(millidegrees / 1000);
    return this._tempUnit === 'C' ? `${celsius} °C` : `${Math.round(celsiusToFahrenheit(celsius))} °F`;
  }

  // The GPU to read, the selected one or the first one if it does not exist, with its driver and temperature sensor.
  _findGpu() {
    const gpus = listGpus().map(([id]) => id);
    if (!gpus.includes(this._gpuDevice)) {
      this._gpuDevice = gpus[0] ?? null;
    }
    this._gpuDriver = this._gpuDevice ? getGpuDriver(this._gpuDevice) : null;
    // Integrated Intel GPUs have no sensor.
    this._gpuHwmonPath = this._gpuDevice ? findFirstHwmon(this._gpuDevice) : null;
    this._nvidia = NO_GPU_READING;
  }

  // Usage in percent, temperature in millidegrees Celsius and VRAM in use in bytes, null for what the driver does not tell.
  _readGpu() {
    if (!this._gpuDevice) return NO_GPU_READING;

    if (this._gpuDriver === 'nvidia') {
      this._queryNvidia();
      return this._nvidia;
    }

    // Only amdgpu has the usage and the VRAM in sysfs, Intel and nouveau have neither.
    const device = '/sys/class/drm/' + this._gpuDevice + '/device';
    const amd = this._gpuDriver === 'amdgpu';
    return {
      usage: amd ? toNumber(readFile(device + '/gpu_busy_percent')) : null,
      temperature: this._gpuHwmonPath ? toNumber(readFile(this._gpuHwmonPath + '/temp1_input')) : null,
      vram: amd ? toNumber(readFile(device + '/mem_info_vram_used')) : null,
    };
  }

  // nvidia-smi takes too long to wait for it in the shell. It runs on its own, the row shows what its last run said.
  _queryNvidia() {
    if (this._nvidiaProcess || this._nvidiaMissing) return;

    let process;
    try {
      process = Gio.Subprocess.new(
        ['nvidia-smi', '--query-gpu=utilization.gpu,temperature.gpu,memory.used', '--format=csv,noheader,nounits'],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
      this._nvidiaMissing = true;
      return;
    }

    this._nvidiaProcess = process;
    process.communicate_utf8_async(null, this._cancellable, (source, result) => {
      if (this._nvidiaProcess === process) this._nvidiaProcess = null;
      try {
        const [, stdout] = source.communicate_utf8_finish(result);
        // One line per GPU, the first one. The memory is in MiB.
        const [usage, temperature, memory] = (stdout ?? '').split('\n')[0].split(',').map(toNumber);
        this._nvidia = {
          usage: usage ?? null,
          temperature: typeof temperature === 'number' ? temperature * 1000 : null,
          vram: typeof memory === 'number' ? memory * 1024 ** 2 : null,
        };
      } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) console.warn(`GameBar: ${e.message}`);
      }
    });
  }

    // Used memory like GNOME System Monitor: everything that is not available.
    _getMemory() {
      const meminfo = readFile('/proc/meminfo');
      if (meminfo === null) return null;

      const readKey = key => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1]) * 1024;
      const total = readKey('MemTotal');
      const available = readKey('MemAvailable');
      if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0) return null;
      return { used: total - available, total };
    }

    // Usage of the filesystem of the home folder. On image based systems the root filesystem is a small read-only image.
    _getDisk() {
      try {
        const info = Gio.File.new_for_path(GLib.get_home_dir()).query_filesystem_info('filesystem::size,filesystem::used,filesystem::free', null);
        const total = info.get_attribute_uint64('filesystem::size');
        const used = info.has_attribute('filesystem::used')
          ? info.get_attribute_uint64('filesystem::used')
          : total - info.get_attribute_uint64('filesystem::free');
        return total > 0 ? { used, total } : null;
      } catch (e) {
        return null;
      }
    }

    // Received and sent bytes per physical interface.
    // Virtual interfaces (loopback, VPNs, containers) have no device and would count traffic twice.
    _readNetworkBytes() {
      const netdev = readFile('/proc/net/dev');
      if (netdev === null) return null;

      const totals = new Map();
      for (const line of netdev.split('\n').slice(2)) {
        const [name, data] = line.split(':');
        const iface = name?.trim();
        if (!data || !GLib.file_test('/sys/class/net/' + iface + '/device', GLib.FileTest.EXISTS)) continue;

        const fields = data.trim().split(/\s+/);
        totals.set(iface, [Number(fields[0]), Number(fields[8])]);
      }
      return totals;
    }

    // Download and upload rate since the last call, null on the first call.
    _getNetworkRates() {
      const time = GLib.get_monotonic_time();
      const totals = this._readNetworkBytes();
      const prev = this._prevNetwork;
      this._prevNetwork = totals ? { time, totals } : null;
      if (!totals || !prev) return null;

      const seconds = (time - prev.time) / GLib.USEC_PER_SEC;
      let download = 0;
      let upload = 0;
      for (const [iface, [received, sent]] of totals) {
        const before = prev.totals.get(iface);
        // An interface that just appeared or was reset has no rate yet.
        if (!before) continue;
        download += Math.max(received - before[0], 0);
        upload += Math.max(sent - before[1], 0);
      }
      return { download: download / seconds, upload: upload / seconds };
    }

  _updateMonitor() {
    // Only update if the overlay is visible
    if (!this._overlay.visible) {
      return false;
    }

    if (this._cpuRow && !this._gtopAvailable) {
      this._cpuRow.subtitle.set_text(_("Install 'libgtop' for the CPU usage"));
    } else if (this._cpuRow) {
      const cpuUsage = this._getCpuUsage();
      this._cpuRow.usage.set_text(cpuUsage + "%");
      this._cpuRow.sparkline.push(cpuUsage);

      if (this._cpuHwmonPath) {
        this._cpuRow.subtitle.set_text(this._formatTemperature(toNumber(readFile(this._cpuHwmonPath))) ?? _("N/A"));
      } else {
        this._cpuRow.subtitle.set_text(_("Temperature sensor not found"));
      }
    }

    if (this._gpuRow) {
      const gpu = this._readGpu();
      this._gpuRow.usage.set_text(gpu.usage === null ? "-" : Math.round(gpu.usage) + "%");
      if (gpu.usage !== null) {
        this._gpuRow.sparkline.push(gpu.usage);
      }

      const details = [this._formatTemperature(gpu.temperature) ?? _("N/A")];
      if (gpu.vram !== null) {
        details.push(`${(gpu.vram / 1024 ** 3).toFixed(1)} GiB`);
      }
      this._gpuRow.subtitle.set_text(details.join(' · '));
    }

    for (const [row, getUsage, binary] of [[this._memoryRow, () => this._getMemory(), true], [this._diskRow, () => this._getDisk(), false]]) {
      const usage = row ? getUsage() : null;
      if (usage) {
        row.subtitle.set_text(formatUsage(usage.used, usage.total, binary));
        row.level.value = usage.used / usage.total;
        row.usage.set_text(Math.round(usage.used / usage.total * 100) + "%");
      }
    }

    const rates = this._networkRow ? this._getNetworkRates() : null;
    if (rates) {
      this._networkRow.download.set_text(formatRate(rates.download));
      this._networkRow.upload.set_text(formatRate(rates.upload));
    }

    return true;
  }

  _updateSettings(settings) {
    this._tempUnit = settings.get_string('cpu-temperature-unit'); // Get unit from settings
    this._gpuDevice = settings.get_string('gpu-device');
    this._gpuMonitoring = settings.get_boolean('gpu-monitoring');
    this._cpuMonitoring = settings.get_boolean('cpu-monitoring');
    this._memoryMonitoring = settings.get_boolean('memory-monitoring');
    this._diskMonitoring = settings.get_boolean('disk-monitoring');
    this._networkMonitoring = settings.get_boolean('network-monitoring');

    // Recreate the widget with new settings
    this._stopMonitor();
    this.destroy();
    this._createMonitorWidget();
  }

  
  destroy() {
    // Stop the monitor
    this._stopMonitor();
    this._cancellable?.cancel();
    this._nvidiaProcess?.force_exit();
    this._nvidiaProcess = null;

    // Disconnect signals
    if (this._visibilityChangedId > 0) {
      this._overlay.disconnect(this._visibilityChangedId);
      this._visibilityChangedId = null;
    }

    // Destroy the addon container and remove it from the overlay.
    if (this._addonContainer) {
      this._addonContainer.destroy();
      this._addonContainer = null;
    }

    // Cleanup properties
    this._cpuRow = null;
    this._gpuRow = null;
    this._memoryRow = null;
    this._diskRow = null;
    this._networkRow = null;
    this._prevNetwork = null;
    this._prevCpu = null;
    this._cpuHwmonPath = null;
  }
}

