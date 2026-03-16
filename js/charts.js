/* ═══════════════════════════════════════════════════════════════════
   IAM Platform — Charts & Visualization Helpers
   ═══════════════════════════════════════════════════════════════════ */

/* Simple SVG chart renderer — no external dependencies */

const Charts = {
  /* ─── Line / Area Chart ──────────────────────────────────────── */
  renderArea(containerId, data, color = '#6c63ff', opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const w = container.clientWidth || 400;
    const h = opts.height || 80;
    const max = Math.max(...data, 1);
    const pad = { t: 6, b: 6, l: 0, r: 0 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;

    const pts = data.map((v, i) => {
      const x = pad.l + (i / Math.max(data.length - 1, 1)) * iw;
      const y = pad.t + ih - (v / max) * ih;
      return `${x},${y}`;
    }).join(' ');

    const first = `${pad.l},${pad.t + ih}`;
    const last = `${pad.l + iw},${pad.t + ih}`;
    const fillPts = `${first} ${pts} ${last}`;
    const gid = `g${containerId}${color.replace('#','')}`;

    container.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px;overflow:visible;">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <polygon points="${fillPts}" fill="url(#${gid})"/>
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
        ${opts.dots ? data.map((v, i) => {
          const x = pad.l + (i / Math.max(data.length - 1, 1)) * iw;
          const y = pad.t + ih - (v / max) * ih;
          return `<circle cx="${x}" cy="${y}" r="3" fill="${color}" stroke="var(--bg-base)" stroke-width="2"/>`;
        }).join('') : ''}
      </svg>
    `;
  },

  /* ─── Bar Chart ──────────────────────────────────────────────── */
  renderBars(containerId, data, color = '#6c63ff', opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const w = container.clientWidth || 400;
    const h = opts.height || 120;
    const max = Math.max(...data.map(d => d.value || d), 1);
    const labels = data.map(d => d.label || '');
    const values = data.map(d => d.value !== undefined ? d.value : d);
    const barW = Math.max(4, (w / values.length) - 4);
    const gap = (w - barW * values.length) / (values.length + 1);
    const padB = opts.showLabels ? 20 : 4;

    const bars = values.map((v, i) => {
      const x = gap + i * (barW + gap);
      const barH = ((v / max) * (h - padB - 6));
      const y = h - padB - barH;
      const c = opts.colors ? opts.colors[i] || color : color;
      return `
        <rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="${c}" opacity="0.85"/>
        ${opts.showLabels && labels[i] ? `<text x="${x + barW/2}" y="${h - 4}" text-anchor="middle" font-size="9" fill="var(--text-muted)">${labels[i]}</text>` : ''}
      `;
    }).join('');

    container.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px;">
        ${bars}
      </svg>
    `;
  },

  /* ─── Donut Chart ────────────────────────────────────────────── */
  renderDonut(containerId, segments, opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const size = opts.size || 120;
    const cx = size / 2, cy = size / 2;
    const outerR = size * 0.42;
    const innerR = size * 0.28;
    const total = segments.reduce((s, seg) => s + seg.value, 0);

    let startAngle = -Math.PI / 2;
    const paths = segments.map(seg => {
      const angle = (seg.value / total) * 2 * Math.PI;
      const endAngle = startAngle + angle;
      const x1 = cx + outerR * Math.cos(startAngle);
      const y1 = cy + outerR * Math.sin(startAngle);
      const x2 = cx + outerR * Math.cos(endAngle);
      const y2 = cy + outerR * Math.sin(endAngle);
      const ix1 = cx + innerR * Math.cos(endAngle);
      const iy1 = cy + innerR * Math.sin(endAngle);
      const ix2 = cx + innerR * Math.cos(startAngle);
      const iy2 = cy + innerR * Math.sin(startAngle);
      const large = angle > Math.PI ? 1 : 0;
      const d = `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${large} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerR} ${innerR} 0 ${large} 0 ${ix2} ${iy2} Z`;
      startAngle = endAngle;
      return `<path d="${d}" fill="${seg.color}" opacity="0.9"/>`;
    }).join('');

    const centerLabel = opts.centerLabel || '';
    container.innerHTML = `
      <svg viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px;">
        ${paths}
        ${centerLabel ? `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14" font-weight="700" fill="var(--text-primary)">${centerLabel}</text>` : ''}
      </svg>
    `;
  },

  /* ─── Mini Sparkline (inline) ────────────────────────────────── */
  renderSparkline(containerId, data, color = '#6c63ff') {
    this.renderArea(containerId, data, color, { height: 40 });
  },

  /* ─── Render all charts marked with data-chart attribute ──────── */
  autoRender() {
    $$('[data-chart]').forEach(el => {
      const type = el.dataset.chart;
      const color = el.dataset.color || '#6c63ff';
      const raw = el.dataset.values;
      if (!raw) return;
      let values;
      try { values = JSON.parse(raw); } catch { return; }
      switch (type) {
        case 'area': Charts.renderArea(el.id, values, color); break;
        case 'bars': Charts.renderBars(el.id, values, color); break;
        case 'sparkline': Charts.renderSparkline(el.id, values, color); break;
      }
    });
  },
};

// Sample analytics data sets - zeroed out for clean start
const SampleData = {
  dailyMessages: [],
  dailySessions: [],
  weeklyUsers: [],
  hourlyDist: [],
  botMsgDist: [],
};

// Called after analytics page renders
function initAnalyticsCharts() {
  Charts.renderArea('chart-messages', SampleData.dailyMessages, '#6c63ff', { height: 100, dots: false });
  Charts.renderArea('chart-sessions', SampleData.dailySessions, '#00e5a0', { height: 100 });
  Charts.renderBars('chart-hourly', SampleData.hourlyDist, '#6c63ff', { height: 80 });
  Charts.renderDonut('chart-bot-dist', SampleData.botMsgDist, { size: 100, centerLabel: '0' });
  Charts.renderArea('chart-users', SampleData.weeklyUsers, '#38bdf8', { height: 80, dots: true });
}
window.initAnalyticsCharts = initAnalyticsCharts;
