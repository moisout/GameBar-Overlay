import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { positionAddon, makeDraggable, setCardHidden } from '../cardPosition.js';
import { createCard, BoxedList, createRow, createLabel, LevelBar } from '../card.js';
import { readFile, getGpuDriver, listGpus, findCpuHwmon, findFirstHwmon, celsiusToFahrenheit } from '../utils.js';

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
    constructor(overlay, primaryMonitor) {
        this._overlay = overlay;
        this._primaryMonitor = primaryMonitor;
        this._widthChangeId = null;
        this._heightChangeId = null;
        
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

        //Add the listeners for change width and height:
        this._widthChangeId = this._addonContainer.connect('notify::width', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this.set_addon_position();
                return GLib.SOURCE_REMOVE;
            });
        });

        this._heightChangeId = this._addonContainer.connect('notify::height', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this.set_addon_position();
                return GLib.SOURCE_REMOVE;
            });
        });

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
      vertical: true,
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

    // Initial update
    this._updateMonitor();

    // Start the timer only if it's not already running
    if (!this._timeoutId) {
      this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        this._updateMonitor();
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
    positionAddon(this._primaryMonitor, this._addonContainer, 'system-monitor');
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

  _getCpuTemperature() {
    if (!this._cpuHwmonPath) {
      return { temp: _("N/A"), unit: "" };
    }

    const temperature = readFile(this._cpuHwmonPath);
    if (temperature === null) {
      return { temp: _("Error"), unit: "" };
    }

    let celsius = Math.round(parseInt(temperature) / 1000);
    let tempValue;
    let unitSymbol;

    if (this._tempUnit === 'C') {
      tempValue = celsius;
      unitSymbol = "°C";
    } else { // Fahrenheit
      tempValue = Math.round(celsiusToFahrenheit(celsius));
      unitSymbol = "°F";
    }
    return { temp: tempValue, unit: unitSymbol};
    }

    _getGpuUsage() {
      this._checkValidGpuDevice();
      if (!this._gpuDevice) return "-";
      const driver = getGpuDriver(this._gpuDevice);
      if (driver == "amdgpu" || driver == "i915" || driver == "xe") {
        const usagePath = "/sys/class/drm/" + this._gpuDevice + "/device/gpu_busy_percent"
        const usage = readFile(usagePath);
        return usage;
      }else if(driver == "nouveau"){
        const usagePath = "/sys/class/drm/" + this._gpuDevice + "/device/power/runtime_usage"
        const usage = readFile(usagePath);
        return usage;
      }else if(driver == "nvidia"){
        const output = GLib.spawn_command_line_sync("nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits")[1];
        const usage = output.toString().trim();
        return usage;
      }
      return "-"
    }

    _getGpuTemperature() {
      this._checkValidGpuDevice();
      if (!this._gpuDevice) return { temp: _("N/A"), unit: "" };
      const driver = getGpuDriver(this._gpuDevice);
      let temperature;

      if (driver == "amdgpu" || driver == "i915" || driver == "xe" || driver == "nouveau") {
        const path = findFirstHwmon(this._gpuDevice) + "/temp1_input";
        temperature = readFile(path);
      }else if(driver == "nvidia"){
        const output = GLib.spawn_command_line_sync("nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits")[1];
        temperature = output.toString().trim() * 1000;
      }

      const celsius = Math.round(parseInt(temperature) / 1000);
      let tempValue;
      let unitSymbol;
  
      if (this._tempUnit === 'C') {
          tempValue = celsius;
          unitSymbol = "°C";
      } else { // Fahrenheit
          tempValue = Math.round(celsiusToFahrenheit(celsius));
          unitSymbol = "°F";
      }
      return { temp: tempValue, unit: unitSymbol};
    }

    // VRAM in use, only amdgpu reports it in sysfs.
    _getGpuVram() {
      if (!this._gpuDevice || getGpuDriver(this._gpuDevice) !== 'amdgpu') return null;
      const used = readFile('/sys/class/drm/' + this._gpuDevice + '/device/mem_info_vram_used');
      return used === null ? null : Number(used);
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

    // Usage of the root filesystem.
    _getDisk() {
      try {
        const info = Gio.File.new_for_path('/').query_filesystem_info('filesystem::size,filesystem::used,filesystem::free', null);
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

    // Fallback to the first available GPU if the selected one does not exist
    _checkValidGpuDevice() {
        const gpus = listGpus().flat();

        if (gpus.length === 0) {
            this._gpuDevice = null;
            return;
        }

        if (!gpus.includes(this._gpuDevice)) {
            this._gpuDevice = gpus[0];
        }
    }

  _updateMonitor() {
    // Only update if the overlay is visible
    if (!this._overlay.visible) {
      return false;
    }

    const formatTemperature = (temp) => `${temp.temp} ${temp.unit}`.trim();

    if (this._cpuRow && !this._gtopAvailable) {
      this._cpuRow.subtitle.set_text(_("GTop missing, install 'libgtop' for temperature"));
    } else if (this._cpuRow) {
      const cpuUsage = this._getCpuUsage();
      this._cpuRow.usage.set_text(cpuUsage + "%");
      this._cpuRow.sparkline.push(cpuUsage);

      if (this._cpuHwmonPath) {
        this._cpuRow.subtitle.set_text(formatTemperature(this._getCpuTemperature()));
      } else {
        this._cpuRow.subtitle.set_text(_("Temperature sensor not found"));
      }
    }

    if (this._gpuMonitoring) {
        const gpuUsage = this._getGpuUsage();
        this._gpuRow.usage.set_text(gpuUsage + (gpuUsage !== "-" ? "%" : ""));
        this._gpuRow.sparkline.push(gpuUsage);
        let gpuDetails = formatTemperature(this._getGpuTemperature());
        const vram = this._getGpuVram();
        if (vram !== null) {
          gpuDetails += ` · ${(vram / 1024 ** 3).toFixed(1)} GiB`;
        }
        this._gpuRow.subtitle.set_text(gpuDetails);
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

    // Disconnect signals
    if (this._heightChangeId > 0) {
      this._addonContainer.disconnect(this._heightChangeId);
      this._heightChangeId = null;
    }

    if (this._widthChangeId > 0) {
      this._addonContainer.disconnect(this._widthChangeId);
      this._widthChangeId = null;
    }

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

