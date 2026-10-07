import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { positionAddon, followCardSize, makeDraggable } from '../cardPosition.js';
import { vertical, createCard, BoxedList, createRow, createLabel, LevelBar } from '../card.js';
import { readFile, findCpuHwmon, celsiusToFahrenheit } from '../utils.js';
import { HISTORY_LENGTH, toNumber } from './hardwareSampler.js';

// Line chart of the latest usage percentages, drawn in the colour of the stylesheet (the accent colour).
// The values are the history of the sampler, which is shared by the card in the overlay and its pinned card.
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

    setValues(values) {
        this._values = values;
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
    constructor(overlay, monitor, sampler, { pinKey = null } = {}) {
        this._overlay = overlay;
        // The CPU and GPU usage, sampled while the overlay is closed too.
        this._sampler = sampler;
        // The monitor of a pinned card, which has no header bar and stays while the overlay is closed.
        this._pinKey = pinKey;
        this._monitor = monitor;
        
        this._cpuRow = null;
        this._cpuHwmonPath = null;

        this._gpuRow = null;
        this._gpuMonitoring = null;

        this._cpuMonitoring = true;
        this._memoryMonitoring = true;
        this._diskMonitoring = true;
        this._networkMonitoring = true;

        this._memoryRow = null;
        this._diskRow = null;
        this._networkRow = null;
        this._prevNetwork = null;
        
        this._watchId = 0;
        this._addonContainer = null;
        this._visibilityChangedId = null;
        this._tempUnit = 'C'; // Default to Celsius
    }

    _createMonitorWidget() {
        this._cpuHwmonPath = findCpuHwmon();

        // Without any row there is no card. A hidden card would not finish the exit animation the overlay waits for.
        if (!this._cpuMonitoring && !this._gpuMonitoring && !this._memoryMonitoring && !this._diskMonitoring && !this._networkMonitoring) {
            return;
        }

        this._addonContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout()
        });

        const { card, body } = createCard(this._pinKey ? null : _('Hardware'), 'gamebar-hardware-card', 'system-monitor');
        const list = new BoxedList();
        body.add_child(list.actor);

        // Without GTop there is no usage to chart, the row only explains what is missing.
        if (this._cpuMonitoring) {
            this._cpuRow = this._createStatRow(_('CPU'), this._sampler.cpuAvailable ? 'sparkline' : null);
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
        if (!this._pinKey) makeDraggable(this._addonContainer, 'system-monitor');

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

  // The sampler calls back every second while the card is shown.
  _startMonitor() {
    this._prevNetwork = null;

    // An exception in the update would end the timer of the sampler, and every card would stand still.
    const update = () => {
      try {
        this._updateMonitor();
      } catch (e) {
        console.warn(`GameBar: ${e.message}`);
      }
    };
    if (!this._watchId) this._watchId = this._sampler.watch(update);
    update();
  }

  // The card of the overlay and its pinned card are one card while the overlay opens and closes, the one that
  // just started shows what the other one showed until the next sample. Their sparklines are the same already.
  continueFrom(other) {
    for (const name of ['_cpuRow', '_gpuRow', '_memoryRow', '_diskRow', '_networkRow']) {
      const [row, from] = [this[name], other[name]];
      if (!row || !from) continue;
      for (const label of ['subtitle', 'usage', 'download', 'upload']) {
        if (row[label] && from[label]) row[label].text = from[label].text;
      }
    }
  }

  _stopMonitor() {
    if (this._watchId) {
      this._sampler.unwatch(this._watchId);
      this._watchId = 0;
    }
  }

  set_addon_position() {
    positionAddon(this._monitor, this._addonContainer, 'system-monitor', this._pinKey);
  }

  // Millidegrees Celsius as "45 °C" or "113 °F", null without a reading.
  _formatTemperature(millidegrees) {
    if (millidegrees === null) return null;
    const celsius = Math.round(millidegrees / 1000);
    return this._tempUnit === 'C' ? `${celsius} °C` : `${Math.round(celsiusToFahrenheit(celsius))} °F`;
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

    if (this._cpuRow && !this._sampler.cpuAvailable) {
      this._cpuRow.subtitle.set_text(_("Install 'libgtop' for the CPU usage"));
    } else if (this._cpuRow) {
      const cpuUsage = this._sampler.cpuUsage;
      this._cpuRow.usage.set_text(cpuUsage === null ? "-" : cpuUsage + "%");
      this._cpuRow.sparkline.setValues(this._sampler.cpuHistory);

      if (this._cpuHwmonPath) {
        this._cpuRow.subtitle.set_text(this._formatTemperature(toNumber(readFile(this._cpuHwmonPath))) ?? _("N/A"));
      } else {
        this._cpuRow.subtitle.set_text(_("Temperature sensor not found"));
      }
    }

    if (this._gpuRow) {
      const gpu = this._sampler.gpu;
      this._gpuRow.usage.set_text(gpu.usage === null ? "-" : Math.round(gpu.usage) + "%");
      this._gpuRow.sparkline.setValues(this._sampler.gpuHistory);

      const details = [this._formatTemperature(gpu.temperature) ?? _("N/A")];
      if (gpu.vram !== null) {
        details.push(`${(gpu.vram / 1024 ** 3).toFixed(1)} GiB`);
      }
      this._gpuRow.subtitle.set_text(details.join(' · '));
    }

    for (const { row, getUsage, binary } of [
      { row: this._memoryRow, getUsage: () => this._getMemory(), binary: true },
      { row: this._diskRow, getUsage: () => this._getDisk(), binary: false },
    ]) {
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
    this._cpuHwmonPath = null;
  }
}

